"use client";

// Answer-or-escalate policy picker with the measured trade-off for each level. Anyone can switch
// levels; the choice applies from the next message.
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ESCALATION_LEVELS,
  ESCALATION_LEVEL_IDS,
  type EscalationLevel,
} from "@/app/lib/escalation-levels";
import tradeoffs from "@/app/lib/escalation-tradeoffs.json";

type LevelResult = {
  run_at: string;
  model: string;
  cases: number;
  must_escalate_cases: number;
  answerable_cases: number;
  handoff_recall_pct: number | null;
  false_handoff_rate_pct: number | null;
  missed_handoffs: number;
  false_handoffs: number;
};
const RESULTS = tradeoffs.levels as Partial<Record<EscalationLevel, LevelResult>>;

const WHAT_IT_MEANS: Record<EscalationLevel, string> = {
  cautious: "Fewest risky answers, most agent time",
  balanced: "Default: answers what the articles cover",
  resolve_first: "Least agent time, more customers left to ask again",
};

const fmt = (n: number | null | undefined) => (n == null ? "–" : `${Math.round(n)}%`);

export default function PolicySelector({
  value,
  onChange,
  disabled,
}: {
  value: EscalationLevel;
  onChange: (level: EscalationLevel) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const measured = ESCALATION_LEVEL_IDS.map((id) => RESULTS[id]).filter(Boolean) as LevelResult[];
  const sample = measured[0];

  return (
    <div className="mb-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Handoff policy</span>
        <div role="radiogroup" aria-label="Handoff policy" className="inline-flex rounded-md border p-0.5">
          {ESCALATION_LEVEL_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={value === id}
              disabled={disabled}
              title={ESCALATION_LEVELS[id].summary}
              onClick={() => onChange(id)}
              className={cn(
                "rounded px-2 py-1 transition-colors disabled:opacity-50",
                value === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {ESCALATION_LEVELS[id].name}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:underline"
        >
          Compare
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>
      <p className="mt-1 text-muted-foreground">
        {ESCALATION_LEVELS[value].summary}. Applies from your next message.
      </p>

      {open && (
        <div className="mt-2 rounded-md border bg-muted/40 p-3">
          <p className="mb-2 text-muted-foreground">
            Every handoff policy trades two failures: a customer who needed a person but didn&apos;t get one, and
            an agent spending time on a question the bot could have answered.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Policy</th>
                  <th className="py-1 pr-3 font-medium">Needed handoffs caught</th>
                  <th className="py-1 pr-3 font-medium">Unneeded handoffs</th>
                  <th className="py-1 font-medium">In practice</th>
                </tr>
              </thead>
              <tbody>
                {ESCALATION_LEVEL_IDS.map((id) => {
                  const r = RESULTS[id];
                  return (
                    <tr key={id} className={cn("border-t", value === id && "font-medium")}>
                      <td className="py-1 pr-3">{ESCALATION_LEVELS[id].name}</td>
                      <td className="py-1 pr-3">
                        {r ? `${fmt(r.handoff_recall_pct)} (${r.must_escalate_cases - r.missed_handoffs}/${r.must_escalate_cases})` : "Not measured"}
                      </td>
                      <td className="py-1 pr-3">
                        {r ? `${fmt(r.false_handoff_rate_pct)} (${r.false_handoffs}/${r.answerable_cases})` : "–"}
                      </td>
                      <td className="py-1 text-muted-foreground">{WHAT_IT_MEANS[id]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-muted-foreground">
            {sample
              ? `Measured on ${sample.cases} hand-labelled test conversations with ${sample.model}, ${sample.run_at.slice(0, 10)}. Small sample: read the gaps between policies, not the exact percentages.`
              : "Not measured yet."}
          </p>
        </div>
      )}
    </div>
  );
}
