// Show a simulation batch for grading: question, expert answer, and the simulated answer side by side.
// Run AFTER answers/batch-NN.jsonl is written (answering is blind to the expert answers).
//
// Run: node scripts/eval-sim-grade-view.mjs 1          (first run, data/eval/sim)
//      SIM_DIR=data/eval/sim-v2 node scripts/eval-sim-grade-view.mjs 1   (re-run)
//
// Rubric (written to data/eval/sim/grades/batch-NN.jsonl, one row per question):
//   correctness   2 = agrees with the expert answer, no wrong facts; 1 = partly right / minor error; 0 = wrong or misleading
//   completeness  2 = covers the expert answer's key points; 1 = some; 0 = misses the main point
//   unsupported   true if the answer states something not found in the retrieved articles
//   escalation_ok true if the hand-off decision (redirect or not) was appropriate
//   expert_beyond_kb  true if the expert answer relies on information not in the retrieved articles
//   note          one short sentence
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIM_DIR = process.env.SIM_DIR || "data/eval/sim";
const n = String(process.argv[2] ?? "").padStart(2, "0");
const answersFile = path.join(ROOT, SIM_DIR, `answers/batch-${n}.jsonl`);
if (!fs.existsSync(answersFile)) {
  console.error(`No answers for batch ${n}. Answer it first.`);
  process.exit(1);
}
const readJsonl = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sample = Object.fromEntries(readJsonl(path.join(ROOT, SIM_DIR, "sample.jsonl")).map((s) => [s.id, s]));
const gold = {
  expertwritten: readJsonl(path.join(ROOT, "data/eval/expertwritten.jsonl")),
  simulated: readJsonl(path.join(ROOT, "data/eval/simulated.jsonl")),
};

for (const a of readJsonl(answersFile)) {
  const s = sample[a.id];
  const g = gold[s.set][s.idx];
  console.log(`\n==================== ${a.id} (${s.set}, ${s.area}, retrieval hit@3: ${s.retrieval_hit_at_3})`);
  console.log(`QUESTION: ${s.question}`);
  console.log(`\nEXPERT ANSWER:\n${g.answer}`);
  console.log(`\nSIMULATED ANSWER (redirect=${a.redirect_to_agent.should_redirect}):\n${a.response}`);
}
