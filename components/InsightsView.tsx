"use client";

// /insights: how the support agent is doing, from the per-reply records.
// Visitors always see sample data; the owner can switch to live data (checked server-side).
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ESCALATION_LEVELS, ESCALATION_LEVEL_IDS, type EscalationLevel } from "@/app/lib/escalation-levels";
import { FEEDBACK_REASONS, type FeedbackReason } from "@/app/lib/feedback-reasons";
import { MODELS } from "@/app/lib/models";
import customerSupportCategories from "@/app/lib/customer_support_categories.json";

// ---- Shape of GET /api/insights (see app/lib/insights.ts) ----
type Rates = {
  replies: number;
  answered: number;
  outcome_reported: number;
  resolved: number;
  stuck: number;
  resolved_pct_of_reported: number | null;
  handoff_pct: number | null;
  unneeded_handoffs: number;
};
type EvalResult = {
  must_escalate_cases: number;
  answerable_cases: number;
  missed_handoffs: number;
  false_handoffs: number;
  handoff_recall_pct: number | null;
  false_handoff_rate_pct: number | null;
};
type NegativeReply = {
  id: string;
  created_at: string;
  question: string;
  reason: string | null;
  categories: string[];
  escalation_level: EscalationLevel;
  model: string;
  handed_off: boolean;
  steps_done: number | null;
  steps_total: number | null;
  escalated: boolean;
  top_sources: string[];
};
type Insights = {
  is_owner: boolean;
  source: "sample" | "live";
  sample_note?: string;
  scope: string;
  reply_count: number;
  oldest: string | null;
  newest: string | null;
  overall: Rates & { median_total_seconds: number | null; median_input_tokens: number | null };
  negative_reasons: Record<string, number>;
  retries: {
    stuck_answers: number;
    retries: number;
    retried_pct_of_stuck: number | null;
    outcome_reported: number;
    resolved: number;
    resolved_pct_of_reported: number | null;
    went_to_person: number;
  };
  by_category: Record<string, Rates>;
  by_mood: Record<string, Rates>;
  by_model: Record<string, Rates>;
  by_escalation_level: Record<string, Rates>;
  cost: {
    note: string;
    total_usd: number;
    median_per_reply_usd: number | null;
    by_model: Record<string, { replies: number; median_usd: number | null; total_usd: number }>;
  };
  eval_tradeoffs: Partial<Record<EscalationLevel, EvalResult>>;
  recent_negative: NegativeReply[];
};

// ---- Labels ----
const CATEGORY_NAMES: Record<string, string> = Object.fromEntries(
  customerSupportCategories.categories.map((c) => [c.id, c.name]),
);
CATEGORY_NAMES.none = "No category";
const modelName = (id: string) => MODELS.find((m) => m.id === id)?.name.replace("Claude ", "") ?? id;
const reasonLabel = (r: string | null) =>
  r ? (FEEDBACK_REASONS[r as FeedbackReason] ?? r) : "No reason given";
const levelName = (id: string) => ESCALATION_LEVELS[id as EscalationLevel]?.name ?? id;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const pct = (n: number | null | undefined) => (n == null ? "–" : `${Math.round(n)}%`);
const usd = (n: number | null | undefined) =>
  n == null ? "–" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "–";

// ---- Small building blocks ----
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-medium">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

// One horizontal bar with its value as text beside it; value and max share a unit
function Bar({ value, max, label, tooltip }: { value: number | null; max: number; label: string; tooltip: string }) {
  const width = value == null || max <= 0 ? 0 : Math.max(2, (100 * value) / max);
  return (
    <div className="flex items-center gap-2" title={tooltip}>
      <div className="h-2.5 flex-1 rounded-sm bg-muted">
        {value != null && <div className="h-full rounded-r bg-primary" style={{ width: `${width}%` }} />}
      </div>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums">{label}</span>
    </div>
  );
}

function CountBars({ rows }: { rows: { key: string; label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nothing reported yet.</p>;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,13rem)_1fr] items-center gap-3 text-sm">
          <span className="truncate" title={r.label}>{r.label}</span>
          <Bar value={r.count} max={max} label={String(r.count)} tooltip={`${r.label}: ${r.count}`} />
        </div>
      ))}
    </div>
  );
}

// Rows of a grouping (category, model...) with replies, resolved % and handoff % as separate bars
function RateTable({ groups, nameOf, extra }: {
  groups: Record<string, Rates>;
  nameOf: (k: string) => string;
  extra?: { header: string; cell: (k: string) => string };
}) {
  const entries = Object.entries(groups);
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No replies yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="pb-2 pr-3 font-medium">Name</th>
            <th className="pb-2 pr-3 text-right font-medium">Replies</th>
            <th className="w-1/3 pb-2 pr-3 font-medium">Resolved (of those who answered)</th>
            <th className="w-1/4 pb-2 pr-3 font-medium">Handed off</th>
            {extra && <th className="pb-2 text-right font-medium">{extra.header}</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, r]) => (
            <tr key={k} className="border-t">
              <td className="whitespace-nowrap py-1.5 pr-3">{nameOf(k)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{r.replies}</td>
              <td className="py-1.5 pr-3">
                <Bar
                  value={r.resolved_pct_of_reported}
                  max={100}
                  label={r.outcome_reported ? pct(r.resolved_pct_of_reported) : "–"}
                  tooltip={`${nameOf(k)}: ${r.resolved} of ${r.outcome_reported} answers reported as fixed`}
                />
              </td>
              <td className="py-1.5 pr-3">
                <Bar
                  value={r.handoff_pct}
                  max={100}
                  label={pct(r.handoff_pct)}
                  tooltip={`${nameOf(k)}: ${pct(r.handoff_pct)} of ${r.replies} replies handed to a person`}
                />
              </td>
              {extra && <td className="py-1.5 text-right tabular-nums">{extra.cell(k)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Page ----
export default function InsightsView() {
  const [source, setSource] = useState<"sample" | "live">("sample");
  const [includeOwner, setIncludeOwner] = useState(false);
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (source === "live") params.set("source", "live");
    if (includeOwner) params.set("include_owner", "1");
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/insights?${params}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        return body as Insights;
      })
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [source, includeOwner]);

  const isOwner = data?.is_owner ?? false;
  const o = data?.overall;
  const reasons = data
    ? Object.entries(data.negative_reasons)
        .filter(([k]) => k !== "unneeded_handoff")
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => ({ key: k, label: reasonLabel(k), count: n }))
    : [];
  const moods = data
    ? Object.entries(data.by_mood).map(([k, r]) => ({ key: k, label: capitalize(k), count: r.replies }))
    : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Insights</h1>
          <p className="text-sm text-muted-foreground">
            How the support agent is doing: what it resolves, when it hands off, why customers get stuck, and what it costs.
          </p>
        </div>
        {isOwner && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div role="radiogroup" aria-label="Data source" className="inline-flex rounded-md border p-0.5">
              {(["sample", "live"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={source === s}
                  onClick={() => setSource(s)}
                  className={cn(
                    "rounded px-3 py-1 transition-colors",
                    source === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {capitalize(s)}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={includeOwner} onChange={(e) => setIncludeOwner(e.target.checked)} />
              Include my test chats
            </label>
          </div>
        )}
      </div>

      {data?.source === "sample" && (
        <div className="flex gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <strong>Sample data, not real customers.</strong> Questions come from the public WixQA dataset and
            hand-written test cases; handoffs, outcomes and timings are simulated.
            {!isOwner && " Real conversation data is only visible to the site owner."}
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
          {source === "live" ? "Live data isn't available: " : "Couldn't load insights: "}
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {data && o && !error && (
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-50")}>
          <p className="text-xs text-muted-foreground">
            {capitalize(data.source)} data · {data.scope} · {data.reply_count} replies · {day(data.oldest)} to {day(data.newest)}
          </p>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Replies" value={String(o.replies)} detail={`${o.answered} answered, ${o.replies - o.answered} handed off`} />
            <Stat
              label="Resolved"
              value={o.outcome_reported ? pct(o.resolved_pct_of_reported) : "–"}
              detail={`${o.resolved} of ${o.outcome_reported} who answered "Did this fix it?"`}
            />
            <Stat label="Handed off" value={pct(o.handoff_pct)} detail="of all replies" />
            <Stat label="Didn't need a person" value={String(o.unneeded_handoffs)} detail="handoffs the customer called unneeded" />
            <Stat label="Median reply time" value={o.median_total_seconds == null ? "–" : `${o.median_total_seconds.toFixed(1)}s`} detail="search + answer" />
            <Stat label="Est. cost per reply" value={usd(data.cost.median_per_reply_usd)} detail={`median · ${usd(data.cost.total_usd)} in total`} />
          </div>

          <Section title="Where it struggles" hint="By support category. Low resolved % or high handoff % points to topics that need better help articles.">
            <RateTable groups={data.by_category} nameOf={(k) => CATEGORY_NAMES[k] ?? k} />
          </Section>

          <div className="grid gap-4 md:grid-cols-2">
            <Section title="Why customers got stuck" hint='Reason picked after "Still stuck" on "Did this fix it?"'>
              <CountBars rows={reasons} />
            </Section>
            <Section title="Customer mood" hint="As Claude read it from each message.">
              <CountBars rows={moods} />
            </Section>
          </div>

          <Section
            title="After Still stuck"
            hint='How often customers used "Try again", and whether the new answer fixed it or ended with a person.'
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Answers marked stuck" value={String(data.retries.stuck_answers)} />
              <Stat
                label="Tried again"
                value={String(data.retries.retries)}
                detail={data.retries.stuck_answers ? `${pct(data.retries.retried_pct_of_stuck)} of stuck answers` : undefined}
              />
              <Stat
                label="Fixed after retry"
                value={data.retries.outcome_reported ? pct(data.retries.resolved_pct_of_reported) : "–"}
                detail={`${data.retries.resolved} of ${data.retries.outcome_reported} who answered`}
              />
              <Stat label="Retry ended with a person" value={String(data.retries.went_to_person)} detail="handed off, or asked after" />
            </div>
          </Section>

          <Section
            title="Handoff policy: real use vs. the eval"
            hint="Real use is what customers did with each policy; the eval is 33 hand-labelled test conversations run on Claude Haiku 5.5."
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">Policy</th>
                    <th className="pb-2 pr-3 text-right font-medium">Replies</th>
                    <th className="w-1/4 pb-2 pr-3 font-medium">Handed off (real)</th>
                    <th className="w-1/4 pb-2 pr-3 font-medium">Resolved (real)</th>
                    <th className="pb-2 pr-3 text-right font-medium">Eval: needed handoffs caught</th>
                    <th className="pb-2 text-right font-medium">Eval: unneeded handoffs</th>
                  </tr>
                </thead>
                <tbody>
                  {ESCALATION_LEVEL_IDS.map((id) => {
                    const r = data.by_escalation_level[id];
                    const e = data.eval_tradeoffs[id];
                    return (
                      <tr key={id} className="border-t">
                        <td className="whitespace-nowrap py-1.5 pr-3">{levelName(id)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{r?.replies ?? 0}</td>
                        <td className="py-1.5 pr-3">
                          <Bar value={r?.handoff_pct ?? null} max={100} label={pct(r?.handoff_pct)} tooltip={`${levelName(id)}: ${pct(r?.handoff_pct)} handed off`} />
                        </td>
                        <td className="py-1.5 pr-3">
                          <Bar
                            value={r?.resolved_pct_of_reported ?? null}
                            max={100}
                            label={r?.outcome_reported ? pct(r.resolved_pct_of_reported) : "–"}
                            tooltip={r ? `${levelName(id)}: ${r.resolved} of ${r.outcome_reported} reported fixed` : "No replies"}
                          />
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {e ? `${pct(e.handoff_recall_pct)} (${e.must_escalate_cases - e.missed_handoffs}/${e.must_escalate_cases})` : "–"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {e ? `${pct(e.false_handoff_rate_pct)} (${e.false_handoffs}/${e.answerable_cases})` : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="By model" hint="Visitors always get Haiku; Opus and Sonnet replies are owner tests.">
            <RateTable
              groups={data.by_model}
              nameOf={modelName}
              extra={{ header: "Est. cost / reply", cell: (k) => usd(data.cost.by_model[k]?.median_usd) }}
            />
          </Section>

          <Section
            title="Recent problem replies"
            hint={`Still stuck or "didn't need a person", newest first${data.recent_negative.length >= 20 ? " (latest 20)" : ""}.`}
          >
            {data.recent_negative.length === 0 ? (
              <p className="text-sm text-muted-foreground">None reported. 🎉</p>
            ) : (
              <ul className="divide-y">
                {data.recent_negative.map((n) => (
                  <li key={n.id} className="py-2.5 text-sm">
                    <p className="break-words">{n.question}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{reasonLabel(n.reason)}</span>
                      <span>{n.categories.map((c) => CATEGORY_NAMES[c] ?? c).join(", ")}</span>
                      <span>{levelName(n.escalation_level)}</span>
                      <span>{modelName(n.model)}</span>
                      {!!n.steps_total && <span>Steps ticked {n.steps_done}/{n.steps_total}</span>}
                      {n.escalated && <span>Then asked for a person</span>}
                      <span>{day(n.created_at)}</span>
                    </div>
                    {n.top_sources.length > 0 && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={n.top_sources.join("\n")}>
                        Sources: {n.top_sources.map((s) => s.replace(/\.txt$/, "").replace(/_/g, " ")).join(" · ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <p className="text-xs text-muted-foreground">{data.cost.note}</p>
        </div>
      )}
    </main>
  );
}
