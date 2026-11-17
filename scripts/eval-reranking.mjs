// Reranking check: is the managed knowledge base already reranking, and does turning it on help?
// Searches a seeded sample of WixQA questions three ways (10 chunks, top 5 articles, like the app):
//   default - rerankingModelType left out (what the app sends today)
//   MANAGED - the service's managed reranker
//   NONE    - reranking turned off
// If "default" orders articles exactly like MANAGED, reranking is already on.
//
// Run: npm run eval:reranking          (app's search-only BAWS_* key; 3 searches per question)
//      RERANK_SAMPLE=400 npm run eval:reranking   for every question
// Out: data/eval/results/reranking.jsonl          per question: article order per mode (no text)
//      data/eval/results/reranking-summary.json   metrics per mode + how often orders match
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data/eval/results");
const CHUNKS = 10; // same as the app
const KEPT = 5;
const SHOWN = 3;
const SAMPLE = Number(process.env.RERANK_SAMPLE) || 100;
const SEED = 20261117;
const MODES = ["default", "MANAGED", "NONE"];
const CONCURRENCY = 3;

const { BAWS_ACCESS_KEY_ID: id, BAWS_SECRET_ACCESS_KEY: secret, KNOWLEDGE_BASE_ID: kbId } = process.env;
if (!id || !secret || !kbId) {
  console.error("Missing BAWS_ACCESS_KEY_ID / BAWS_SECRET_ACCESS_KEY / KNOWLEDGE_BASE_ID in .env.local");
  process.exit(1);
}
const client = new BedrockAgentRuntimeClient({
  region: process.env.BAWS_REGION || "us-east-1",
  credentials: { accessKeyId: id, secretAccessKey: secret },
});

const fileOf = (r) => decodeURIComponent((r.location?.s3Location?.uri ?? "").split("/").pop() || "");

async function retrieve(text, mode, attempt = 0) {
  const managedSearchConfiguration = { numberOfResults: CHUNKS };
  if (mode !== "default") managedSearchConfiguration.rerankingModelType = mode;
  try {
    const t = Date.now();
    const res = await client.send(
      new RetrieveCommand({
        knowledgeBaseId: kbId,
        retrievalQuery: { text: text.slice(0, 1000) },
        retrievalConfiguration: { managedSearchConfiguration },
      }),
    );
    return { results: res.retrievalResults ?? [], ms: Date.now() - t };
  } catch (err) {
    if (attempt < 5 && /Throttl|TooManyRequests|ServiceUnavailable/i.test(err?.name ?? "")) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return retrieve(text, mode, attempt + 1);
    }
    throw err;
  }
}

// Seeded shuffle (mulberry32) so the sample is reproducible; half from each question set
function shuffled(items, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const questions = ["expertwritten", "simulated"].flatMap((set) =>
  shuffled(
    fs
      .readFileSync(path.join(ROOT, `data/eval/${set}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l, i) => ({ set, idx: i, ...JSON.parse(l) })),
    SEED,
  ).slice(0, Math.ceil(SAMPLE / 2)),
);

// One mode first, on one question, so an access error stops the run before it spends anything more
for (const mode of MODES) {
  try {
    await retrieve(questions[0].question, mode);
  } catch (err) {
    console.error(`Mode ${mode} failed on the first question: ${err.name}: ${err.message}`);
    process.exit(1);
  }
}

console.log(`Reranking check: ${questions.length} questions x ${MODES.length} modes, knowledge base ${kbId}…`);
const rows = new Array(questions.length);
let done = 0;
const started = Date.now();
async function worker(queue) {
  for (let i = queue.next(); i !== undefined; i = queue.next()) {
    const q = questions[i];
    const row = { set: q.set, idx: q.idx, expected: q.files, articles: {}, scores: {}, ms: {} };
    for (const mode of MODES) {
      const { results, ms } = await retrieve(q.question, mode);
      const articles = [];
      const scores = [];
      for (const r of results) {
        const f = fileOf(r);
        if (f && !articles.includes(f)) {
          articles.push(f);
          scores.push(Math.round((r.score ?? 0) * 1000) / 1000);
        }
      }
      row.articles[mode] = articles;
      row.scores[mode] = scores;
      row.ms[mode] = ms;
    }
    rows[i] = row;
    done++;
    if (done % 25 === 0 || done === questions.length) console.log(`  ${done}/${questions.length}`);
  }
}
const order = questions.map((_, i) => i);
const queue = { next: () => order.shift() };
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// ---- Metrics (computed in code) -----------------------------------------------------------
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function summarize(rs, mode) {
  const ranks = rs.map((r) => r.articles[mode].slice(0, KEPT).findIndex((f) => r.expected.includes(f)) + 1);
  return {
    questions: rs.length,
    hit_at_1_pct: pct(ranks.filter((k) => k === 1).length, rs.length),
    hit_at_3_shown_pct: pct(ranks.filter((k) => k >= 1 && k <= SHOWN).length, rs.length),
    hit_in_kept_articles_pct: pct(ranks.filter((k) => k >= 1).length, rs.length),
    mrr: round(mean(ranks.map((k) => (k ? 1 / k : 0)))),
    median_latency_ms: median(rs.map((r) => r.ms[mode])),
  };
}

const agreement = Object.fromEntries(
  MODES.filter((m) => m !== "default").map((m) => [
    m,
    {
      same_top_5_article_order_pct: pct(rows.filter((r) => same(r.articles.default.slice(0, KEPT), r.articles[m].slice(0, KEPT))).length, rows.length),
      same_first_article_pct: pct(rows.filter((r) => r.articles.default[0] === r.articles[m][0]).length, rows.length),
      same_scores_pct: pct(rows.filter((r) => same(r.scores.default, r.scores[m])).length, rows.length),
    },
  ]),
);

const summary = {
  run_at: new Date().toISOString(),
  knowledge_base_id: kbId,
  settings: { chunks_retrieved: CHUNKS, articles_kept: KEPT, sources_shown: SHOWN, sample: rows.length, seed: SEED },
  searches_made: rows.length * MODES.length + MODES.length,
  by_mode: Object.fromEntries(MODES.map((m) => [m, summarize(rows, m)])),
  default_compared_with: agreement,
  wall_clock_seconds: Math.round((Date.now() - started) / 1000),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "reranking.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(path.join(OUT_DIR, "reranking-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ by_mode: summary.by_mode, default_compared_with: agreement }, null, 2));
