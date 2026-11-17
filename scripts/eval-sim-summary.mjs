// Summarize the offline answer simulation (all numbers computed here, not by hand).
// Run: node scripts/eval-sim-summary.mjs
// Out: data/eval/results/simulation-summary.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIM = path.join(ROOT, "data/eval/sim");
const readJsonl = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const readDir = (d) =>
  fs.readdirSync(path.join(SIM, d)).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) => readJsonl(path.join(SIM, d, f)));

const sample = Object.fromEntries(readJsonl(path.join(SIM, "sample.jsonl")).map((s) => [s.id, s]));
const answers = Object.fromEntries(readDir("answers").map((a) => [a.id, a]));
const grades = readDir("grades");

const rows = grades.map((g) => ({ ...g, ...sample[g.id], redirect: answers[g.id]?.redirect_to_agent?.should_redirect ?? false }));
const missingAnswers = Object.keys(sample).filter((id) => !answers[id]);
const missingGrades = Object.keys(sample).filter((id) => !grades.some((g) => g.id === id));

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const mean = (xs) => (xs.length ? Math.round((100 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 100 : null);

function summarize(rs) {
  const n = rs.length;
  return {
    questions: n,
    mean_correctness_0_2: mean(rs.map((r) => r.correctness)),
    mean_completeness_0_2: mean(rs.map((r) => r.completeness)),
    fully_correct_pct: pct(rs.filter((r) => r.correctness === 2).length, n),
    correct_and_complete_pct: pct(rs.filter((r) => r.correctness === 2 && r.completeness === 2).length, n),
    wrong_answer_pct: pct(rs.filter((r) => r.correctness === 0).length, n),
    unsupported_claims_pct: pct(rs.filter((r) => r.unsupported).length, n),
    escalation_appropriate_pct: pct(rs.filter((r) => r.escalation_ok).length, n),
    escalated_pct: pct(rs.filter((r) => r.redirect).length, n),
    expert_used_info_beyond_retrieved_pct: pct(rs.filter((r) => r.expert_beyond_kb).length, n),
  };
}

const summary = {
  note:
    "Offline simulation: answers written by the evaluator model (not the app's Haiku/Sonnet/Opus) using the app's prompt and the same retrieved articles, then graded against WixQA expert answers by the same model. Treat as an estimate of answer quality given retrieval, not a measurement of the deployed app.",
  completeness: { answers: Object.keys(answers).length, grades: grades.length, missing_answers: missingAnswers, missing_grades: missingGrades },
  overall: summarize(rows),
  by_set: Object.fromEntries(["expertwritten", "simulated"].map((s) => [s, summarize(rows.filter((r) => r.set === s))])),
  by_retrieval: {
    right_article_in_top3: summarize(rows.filter((r) => r.retrieval_hit_at_3)),
    right_article_missed: summarize(rows.filter((r) => !r.retrieval_hit_at_3)),
  },
  by_area: Object.fromEntries(
    [...new Set(rows.map((r) => r.area))].sort().map((a) => [a, summarize(rows.filter((r) => r.area === a))]),
  ),
  weakest_answers: rows
    .filter((r) => r.correctness + r.completeness <= 2)
    .map((r) => ({ id: r.id, set: r.set, retrieval_hit_at_3: r.retrieval_hit_at_3, correctness: r.correctness, completeness: r.completeness, note: r.note })),
};

fs.writeFileSync(path.join(ROOT, "data/eval/results/simulation-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
