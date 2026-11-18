// Server-only: one record per assistant reply with the signals Claude already returns (mood,
// categories, handoff, context used), the search results, cost and timing, and the user's
// thumbs up/down. Stored in Upstash Redis for 30 days; the owner reads them at GET /api/feedback.
import { getRedis } from "@/app/lib/access";
import type { FeedbackReason } from "@/app/lib/feedback-reasons";

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
  feedback?: { rating: "up" | "down"; reason: FeedbackReason | null; at: string };
}

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

// Only replies that were logged can be rated, and a later vote replaces an earlier one.
export async function saveFeedback(
  id: string,
  rating: "up" | "down",
  reason: FeedbackReason | null,
): Promise<FeedbackResult> {
  const store = getRedis();
  if (!store) return "no_store";
  const signal = await store.get<ReplySignal>(signalKey(id));
  if (!signal) return "not_found";
  signal.feedback = { rating, reason: rating === "down" ? reason : null, at: new Date().toISOString() };
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
  const rated = rs.filter((r) => r.feedback);
  const up = rated.filter((r) => r.feedback!.rating === "up").length;
  return {
    replies: rs.length,
    rated: rated.length,
    rated_pct: pct(rated.length, rs.length),
    thumbs_up: up,
    thumbs_down: rated.length - up,
    thumbs_up_pct_of_rated: pct(up, rated.length),
    handoff_pct: pct(rs.filter((r) => r.handed_off).length, rs.length),
    articles_not_used_pct: pct(rs.filter((r) => !r.context_used).length, rs.length),
  };
}

export function summarize(rs: ReplySignal[]) {
  const countBy = (key: (r: ReplySignal) => string[]) => {
    const groups = new Map<string, ReplySignal[]>();
    for (const r of rs) for (const k of key(r)) groups.set(k, [...(groups.get(k) ?? []), r]);
    return Object.fromEntries([...groups].sort((a, b) => b[1].length - a[1].length).map(([k, g]) => [k, rates(g)]));
  };
  const down = rs.filter((r) => r.feedback?.rating === "down");
  const downReasons: Record<string, number> = {};
  for (const r of down) {
    const k = r.feedback!.reason ?? "no_reason";
    downReasons[k] = (downReasons[k] ?? 0) + 1;
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
    thumbs_down_reasons: downReasons,
    by_category: countBy((r) => (r.matched_categories.length ? r.matched_categories : ["none"])),
    by_mood: countBy((r) => [r.user_mood]),
    by_model: countBy((r) => [r.model]),
  };
}
