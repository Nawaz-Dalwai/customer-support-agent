// Server-only: the report behind /insights, built from reply records (sample or live).
// Uses the same summarize() as GET /api/feedback, so both show the same numbers.
import { CLAUDE_PRICE_PER_MTOK, KB_SEARCH_PRICE_USD, replyCost } from "@/app/lib/pricing";
import { isNegative, negativeReason, summarize, type ReplySignal } from "@/app/lib/signals";
import tradeoffs from "@/app/lib/escalation-tradeoffs.json";

export type InsightsSource = "sample" | "live";
const RECENT_NEGATIVE_LIMIT = 20;

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function costs(rs: ReplySignal[]) {
  const priced = rs.map((r) => ({ r, c: replyCost(r) })).filter((x) => x.c.total_usd != null);
  const totals = priced.map((x) => x.c.total_usd!);
  const byModel: Record<string, { replies: number; median_usd: number | null; total_usd: number }> = {};
  for (const model of new Set(priced.map((x) => x.r.model))) {
    const t = priced.filter((x) => x.r.model === model).map((x) => x.c.total_usd!);
    byModel[model] = {
      replies: t.length,
      median_usd: round(median(t)!, 5),
      total_usd: round(t.reduce((a, b) => a + b, 0), 4),
    };
  }
  return {
    note: "Estimate from list prices and logged token counts; ignores prompt caching and refusal fallbacks.",
    prices: { claude_per_mtok: CLAUDE_PRICE_PER_MTOK, kb_search_usd: KB_SEARCH_PRICE_USD },
    priced_replies: priced.length,
    unpriced_replies: rs.length - priced.length,
    total_usd: round(totals.reduce((a, b) => a + b, 0), 4),
    median_per_reply_usd: totals.length ? round(median(totals)!, 5) : null,
    by_model: byModel,
  };
}

export function buildInsights(all: ReplySignal[], opts: { source: InsightsSource; includeOwner: boolean }) {
  const rs = opts.includeOwner ? all : all.filter((r) => r.requested_by === "visitor");
  const times = rs.map((r) => r.created_at).sort();
  return {
    source: opts.source,
    scope: opts.includeOwner ? "visitors and owner" : "visitors only",
    generated_at: new Date().toISOString(),
    reply_count: rs.length,
    oldest: times[0] ?? null,
    newest: times.at(-1) ?? null,
    ...summarize(rs),
    cost: costs(rs),
    // What the escalation eval measured for each policy, to set beside real use
    eval_tradeoffs: tradeoffs.levels,
    // Still stuck or "didn't need a person", newest first (same set as /api/feedback's "negative")
    recent_negative: rs
      .filter(isNegative)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, RECENT_NEGATIVE_LIMIT)
      .map((r) => ({
        id: r.id,
        created_at: r.created_at,
        question: r.question,
        reason: negativeReason(r),
        categories: r.matched_categories,
        escalation_level: r.escalation_level ?? "balanced",
        model: r.model,
        handed_off: r.handed_off,
        steps_done: r.outcome?.steps_done ?? null,
        steps_total: r.outcome?.steps_total ?? null,
        escalated: r.outcome?.escalated ?? false,
        top_sources: r.sources.slice(0, 3).map((s) => s.file),
      })),
  };
}
