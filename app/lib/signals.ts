// Server-only: one record per assistant reply with the signals Claude already returns (mood,
// categories, handoff, context used), the search results, cost and timing, and the outcome the
// customer reported ("Did this fix it?"). Stored in Upstash Redis for 30 days; the owner reads
// them at GET /api/feedback.
import { getRedis } from "@/app/lib/access";
import type { FeedbackReason, OutcomeResult, StuckReason } from "@/app/lib/feedback-reasons";

export interface ReplyOutcome {
  result: OutcomeResult;
  reason: StuckReason | null; // only when result is "stuck"
  steps_done: number; // numbered steps the customer ticked off in the answer
  steps_total: number;
  escalated: boolean; // the customer then asked for a person
  at: string;
}

export interface ReplySignal {
  id: string;
  created_at: string;
  requested_by: "visitor" | "owner";
  model: string;
  turn: number;
  question: string;
  response: string;
  user_mood: string;
  matched_categories: string[];
  handed_off: boolean;
  handoff_reason: string;
  context_used: boolean;
  refused: boolean;
  rag_working: boolean;
  sources: { file: string; score: number }[];
  search_seconds: number;
  total_seconds: number;
  input_tokens: number;
  output_tokens: number;
  outcome?: ReplyOutcome;
  // Legacy: thumbs up/down, recorded before "Did this fix it?" replaced them
  feedback?: { rating: "up" | "down"; reason: FeedbackReason | null; at: string };
}

// The customer's negative signal on a reply, whichever version of the UI recorded it
export const isNegative = (r: ReplySignal) =>
  r.outcome ? r.outcome.result !== "resolved" : r.feedback?.rating === "down";
export const negativeReason = (r: ReplySignal): string | null =>
  r.outcome ? (r.outcome.result === "unneeded_handoff" ? "unneeded_handoff" : r.outcome.reason) : (r.feedback?.reason ?? null);

const signalKey = (id: string) => `csa:signal:${id}`;
const INDEX_KEY = "csa:signals";
const RETENTION_SECONDS = 60 * 60 * 24 * 30;
const MAX_INDEXED = 1000;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function saveSignal(signal: ReplySignal): Promise<void> {
  const store = getRedis();
  if (!store) return;
  await store.set(signalKey(signal.id), JSON.stringify(signal), { ex: RETENTION_SECONDS });
  await store.lpush(INDEX_KEY, signal.id);
  await store.ltrim(INDEX_KEY, 0, MAX_INDEXED - 1);
}

type FeedbackResult = "saved" | "not_found" | "no_store";

// Only replies that were logged can get an outcome, and a later report replaces an earlier one.
export async function saveOutcome(id: string, outcome: Omit<ReplyOutcome, "at">): Promise<FeedbackResult> {
  const store = getRedis();
  if (!store) return "no_store";
  const signal = await store.get<ReplySignal>(signalKey(id));
  if (!signal) return "not_found";
  signal.outcome = {
    ...outcome,
    reason: outcome.result === "stuck" ? outcome.reason : null,
    at: new Date().toISOString(),
  };
  await store.set(signalKey(id), JSON.stringify(signal), { keepTtl: true });
  return "saved";
}

export async function listSignals(): Promise<ReplySignal[] | null> {
  const store = getRedis();
  if (!store) return null;
  const ids = await store.lrange<string>(INDEX_KEY, 0, MAX_INDEXED - 1);
  if (ids.length === 0) return [];
  const records = await store.mget<(ReplySignal | null)[]>(...ids.map(signalKey));
  return records.filter((r): r is ReplySignal => !!r);
}

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
};

function rates(rs: ReplySignal[]) {
  // "Did this fix it?" is only asked on answers, not on replies that handed off
  const answered = rs.filter((r) => !r.handed_off);
  const reported = answered.filter((r) => r.outcome && r.outcome.result !== "unneeded_handoff");
  const resolved = reported.filter((r) => r.outcome!.result === "resolved").length;
  const stuck = reported.length - resolved;
  const legacy = rs.filter((r) => !r.outcome && r.feedback);
  const legacyUp = legacy.filter((r) => r.feedback!.rating === "up").length;
  return {
    replies: rs.length,
    answered: answered.length,
    outcome_reported: reported.length,
    outcome_reported_pct: pct(reported.length, answered.length),
    resolved,
    stuck,
    resolved_pct_of_reported: pct(resolved, reported.length),
    stuck_then_escalated: reported.filter((r) => r.outcome!.escalated).length,
    handoff_pct: pct(rs.filter((r) => r.handed_off).length, rs.length),
    unneeded_handoffs: rs.filter((r) => r.outcome?.result === "unneeded_handoff").length,
    articles_not_used_pct: pct(rs.filter((r) => !r.context_used).length, rs.length),
    legacy_thumbs_up: legacyUp,
    legacy_thumbs_down: legacy.length - legacyUp,
  };
}

export function summarize(rs: ReplySignal[]) {
  const countBy = (key: (r: ReplySignal) => string[]) => {
    const groups = new Map<string, ReplySignal[]>();
    for (const r of rs) for (const k of key(r)) groups.set(k, [...(groups.get(k) ?? []), r]);
    return Object.fromEntries([...groups].sort((a, b) => b[1].length - a[1].length).map(([k, g]) => [k, rates(g)]));
  };
  const negativeReasons: Record<string, number> = {};
  for (const r of rs.filter(isNegative)) {
    const k = negativeReason(r) ?? "no_reason";
    negativeReasons[k] = (negativeReasons[k] ?? 0) + 1;
  }

  return {
    overall: {
      ...rates(rs),
      refusals: rs.filter((r) => r.refused).length,
      search_failures: rs.filter((r) => !r.rag_working).length,
      median_total_seconds: median(rs.map((r) => r.total_seconds)),
      median_input_tokens: median(rs.map((r) => r.input_tokens)),
      median_output_tokens: median(rs.map((r) => r.output_tokens)),
    },
    negative_reasons: negativeReasons,
    by_category: countBy((r) => (r.matched_categories.length ? r.matched_categories : ["none"])),
    by_mood: countBy((r) => [r.user_mood]),
    by_model: countBy((r) => [r.model]),
  };
}
