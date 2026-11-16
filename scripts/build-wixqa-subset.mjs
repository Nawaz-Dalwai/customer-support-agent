// Build a small WixQA knowledge base for the Bedrock Knowledge Base.
//
// Usage:
//   node scripts/build-wixqa-subset.mjs <dir-with-wixqa-files> [distractors=160]
//
// <dir> must contain the files from https://huggingface.co/datasets/Wix/WixQA :
//   corpus.jsonl        (wix_kb_corpus/wix_kb_corpus.jsonl)
//   expertwritten.jsonl (wixqa_expertwritten/test.jsonl)
//   simulated.jsonl     (wixqa_simulated/test.jsonl)
//
// Output (in the project):
//   data/kb/*.txt              one file per article  -> upload to S3
//   data/kb-manifest.json      article id -> file name, url, why it was included
//   data/eval/*.jsonl          the 400 test questions with ground-truth article ids
//
// Selection: every article referenced by the ExpertWritten + Simulated questions,
// plus N random "distractor" articles (seeded, so the result is reproducible).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , srcDir, nArg] = process.argv;
if (!srcDir) {
  console.error("usage: node scripts/build-wixqa-subset.mjs <dir> [distractors]");
  process.exit(1);
}
const DISTRACTORS = Number(nArg ?? 160);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_KB = path.join(ROOT, "data/kb");
const OUT_EVAL = path.join(ROOT, "data/eval");

const readJsonl = (f) =>
  fs.readFileSync(path.join(srcDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const corpus = readJsonl("corpus.jsonl");
const byId = new Map(corpus.map((a) => [a.id, a]));
const evalSets = { expertwritten: readJsonl("expertwritten.jsonl"), simulated: readJsonl("simulated.jsonl") };

// 1. Articles needed to answer the test questions
const required = new Set();
for (const rows of Object.values(evalSets))
  for (const r of rows) for (const id of r.article_ids ?? []) required.add(id);
const missing = [...required].filter((id) => !byId.has(id));
if (missing.length) throw new Error(`${missing.length} referenced articles missing from corpus`);

// 2. Seeded random distractors (regular help articles only)
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pool = corpus.filter((a) => a.article_type === "article" && !required.has(a.id));
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const distractors = pool.slice(0, DISTRACTORS);

// 3. Write one .txt per article. File name = title (the app shows it as the source name).
fs.rmSync(OUT_KB, { recursive: true, force: true });
fs.mkdirSync(OUT_KB, { recursive: true });
fs.mkdirSync(OUT_EVAL, { recursive: true });

const used = new Set();
const fileNameFor = (title) => {
  const base =
    title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s-]+/g, "_").slice(0, 90) ||
    "article";
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${n++}`;
  used.add(name.toLowerCase());
  return `${name}.txt`;
};

const manifest = [];
const write = (a, reason) => {
  const file = fileNameFor(a.title);
  const body = `${a.title}\nSource: ${a.url}\n\n${a.contents.trim()}\n`;
  fs.writeFileSync(path.join(OUT_KB, file), body);
  manifest.push({ id: a.id, file, title: a.title, url: a.url, type: a.article_type, reason, chars: body.length });
};
for (const id of required) write(byId.get(id), "answers-test-question");
for (const a of distractors) write(a, "distractor");

fs.writeFileSync(path.join(ROOT, "data/kb-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const [name, rows] of Object.entries(evalSets)) {
  const withFiles = rows.map((r) => ({
    ...r,
    files: (r.article_ids ?? []).map((id) => manifest.find((m) => m.id === id).file),
  }));
  fs.writeFileSync(path.join(OUT_EVAL, `${name}.jsonl`), withFiles.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const total = manifest.reduce((s, m) => s + m.chars, 0);
const types = manifest.reduce((o, m) => ((o[m.type] = (o[m.type] ?? 0) + 1), o), {});
console.log(`articles: ${manifest.length} (${required.size} required + ${distractors.length} distractors)`);
console.log(`types:    ${JSON.stringify(types)}`);
console.log(`size:     ${(total / 1e6).toFixed(2)} MB of text, largest ${Math.max(...manifest.map((m) => m.chars))} chars`);
console.log(`eval:     ${Object.entries(evalSets).map(([k, v]) => `${k}=${v.length}`).join(", ")} questions`);
