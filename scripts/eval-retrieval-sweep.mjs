// Retrieval sweep: how many chunks should the app fetch, and how many articles should it keep?
// Fetches MAX_CHUNKS chunks once per question (one search each), then scores every setting
// from that single list: "fetch the first K chunks, de-duplicate to articles, keep the top A".
// Taking the first K of a 20-result search approximates a K-result search; the K=5 row is
// checked against the baseline run (eval:retrieval) to confirm that.
//
// Run: npm run eval:retrieval:sweep   (app's search-only BAWS_* key; 400 searches, ~$1 per 1,000)
// Out: data/eval/results/retrieval-sweep.jsonl          per question: chunk order (file + score + length), no text
//      data/eval/results/retrieval-sweep-summary.json   one row of metrics per setting, computed here
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data/eval/results");
const MAX_CHUNKS = 20;
const CHUNK_SETTINGS = [5, 10, 15, 20]; // chunks fetched
const ARTICLE_SETTINGS = [3, 5]; // distinct articles kept and sent to Claude
const CONCURRENCY = 4;
const LIMIT = Number(process.env.SWEEP_LIMIT) || Infinity; // e.g. SWEEP_LIMIT=1 for a smoke test

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

async function retrieve(text, attempt = 0) {
  try {
    const res = await client.send(
      new RetrieveCommand({
        knowledgeBaseId: kbId,
        retrievalQuery: { text: text.slice(0, 1000) },
        retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: MAX_CHUNKS } },
      }),
    );
    return res.retrievalResults ?? [];
  } catch (err) {
    if (attempt < 5 && /Throttl|TooManyRequests|ServiceUnavailable/i.test(err?.name ?? "")) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return retrieve(text, attempt + 1);
    }
    throw err;
  }
}

const questions = ["expertwritten", "simulated"]
  .flatMap((set) =>
    fs
      .readFileSync(path.join(ROOT, `data/eval/${set}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l, i) => ({ set, idx: i, ...JSON.parse(l) })),
  )
  .slice(0, LIMIT);

console.log(`Sweep: ${questions.length} questions, ${MAX_CHUNKS} chunks each, knowledge base ${kbId}…`);
const rows = new Array(questions.length);
let done = 0;
const started = Date.now();
async function worker(queue) {
  for (let i = queue.next(); i !== undefined; i = queue.next()) {
    const q = questions[i];
    const results = await retrieve(q.question);
    rows[i] = {
      set: q.set,
      idx: q.idx,
      expected: q.files,
      chunks: results.map((r) => ({
        file: fileOf(r),
        score: r.score ?? 0,
        chars: r.content?.text?.length ?? 0,
      })),
    };
    done++;
    if (done % 50 === 0 || done === questions.length) console.log(`  ${done}/${questions.length}`);
  }
}
const order = questions.map((_, i) => i);
const queue = { next: () => order.shift() };
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// ---- Scoring (computed in code) -----------------------------------------------------------
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// Simulates the app for one setting: first `k` chunks -> articles in order of their best chunk ->
// keep the top `a` articles and send Claude every fetched chunk that belongs to them.
function score(row, k, a) {
  const chunks = row.chunks.slice(0, k);
  const articles = [];
  for (const c of chunks) if (c.file && !articles.includes(c.file)) articles.push(c.file);
  const kept = articles.slice(0, a);
  const rank = kept.findIndex((f) => row.expected.includes(f)) + 1; // 0 = not kept
  const sent = chunks.filter((c) => kept.includes(c.file));
  return {
    rank,
    distinct: articles.length,
    allFound: row.expected.every((f) => kept.includes(f)),
    sentChunks: sent.length,
    sentChars: sent.reduce((s, c) => s + c.chars, 0),
  };
}

function summarize(rs, k, a) {
  const s = rs.map((r) => score(r, k, a));
  const multi = rs.map((r, i) => [r, s[i]]).filter(([r]) => r.expected.length > 1);
  return {
    chunks_fetched: k,
    articles_kept: a,
    questions: rs.length,
    hit_at_1_pct: pct(s.filter((x) => x.rank === 1).length, rs.length),
    hit_at_3_pct: pct(s.filter((x) => x.rank >= 1 && x.rank <= 3).length, rs.length),
    hit_in_kept_articles_pct: pct(s.filter((x) => x.rank >= 1).length, rs.length),
    mrr: round(mean(s.map((x) => (x.rank ? 1 / x.rank : 0)))),
    multi_article_all_found_pct: pct(multi.filter(([, x]) => x.allFound).length, multi.length),
    mean_distinct_articles_fetched: round(mean(s.map((x) => x.distinct)), 2),
    mean_chunks_sent_to_claude: round(mean(s.map((x) => x.sentChunks)), 2),
    mean_chars_sent_to_claude: Math.round(mean(s.map((x) => x.sentChars))),
  };
}

const settings = CHUNK_SETTINGS.flatMap((k) => ARTICLE_SETTINGS.map((a) => summarize(rows, k, a)));
const bySet = Object.fromEntries(
  ["expertwritten", "simulated"].map((set) => [
    set,
    CHUNK_SETTINGS.flatMap((k) => ARTICLE_SETTINGS.map((a) => summarize(rows.filter((r) => r.set === set), k, a))),
  ]),
);

// The app today: 5 chunks, all of them sent, top 3 articles shown (= 5 chunks, keep up to 5 articles).
const currentApp = summarize(rows, 5, 5);

const summary = {
  run_at: new Date().toISOString(),
  knowledge_base_id: kbId,
  note:
    "One 20-chunk search per question; smaller settings use the first K chunks of it. Compare the 5-chunk row with retrieval-summary.json (a real 5-chunk search) to check the approximation.",
  searches_made: rows.length,
  chunks_returned: { min: Math.min(...rows.map((r) => r.chunks.length)), max: Math.max(...rows.map((r) => r.chunks.length)) },
  current_app_equivalent: currentApp,
  settings,
  by_set: bySet,
  wall_clock_seconds: Math.round((Date.now() - started) / 1000),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const suffix = Number.isFinite(LIMIT) ? "-smoke" : "";
fs.writeFileSync(path.join(OUT_DIR, `retrieval-sweep${suffix}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(path.join(OUT_DIR, `retrieval-sweep${suffix}-summary.json`), JSON.stringify(summary, null, 2) + "\n");
console.table(
  settings.map(({ chunks_fetched, articles_kept, hit_at_1_pct, hit_at_3_pct, hit_in_kept_articles_pct, mrr, mean_chars_sent_to_claude }) => ({
    chunks: chunks_fetched,
    articles: articles_kept,
    "hit@1 %": hit_at_1_pct,
    "hit@3 %": hit_at_3_pct,
    "in kept %": hit_in_kept_articles_pct,
    mrr,
    "chars to Claude": mean_chars_sent_to_claude,
  })),
);
