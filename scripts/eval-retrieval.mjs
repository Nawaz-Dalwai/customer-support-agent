// Retrieval evaluation: does the knowledge base return the right help article?
// Runs all WixQA test questions through the same Retrieve call the app makes
// (managed search, 5 chunks, de-duplicated to articles, top 3 shown as sources).
//
// Run: npm run eval:retrieval      (uses the app's search-only BAWS_* key; ~$1 per 1,000 searches)
// Out: data/eval/results/retrieval.jsonl      one row per question (file names + scores, no article text)
//      data/eval/results/retrieval-summary.json  metrics, computed here (not by hand)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data/eval/results");
const CHUNKS = 5; // same as the app
const SHOWN = 3; // sources the app shows
const CONCURRENCY = 4;

const { BAWS_ACCESS_KEY_ID: id, BAWS_SECRET_ACCESS_KEY: secret, KNOWLEDGE_BASE_ID: kbId } = process.env;
if (!id || !secret || !kbId) {
  console.error("Missing BAWS_ACCESS_KEY_ID / BAWS_SECRET_ACCESS_KEY / KNOWLEDGE_BASE_ID in .env.local");
  process.exit(1);
}
const client = new BedrockAgentRuntimeClient({
  region: process.env.BAWS_REGION || "us-east-1",
  credentials: { accessKeyId: id, secretAccessKey: secret },
});

// Keyword-based product area (same idea as the app's support categories), from question + expected article titles.
const AREAS = [
  ["domains_email", /domain|dns|ssl|mailbox|email|google workspace|nameserver/i],
  ["payments", /payment|paypal|payout|checkout|stripe|pos\b|point of sale/i],
  ["billing", /premium|plan\b|plans\b|upgrade|renew|invoice|refund|billing|subscription|voucher|charged|cancel/i],
  ["apps_commerce", /store|product|order|booking|event|hotel|restaurant|pricing plan|discount|coupon|member|form/i],
  ["account", /log ?in|password|account|collaborator|owner|transfer.*site|2-step|verification code/i],
  ["site_editor", /editor|mobile|page|menu|cms|seo|design|template|publish|blog|gallery|text|image|site/i],
];
const areaOf = (text) => AREAS.find(([, re]) => re.test(text))?.[0] ?? "other";

const fileOf = (r) => decodeURIComponent((r.location?.s3Location?.uri ?? "").split("/").pop() || "");

async function retrieve(text, attempt = 0) {
  try {
    const res = await client.send(
      new RetrieveCommand({
        knowledgeBaseId: kbId,
        retrievalQuery: { text: text.slice(0, 1000) },
        retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: CHUNKS } },
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

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/kb-manifest.json"), "utf8"));
const titleOf = Object.fromEntries(manifest.map((m) => [m.file, m.title]));

const questions = ["expertwritten", "simulated"].flatMap((set) =>
  fs
    .readFileSync(path.join(ROOT, `data/eval/${set}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l, i) => ({ set, idx: i, ...JSON.parse(l) })),
);

console.log(`Evaluating ${questions.length} questions against knowledge base ${kbId}…`);
const rows = new Array(questions.length);
let done = 0;
const started = Date.now();
async function worker(queue) {
  for (let i = queue.next(); i !== undefined; i = queue.next()) {
    const q = questions[i];
    const t = Date.now();
    const results = await retrieve(q.question);
    const ms = Date.now() - t;
    // De-duplicate chunks to articles, keeping each article's best score (same as the app)
    const articles = [];
    for (const r of results) {
      const f = fileOf(r);
      if (f && !articles.some((a) => a.file === f)) articles.push({ file: f, score: r.score ?? 0 });
    }
    const expected = q.files;
    const rank = articles.findIndex((a) => expected.includes(a.file)) + 1; // 0 = not found
    rows[i] = {
      set: q.set,
      idx: q.idx,
      question: q.question,
      area: areaOf([q.question, ...expected.map((f) => titleOf[f] ?? f)].join(" ")),
      expected,
      retrieved: articles,
      first_correct_rank: rank,
      hit_at_1: rank === 1,
      hit_at_shown: rank >= 1 && rank <= SHOWN,
      hit_at_chunks: rank >= 1,
      expected_found: expected.filter((f) => articles.some((a) => a.file === f)).length,
      top_score: articles[0]?.score ?? 0,
      latency_ms: ms,
    };
    done++;
    if (done % 50 === 0 || done === questions.length) console.log(`  ${done}/${questions.length}`);
  }
}
const order = questions.map((_, i) => i);
const queue = { next: () => order.shift() };
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// ---- Metrics (computed in code) --------------------------------------------------------
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function summarize(rs) {
  const n = rs.length;
  const multi = rs.filter((r) => r.expected.length > 1);
  return {
    questions: n,
    hit_at_1_pct: pct(rs.filter((r) => r.hit_at_1).length, n),
    hit_at_3_shown_pct: pct(rs.filter((r) => r.hit_at_shown).length, n),
    hit_in_retrieved_chunks_pct: pct(rs.filter((r) => r.hit_at_chunks).length, n),
    mrr: round(mean(rs.map((r) => (r.first_correct_rank ? 1 / r.first_correct_rank : 0)))),
    multi_article_questions: multi.length,
    multi_article_all_found_pct: pct(multi.filter((r) => r.expected_found === r.expected.length).length, multi.length),
  };
}

const bySet = Object.fromEntries(["expertwritten", "simulated"].map((s) => [s, summarize(rows.filter((r) => r.set === s))]));
const areas = [...new Set(rows.map((r) => r.area))].sort();
const byArea = Object.fromEntries(
  areas.map((a) => [a, summarize(rows.filter((r) => r.area === a))]).sort((x, y) => y[1].questions - x[1].questions),
);

// Does the top score predict a miss? (useful for a confidence-based escalation rule)
const hitScores = rows.filter((r) => r.hit_at_1).map((r) => r.top_score);
const missScores = rows.filter((r) => !r.hit_at_shown).map((r) => r.top_score);
const thresholds = [0.4, 0.5, 0.6, 0.7].map((t) => {
  const below = rows.filter((r) => r.top_score < t);
  return {
    threshold: t,
    questions_below_pct: pct(below.length, rows.length),
    of_those_missed_in_sources_pct: pct(below.filter((r) => !r.hit_at_shown).length, below.length),
    misses_caught_pct: pct(below.filter((r) => !r.hit_at_shown).length, rows.filter((r) => !r.hit_at_shown).length),
  };
});

const summary = {
  run_at: new Date().toISOString(),
  knowledge_base_id: kbId,
  settings: { chunks_retrieved: CHUNKS, sources_shown: SHOWN },
  overall: summarize(rows),
  by_set: bySet,
  by_area: byArea,
  top_score: {
    median_when_correct_at_1: round(median(hitScores)),
    median_when_missed_in_sources: round(median(missScores)),
    thresholds,
  },
  latency_ms: { median: median(rows.map((r) => r.latency_ms)), mean: round(mean(rows.map((r) => r.latency_ms)), 0) },
  wall_clock_seconds: Math.round((Date.now() - started) / 1000),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "retrieval.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(path.join(OUT_DIR, "retrieval-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
