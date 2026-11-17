// Re-run the offline answer simulation with the app's CURRENT search.
// Same 100 questions as the first run (data/eval/sim/sample.jsonl), but the articles come from the
// app's own retrieveContext() (10 chunks kept to the top 5 articles), so the batches show exactly
// what Claude gets in the deployed app for a first message. Expert answers are not included
// (answering stays blind).
//
// Run: npm run eval:sim:rerun:prepare   (~100 searches, ~$0.10 AWS)
// Out: data/eval/sim-v2/sample.jsonl          same ids/questions + retrieval results for this run
//      data/eval/sim-v2/batches/batch-NN.md   question + the articles the app would send
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveContext } from "../app/lib/utils.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM = path.join(ROOT, "data/eval/sim/sample.jsonl");
const OUT = path.join(ROOT, "data/eval/sim-v2");
const BATCH = 10;

const pretty = (file) => file.replace(/\.txt$/, "").replace(/_/g, " "); // same as the app's source names
const sample = fs.readFileSync(FROM, "utf8").trim().split("\n").map((l) => JSON.parse(l));

fs.rmSync(path.join(OUT, "batches"), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "batches"), { recursive: true });

const rows = [];
for (let b = 0; b < sample.length / BATCH; b++) {
  const items = sample.slice(b * BATCH, (b + 1) * BATCH);
  let md = `# Answering batch ${b + 1}\n\nAnswer each question as the support assistant, using ONLY the documents given for it.\n`;
  for (const s of items) {
    const rag = await retrieveContext({ latest: s.question }, process.env.KNOWLEDGE_BASE_ID);
    if (!rag.isRagWorking) throw new Error(`Search failed for ${s.id}`);
    const shown = rag.ragSources.map((r) => r.fileName);
    rows.push({
      id: s.id,
      set: s.set,
      idx: s.idx,
      area: s.area,
      question: s.question,
      expected: s.expected,
      first_run_retrieval_hit_at_3: s.retrieval_hit_at_3,
      // This run: right article among the 3 sources shown / anywhere in what Claude reads
      retrieval_hit_at_3: s.expected.some((f) => shown.includes(pretty(f))),
      retrieval_in_context: s.expected.some((f) => rag.articles.includes(pretty(f))),
      articles_sent: rag.articles,
      chunks_sent: (rag.context.match(/<document index=/g) ?? []).length,
      chars_sent: rag.context.length,
    });
    md += `\n---\n\n## ${s.id}\n\n**User:** ${s.question}\n\n<documents>\n${rag.context}\n</documents>\n`;
  }
  fs.writeFileSync(path.join(OUT, "batches", `batch-${String(b + 1).padStart(2, "0")}.md`), md);
}
fs.writeFileSync(path.join(OUT, "sample.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const n = (f) => rows.filter(f).length;
console.log(`Sample: ${rows.length} questions (same as first run)`);
console.log(`Right article in 3 sources shown: first run ${n((r) => r.first_run_retrieval_hit_at_3)}, now ${n((r) => r.retrieval_hit_at_3)}`);
console.log(`Right article anywhere in what Claude reads: now ${n((r) => r.retrieval_in_context)}`);
console.log(`Mean chunks sent: ${(rows.reduce((a, r) => a + r.chunks_sent, 0) / rows.length).toFixed(1)}`);
console.log(`Batches written: ${Math.ceil(rows.length / BATCH)}`);
