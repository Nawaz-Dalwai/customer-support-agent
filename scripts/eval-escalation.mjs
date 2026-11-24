// Escalation evaluation: does the assistant hand off to a human exactly when it should?
// Sends each case in data/eval/escalation.jsonl through the app's real /api/chat route (same
// prompt, search and model as visitors get), signed in as the owner so the visitor limits don't
// apply. Multi-message cases are played out turn by turn; only the last reply is scored.
//
// Each answer-or-escalate level (Cautious / Balanced / Resolve-first) is scored against the same
// labels, so the levels can be compared: catching every needed handoff vs. not wasting agents' time.
//
// Needs the app running (npm run dev) or BASE_URL pointing at a deployment with the same SITE_PASSWORD.
// Run: npm run eval:escalation                                   (balanced, Claude Haiku 5.5)
//      npm run eval:escalation -- --levels cautious,balanced,resolve_first
//      npm run eval:escalation -- --model claude-sonnet-5-5
// Out: data/eval/results/escalation-<level>.jsonl          per case: verdict, reason, reply
//      data/eval/results/escalation-<level>-summary.json   metrics + tokens used, computed here
//      app/lib/escalation-tradeoffs.json                  per-level headline numbers shown in the chat
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data/eval/results");
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MODEL = argValue("--model", "claude-haiku-5-5");
const LEVELS = argValue("--levels", "balanced").split(",").map((l) => l.trim()).filter(Boolean);
const KNOWN_LEVELS = ["cautious", "balanced", "resolve_first"];
const unknown = LEVELS.filter((l) => !KNOWN_LEVELS.includes(l));
if (unknown.length) {
  console.error(`Unknown level(s): ${unknown.join(", ")}. Use ${KNOWN_LEVELS.join(", ")}.`);
  process.exit(1);
}
// Claude Haiku 5.5 list prices, USD per million tokens (prompts under 100K tokens)
const PRICE_PER_MTOK = { "claude-haiku-5-5": { input: 0.1, output: 0.5 } };
const CONCURRENCY = 3;

const password = process.env.SITE_PASSWORD;
if (!password) {
  console.error("Missing SITE_PASSWORD in .env.local (needed to sign in as the owner)");
  process.exit(1);
}
// Same value app/lib/access.ts expects in the owner cookie
const ownerCookie = `owner_session=${crypto.createHmac("sha256", password).update("owner-session-v1").digest("hex")}`;

const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };

async function chat(messages, level, attempt = 0) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ownerCookie },
    body: JSON.stringify({ messages, model: MODEL, escalation_level: level }),
  });
  // The route reports token usage in its debug header
  try {
    const debug = JSON.parse(res.headers.get("X-Debug-Data") ?? "null")?.data;
    if (debug?.input_tokens) {
      usage.calls++;
      usage.input_tokens += debug.input_tokens;
      usage.output_tokens += debug.output_tokens ?? 0;
    }
  } catch {}
  const body = await res.json().catch(() => ({}));
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return chat(messages, level, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.response ?? body.error ?? "no body"}`);
  return body;
}

const cases = fs
  .readFileSync(path.join(ROOT, "data/eval/escalation.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

try {
  await fetch(`${BASE_URL}/api/session`);
} catch {
  console.error(`Can't reach ${BASE_URL}. Start the app with npm run dev, or set BASE_URL.`);
  process.exit(1);
}

const costUsd = (u) => {
  const price = PRICE_PER_MTOK[MODEL];
  return price ? Number(((u.input_tokens * price.input + u.output_tokens * price.output) / 1e6).toFixed(4)) : null;
};

async function runLevel(LEVEL) {
  usage.calls = usage.input_tokens = usage.output_tokens = 0;
  console.log(`\nEscalation eval [${LEVEL}]: ${cases.length} cases, model ${MODEL}, ${BASE_URL}…`);
  const rows = new Array(cases.length);
  const started = Date.now();
  let done = 0;

  async function runCase(c) {
    const history = [];
    let reply;
    for (const text of c.messages) {
      history.push({ role: "user", content: text });
      reply = await chat(history, LEVEL);
      const { rag_sources: _sources, limits: _limits, ...stored } = reply;
      history.push({ role: "assistant", content: JSON.stringify(stored) });
    }
    const escalated = !!reply.redirect_to_agent?.should_redirect;
    return {
      id: c.id,
      kind: c.kind,
      should_escalate: c.should_escalate,
      escalated,
      correct: escalated === c.should_escalate,
      reason: reply.redirect_to_agent?.reason ?? "",
      user_mood: reply.user_mood,
      context_used: reply.debug?.context_used ?? null,
      sources: (reply.rag_sources ?? []).map((s) => s.fileName),
      response: reply.response,
      why_labeled: c.why,
    };
  }

  async function worker(queue) {
    for (let i = queue.next(); i !== undefined; i = queue.next()) {
      try {
        rows[i] = await runCase(cases[i]);
      } catch (err) {
        rows[i] = { id: cases[i].id, kind: cases[i].kind, should_escalate: cases[i].should_escalate, error: String(err.message ?? err) };
      }
      done++;
      if (done % 8 === 0 || done === cases.length) console.log(`  ${done}/${cases.length}`);
    }
  }
  const order = cases.map((_, i) => i);
  const queue = { next: () => order.shift() };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  // ---- Metrics (computed in code) -----------------------------------------------------------
  const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
  const scored = rows.filter((r) => !r.error);
  const must = scored.filter((r) => r.should_escalate);
  const mustNot = scored.filter((r) => !r.should_escalate);
  const escalated = scored.filter((r) => r.escalated);
  const tp = must.filter((r) => r.escalated).length;

  const byKind = {};
  for (const r of scored) {
    const k = (byKind[r.kind] ??= { cases: 0, correct: 0, should_escalate: r.should_escalate });
    k.cases++;
    if (r.correct) k.correct++;
  }
  for (const k of Object.values(byKind)) k.correct_pct = pct(k.correct, k.cases);

  const summary = {
    run_at: new Date().toISOString(),
    model: MODEL,
    escalation_level: LEVEL,
    base_url: BASE_URL,
    note:
      "Hand-written cases (data/eval/escalation.jsonl) sent through the app's /api/chat route. Labels follow the system prompt's escalation rules and what the help articles cover.",
    cases: cases.length,
    errors: rows.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    accuracy_pct: pct(scored.filter((r) => r.correct).length, scored.length),
    // Of the cases that need a person, how many got the handoff (a miss leaves the customer stuck)
    handoff_recall_pct: pct(tp, must.length),
    // Of the handoffs made, how many were needed (a false handoff costs an agent's time)
    handoff_precision_pct: pct(tp, escalated.length),
    false_handoff_rate_pct: pct(mustNot.filter((r) => r.escalated).length, mustNot.length),
    missed_handoffs: must.filter((r) => !r.escalated).map((r) => r.id),
    false_handoffs: mustNot.filter((r) => r.escalated).map((r) => r.id),
    by_kind: byKind,
    wall_clock_seconds: Math.round((Date.now() - started) / 1000),
    usage: { ...usage, cost_usd: costUsd(usage) },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `escalation-${LEVEL}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(OUT_DIR, `escalation-${LEVEL}-summary.json`), JSON.stringify(summary, null, 2) + "\n");

  console.table(
    Object.entries(byKind).map(([kind, k]) => ({
      kind,
      "should hand off": k.should_escalate,
      cases: k.cases,
      "correct %": k.correct_pct,
    })),
  );
  console.log(
    `[${LEVEL}] Accuracy ${summary.accuracy_pct}% · handoff recall ${summary.handoff_recall_pct}% · precision ${summary.handoff_precision_pct}% · false handoffs ${summary.false_handoff_rate_pct}%`,
  );
  if (summary.missed_handoffs.length) console.log("Missed handoffs:", summary.missed_handoffs.join(", "));
  if (summary.false_handoffs.length) console.log("False handoffs:", summary.false_handoffs.join(", "));
  if (summary.errors.length) console.log("Errors:", summary.errors);
  console.log(`Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out over ${usage.calls} calls ≈ $${summary.usage.cost_usd ?? "?"}`);
  return summary;
}

// Headline numbers per level for the chat's trade-off panel. Levels not run this time keep
// their previous numbers.
const TRADEOFFS_FILE = path.join(ROOT, "app/lib/escalation-tradeoffs.json");
const tradeoffs = fs.existsSync(TRADEOFFS_FILE) ? JSON.parse(fs.readFileSync(TRADEOFFS_FILE, "utf8")) : { levels: {} };
let totalCost = 0;
for (const level of LEVELS) {
  const s = await runLevel(level);
  totalCost += s.usage.cost_usd ?? 0;
  if (s.errors.length) {
    console.log(`[${level}] had errors; not updating its trade-off numbers`);
    continue;
  }
  const mustNot = Object.values(s.by_kind).filter((k) => !k.should_escalate).reduce((n, k) => n + k.cases, 0);
  tradeoffs.levels[level] = {
    run_at: s.run_at,
    model: s.model,
    cases: s.cases,
    must_escalate_cases: s.cases - mustNot,
    answerable_cases: mustNot,
    handoff_recall_pct: s.handoff_recall_pct,
    false_handoff_rate_pct: s.false_handoff_rate_pct,
    handoff_precision_pct: s.handoff_precision_pct,
    accuracy_pct: s.accuracy_pct,
    missed_handoffs: s.missed_handoffs.length,
    false_handoffs: s.false_handoffs.length,
  };
}
tradeoffs.note =
  "From scripts/eval-escalation.mjs: hand-labelled cases (data/eval/escalation.jsonl) run through /api/chat at each level.";
fs.writeFileSync(TRADEOFFS_FILE, JSON.stringify(tradeoffs, null, 2) + "\n");
console.log(`\nUpdated app/lib/escalation-tradeoffs.json · total cost ≈ $${totalCost.toFixed(4)}`);
