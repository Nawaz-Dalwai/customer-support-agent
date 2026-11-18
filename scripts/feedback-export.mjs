// Feedback loop: pulls the owner report from GET /api/feedback and writes every thumbs-down reply
// to a triage file, each with a suggested cause and where a fix or new eval case belongs.
//
// Run: npm run feedback:export                          (live demo)
//      BASE_URL=http://localhost:3000 npm run feedback:export
//      npm run feedback:export -- --include-owner        (also the owner's own test chats)
// Out: data/feedback/report-YYYY-MM-DD.json      summary: ratings, handoffs, categories, moods
//      data/feedback/triage-YYYY-MM-DD.jsonl     one thumbs-down reply per line, to label by hand
// data/feedback/ is git-ignored: it holds real visitor questions.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data/feedback");
const BASE_URL = (process.env.BASE_URL || "https://customer-support-agent-coral.vercel.app").replace(/\/$/, "");
const includeOwner = process.argv.includes("--include-owner");

const password = process.env.SITE_PASSWORD;
if (!password) {
  console.error("Missing SITE_PASSWORD in .env.local (needed to sign in as the owner)");
  process.exit(1);
}
const ownerCookie = `owner_session=${crypto.createHmac("sha256", password).update("owner-session-v1").digest("hex")}`;

const res = await fetch(`${BASE_URL}/api/feedback${includeOwner ? "?include_owner=1" : ""}`, {
  headers: { Cookie: ownerCookie },
});
const report = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`GET /api/feedback failed (${res.status}): ${report.error ?? "no body"}`);
  process.exit(1);
}

// A first guess at the cause, so triage starts from the most likely fix
function suggestCause(s) {
  const reason = s.feedback.reason;
  if (reason === "needed_person" || reason === "unneeded_handoff") {
    return { cause: "escalation", next_step: "Add as a case in data/eval/escalation.jsonl, then adjust the handoff rules in the system prompt" };
  }
  if (!s.context_used || reason === "not_answered") {
    return {
      cause: "search_miss_or_missing_article",
      next_step: "Check whether a help article answers it: if yes, add the question to the search eval; if no, it's a content gap",
    };
  }
  return { cause: "answer_quality", next_step: "Compare the reply with the sources shown; if they hold the answer, it's a prompt or model issue" };
}

const triage = report.thumbs_down.map((s) => ({
  id: s.id,
  created_at: s.created_at,
  reason: s.feedback.reason,
  question: s.question,
  response: s.response,
  sources: s.sources,
  matched_categories: s.matched_categories,
  handed_off: s.handed_off,
  handoff_reason: s.handoff_reason,
  context_used: s.context_used,
  model: s.model,
  suggested: suggestCause(s),
  label: null, // fill in by hand: the confirmed cause and the fix made
}));

const date = new Date().toISOString().slice(0, 10);
fs.mkdirSync(OUT_DIR, { recursive: true });
const { thumbs_down: _rows, ...summary } = report;
fs.writeFileSync(path.join(OUT_DIR, `report-${date}.json`), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(path.join(OUT_DIR, `triage-${date}.jsonl`), triage.map((t) => JSON.stringify(t)).join("\n") + (triage.length ? "\n" : ""));

const o = report.overall;
console.log(`${report.reply_count} replies (${report.scope}) since ${report.oldest ?? "-"}`);
console.log(
  `Rated ${o.rated} (${o.rated_pct ?? 0}%) · thumbs up ${o.thumbs_up_pct_of_rated ?? "-"}% of rated · handoffs ${o.handoff_pct ?? 0}% · articles not used ${o.articles_not_used_pct ?? 0}%`,
);
const causes = {};
for (const t of triage) causes[t.suggested.cause] = (causes[t.suggested.cause] ?? 0) + 1;
if (triage.length) console.table(causes);
console.log(`Wrote data/feedback/report-${date}.json and data/feedback/triage-${date}.jsonl (${triage.length} thumbs-down)`);
