// Builds the SAMPLE data shown on /insights to visitors (and to the owner in "Sample" mode).
// 150 fake reply records (plus "Try again" follow-ups) in the same shape as the real ones in app/lib/signals.ts, so the page
// and summarize() treat both alike. Nothing here is a real customer:
//   - answerable questions + their articles come from the public WixQA set (data/eval/*.jsonl)
//   - questions that need a person come from the hand-written escalation cases
//   - handoffs, outcomes, moods, timings and tokens are drawn from a seeded random generator,
//     with rates loosely based on this project's evals (so the same file comes out every run)
// Run: npm run build:insights-sample
// Out: app/lib/insights-sample.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "app/lib/insights-sample.json");
const COUNT = 150;
const ANCHOR = Date.parse("2026-11-24T12:00:00Z"); // records spread over the 30 days before this
const SEED = 20261124;

// ---- Seeded randomness (mulberry32) so re-running gives identical output ----
let state = SEED;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p) => rand() < p;
const between = (lo, hi) => lo + rand() * (hi - lo);
const int = (lo, hi) => Math.floor(between(lo, hi + 1));
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const weighted = (entries) => {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) if ((r -= w) < 0) return v;
  return entries.at(-1)[0];
};
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const uuid = () => {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20)}`;
};
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---- Inputs ----
const readJsonl = (f) =>
  fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r._note);
const wixqa = [...readJsonl("data/eval/expertwritten.jsonl"), ...readJsonl("data/eval/simulated.jsonl")].filter(
  (q) => q.question.length <= 300 && q.files?.length,
);
const needsPerson = readJsonl("data/eval/escalation.jsonl").filter((c) => c.should_escalate);
const kbFiles = fs.readdirSync(path.join(ROOT, "data/kb")).filter((f) => f.endsWith(".txt"));
const { categories } = JSON.parse(fs.readFileSync(path.join(ROOT, "app/lib/customer_support_categories.json"), "utf8"));

// Stand-in for Claude's matched_categories: the app's category keywords plus broader word stems
// (sample data only; the live app lets Claude choose), "other" if nothing matches
const EXTRA_STEMS = {
  account: ["account", "log in", "sign in", "owner", "two-step", "2fa"],
  billing: ["plan", "charge", "billing", "subscription", "price", "renew", "money back"],
  payments: ["payout", "payment", "pay ", "credit card", "tax"],
  domains_email: ["domain", "email", "gmail", "mail"],
  site_editor: ["mobile", "image", "text", "page", "slider", "animation", "font", "logo", "site live", "header", "button", "gallery", "video", "blog"],
  apps_commerce: ["store", "product", "sell", "booking", "staff", "schedule", "event", "form", "member", "order", "coupon", "shipping", "inventory"],
  technical: ["loading", "slow", "not working", "broken", "won't", "can't", "doesn't", "crash"],
};
const categorize = (text) => {
  const t = text.toLowerCase();
  const hits = categories.filter(
    (c) => c.id !== "other" && [...c.keywords, ...(EXTRA_STEMS[c.id] ?? [])].some((k) => t.includes(k.toLowerCase())),
  );
  return hits.length ? hits.slice(0, 2).map((c) => c.id) : ["other"];
};

const HANDOFF_REASON = {
  asks_for_human: "The customer asked to speak to a person.",
  refund_dispute: "A refund decision or charge dispute needs the billing team.",
  account_security: "Possible account security issue that needs staff to verify identity.",
  account_specific: "Needs access to the customer's account to check what happened.",
  legal: "Legal question that support staff must handle.",
  off_topic: "The question is unrelated to the platform.",
  not_covered: "The help articles don't cover this question.",
  cautious_sensitive: "Billing, payments or account access: handing off under the cautious policy.",
  cautious_unsure: "The articles may not fully answer this, so handing off under the cautious policy.",
  balanced_unsure: "The articles don't clearly cover this.",
};
// Lower for topics where step-by-step answers more often fail in practice
const RESOLVE_RATE = {
  account: 0.64, billing: 0.66, payments: 0.58, domains_email: 0.6,
  site_editor: 0.82, apps_commerce: 0.74, technical: 0.45, other: 0.7,
};
const SENSITIVE = new Set(["account", "billing", "payments"]);
const TIMING = {
  "claude-haiku-5-5": { total: [2.2, 5.5], out: [280, 650] },
  "claude-sonnet-5-5": { total: [5, 11], out: [350, 800] },
  "claude-opus-5-5": { total: [8, 19], out: [400, 950] },
};

function sources(primary) {
  const list = primary.map((file) => ({ file, score: round(between(0.62, 0.9), 3) }));
  while (list.length < 5) {
    const file = pick(kbFiles);
    if (!list.some((s) => s.file === file)) list.push({ file, score: round(between(0.35, 0.6), 3) });
  }
  return list.sort((a, b) => b.score - a.score);
}

function outcomeFor(category, kindOfQuestion, level) {
  const steps_total = chance(0.6) ? int(2, 6) : 0;
  let pResolve = RESOLVE_RATE[category] ?? 0.75;
  if (kindOfQuestion === "needs_person") pResolve = 0.2; // resolve-first answered something a person should have handled
  if (chance(pResolve)) {
    return { result: "resolved", reason: null, steps_done: steps_total, steps_total, escalated: false };
  }
  const reason =
    kindOfQuestion === "needs_person"
      ? weighted([["not_answered", 3], ["didnt_work", 1]])
      : weighted([["didnt_work", 4], ["incomplete", 3], ["incorrect", 1], ["not_answered", 2]]);
  return {
    result: "stuck",
    reason,
    steps_done: steps_total ? int(0, steps_total) : 0,
    steps_total,
    escalated: chance(level === "resolve_first" ? 0.55 : 0.4),
  };
}

const records = [];
for (let i = 0; i < COUNT; i++) {
  const requested_by = i % 10 === 9 ? "owner" : "visitor";
  const model =
    requested_by === "owner"
      ? weighted([["claude-opus-5-5", 2], ["claude-sonnet-5-5", 2], ["claude-haiku-5-5", 1]])
      : "claude-haiku-5-5";
  const escalation_level = weighted([["balanced", 6], ["cautious", 2], ["resolve_first", 2]]);
  const created = ANCHOR - Math.floor(between(0, 30 * 24 * 3600 * 1000));

  const needs = chance(0.2);
  let turn, question, response, matched_categories, primaryFiles, handed_off, handoff_reason, context_used, user_mood, kind;
  if (needs) {
    const c = pick(needsPerson);
    kind = c.kind;
    question = c.messages.at(-1);
    matched_categories = kind === "off_topic" ? ["other"] : categorize(c.messages.join(" "));
    primaryFiles = [];
    const pHandoff =
      kind === "asks_for_human" ? 1 : { cautious: 1, balanced: 0.95, resolve_first: ["off_topic", "not_covered"].includes(kind) ? 0.05 : 0.9 }[escalation_level];
    handed_off = chance(pHandoff);
    handoff_reason = handed_off ? HANDOFF_REASON[kind] : "";
    context_used = !["off_topic", "not_covered"].includes(kind) && chance(0.5);
    user_mood = weighted([["frustrated", 3], ["negative", 2], ["neutral", 2], ["confused", 1]]);
    response = handed_off
      ? "I've passed this conversation to the support team so someone can help you directly."
      : kind === "off_topic"
        ? "I can only help with questions about building and running your site on the platform."
        : "The help articles only partly cover this. Here's what they say. If you're still stuck, ask for a person and I'll pass you to the support team.";
    turn = c.messages.length;
  } else {
    const q = pick(wixqa);
    kind = "answerable";
    question = q.question;
    matched_categories = categorize(q.question);
    primaryFiles = q.files.slice(0, 2);
    const sensitive = matched_categories.some((c) => SENSITIVE.has(c));
    const pHandoff = { cautious: sensitive ? 0.6 : 0.2, balanced: 0.05, resolve_first: 0.02 }[escalation_level];
    handed_off = chance(pHandoff);
    handoff_reason = !handed_off
      ? ""
      : escalation_level === "cautious"
        ? HANDOFF_REASON[sensitive ? "cautious_sensitive" : "cautious_unsure"]
        : HANDOFF_REASON.balanced_unsure;
    context_used = chance(0.96);
    user_mood = weighted([["neutral", 5], ["curious", 3], ["confused", 2], ["positive", 1], ["frustrated", 1]]);
    response = handed_off
      ? `${clip(q.answer, 300)}\n\nI've also passed this conversation to the support team.`
      : clip(q.answer, 400);
    turn = chance(0.25) ? int(2, 3) : 1;
  }
  const category = matched_categories[0];
  let outcome;
  if (!handed_off && chance(0.55)) {
    outcome = outcomeFor(category, needs ? "needs_person" : "answerable", escalation_level);
  } else if (handed_off && kind === "answerable" && chance(escalation_level === "cautious" ? 0.35 : 0.1)) {
    outcome = { result: "unneeded_handoff", reason: null, steps_done: 0, steps_total: 0, escalated: false };
  }
  if (outcome) outcome.at = new Date(created + int(30, 600) * 1000).toISOString();

  const t = TIMING[model];
  const search_seconds = round(between(0.35, turn > 1 ? 1.6 : 1.1));
  const output_tokens = int(...t.out);
  records.push({
    id: uuid(),
    created_at: new Date(created).toISOString(),
    requested_by,
    model,
    escalation_level,
    turn,
    question,
    response,
    user_mood,
    matched_categories,
    handed_off,
    handoff_reason,
    context_used,
    refused: false,
    rag_working: !chance(0.01),
    sources: sources(primaryFiles),
    search_seconds,
    total_seconds: round(search_seconds + between(...t.total)),
    input_tokens: int(5200, 7200) + (turn - 1) * int(500, 1200),
    output_tokens,
    ...(outcome ? { outcome } : {}),
  });
}

// "Try again" follow-ups: about half of stuck answers get a retry whose own outcome is recorded.
// Drawn after the main loop so the 150 records above stay the same.
const RETRY_MESSAGES = {
  didnt_work: "I tried those steps and it didn't work. Is there another way to do this?",
  incomplete: "Some steps seem to be missing. Can you give me the complete steps?",
  incorrect: "That doesn't look right for my situation. Can you check again?",
};
for (const src of records.filter((r) => r.outcome?.result === "stuck")) {
  if (!chance(0.5)) continue;
  const created = Date.parse(src.outcome.at) + int(10, 120) * 1000;
  const reason = src.outcome.reason;
  const handed_off = chance(0.12);
  const t = TIMING[src.model];
  const search_seconds = round(between(0.5, 1.6));
  let outcome;
  if (!handed_off && chance(0.7)) {
    const steps_total = chance(0.6) ? int(2, 6) : 0;
    outcome = chance(0.55)
      ? { result: "resolved", reason: null, steps_done: steps_total, steps_total, escalated: false }
      : { result: "stuck", reason: weighted([["didnt_work", 2], ["incomplete", 1], ["not_answered", 1]]), steps_done: steps_total ? int(0, steps_total) : 0, steps_total, escalated: chance(0.5) };
    outcome.at = new Date(created + int(30, 600) * 1000).toISOString();
  }
  records.push({
    id: uuid(),
    created_at: new Date(created).toISOString(),
    requested_by: src.requested_by,
    model: src.model,
    escalation_level: src.escalation_level,
    retry_of: src.id,
    turn: src.turn + 1,
    question: RETRY_MESSAGES[reason] ?? `What I meant was: ${src.question}`,
    response: handed_off
      ? "I've passed this conversation to the support team so someone can help you directly."
      : "Here's another way to do this, with the complete steps from the help articles.",
    user_mood: weighted([["frustrated", 2], ["neutral", 2], ["confused", 1]]),
    matched_categories: src.matched_categories,
    handed_off,
    handoff_reason: handed_off ? HANDOFF_REASON.balanced_unsure : "",
    context_used: true,
    refused: false,
    rag_working: true,
    sources: src.sources,
    search_seconds,
    total_seconds: round(search_seconds + between(...t.total)),
    input_tokens: int(5200, 7200) + src.turn * int(500, 1200),
    output_tokens: int(...t.out),
    ...(outcome ? { outcome } : {}),
  });
}

records.sort((a, b) => b.created_at.localeCompare(a.created_at)); // newest first, like the live index
fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      note: "SAMPLE DATA - not real customers. Generated by scripts/build-insights-sample.mjs from public WixQA questions and hand-written test cases; handoffs, outcomes and timings are simulated.",
      generated_for: new Date(ANCHOR).toISOString(),
      records,
    },
    null,
    1,
  )}\n`,
);
console.log(`Wrote ${records.length} sample records to ${path.relative(ROOT, OUT)}`);
