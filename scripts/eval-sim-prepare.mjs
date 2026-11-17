// Prepare the offline answer simulation (100 questions).
// Picks a seeded, stratified sample (50 expert + 50 simulated, spread across product areas)
// from data/eval/results/retrieval.jsonl, retrieves the same 5 chunks the app would give
// Claude, and writes answering batches WITHOUT the expert answers (so answering is blind).
//
// Run: npm run eval:sim:prepare   (~100 searches, ~$0.10 AWS)
// Out: data/eval/sim/sample.jsonl            id, set, idx, area, question, expected files
//      data/eval/sim/batches/batch-NN.md     what the "app model" sees: question + retrieved articles
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIM = path.join(ROOT, "data/eval/sim");
const PER_SET = 50;
const BATCH = 10;

const rows = fs
  .readFileSync(path.join(ROOT, "data/eval/results/retrieval.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

// Seeded shuffle, then round-robin across areas so every area is represented
let seed = 2026;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function stratified(set) {
  const byArea = {};
  for (const r of shuffle(rows.filter((r) => r.set === set))) (byArea[r.area] ??= []).push(r);
  const areas = Object.keys(byArea).sort();
  const picked = [];
  while (picked.length < PER_SET && areas.some((a) => byArea[a].length)) {
    for (const a of areas) if (byArea[a].length && picked.length < PER_SET) picked.push(byArea[a].shift());
  }
  return picked;
}
const sample = [...stratified("expertwritten"), ...stratified("simulated")].map((r, i) => ({
  id: `q${String(i + 1).padStart(3, "0")}`,
  set: r.set,
  idx: r.idx,
  area: r.area,
  question: r.question,
  expected: r.expected,
  retrieval_hit_at_3: r.hit_at_shown,
}));

const client = new BedrockAgentRuntimeClient({
  region: process.env.BAWS_REGION || "us-east-1",
  credentials: { accessKeyId: process.env.BAWS_ACCESS_KEY_ID, secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY },
});
const retrieve = async (text) =>
  (
    await client.send(
      new RetrieveCommand({
        knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: text.slice(0, 1000) },
        retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: 5 } },
      }),
    )
  ).retrievalResults ?? [];

fs.rmSync(path.join(SIM, "batches"), { recursive: true, force: true });
fs.mkdirSync(path.join(SIM, "batches"), { recursive: true });
fs.writeFileSync(path.join(SIM, "sample.jsonl"), sample.map((s) => JSON.stringify(s)).join("\n") + "\n");

for (let b = 0; b < sample.length / BATCH; b++) {
  const items = sample.slice(b * BATCH, (b + 1) * BATCH);
  let md = `# Answering batch ${b + 1}\n\nAnswer each question as the support assistant, using ONLY the documents given for it.\n`;
  for (const s of items) {
    const docs = (await retrieve(s.question)).filter((r) => r.content?.text);
    md += `\n---\n\n## ${s.id}\n\n**User:** ${s.question}\n\n<documents>\n`;
    docs.forEach((r, i) => {
      md += `<document index="${i + 1}">\n${r.content.text.trim()}\n</document>\n`;
    });
    md += `</documents>\n`;
  }
  fs.writeFileSync(path.join(SIM, "batches", `batch-${String(b + 1).padStart(2, "0")}.md`), md);
}

const count = (k) => sample.reduce((o, s) => ((o[s[k]] = (o[s[k]] ?? 0) + 1), o), {});
console.log(`Sample: ${sample.length} questions`, count("set"));
console.log("By area:", count("area"));
console.log(`Retrieval hit@3 within sample: ${sample.filter((s) => s.retrieval_hit_at_3).length}/${sample.length}`);
console.log(`Batches written: ${Math.ceil(sample.length / BATCH)}`);
