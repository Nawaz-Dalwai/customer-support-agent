// Follow-up evaluation: does searching with the previous question help two-message conversations?
// Runs the synthetic cases in data/eval/followups.jsonl through two searches each, 10 chunks
// kept to the top 5 articles (the app's setting), and scores three ways of building the search:
//   current   - the latest message alone (what the app does today)
//   combined  - latest message + the previous user message (option A)
//   merged    - both searches above, articles merged by reciprocal rank fusion (option B)
//
// Run: npm run eval:followups   (app's search-only BAWS_* key; 2 searches per case, ~$1 per 1,000)
// Out: data/eval/results/followups.jsonl          per case: article order per setup (no article text)
//      data/eval/results/followups-summary.json   metrics per setup and case type, computed here
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data/eval/results");
const CHUNKS = 10; // same as the app
const KEPT = 5; // articles sent to Claude
const SHOWN = 3; // sources shown
const MAX_QUERY_CHARS = 1000; // same cut-off as the app
const RRF_K = 60; // standard reciprocal rank fusion constant
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

const fileOf = (r) => decodeURIComponent((r.location?.s3Location?.uri ?? "").split("/").pop() || "");

async function retrieve(text, attempt = 0) {
  try {
    const res = await client.send(
      new RetrieveCommand({
        knowledgeBaseId: kbId,
        retrievalQuery: { text: text.slice(0, MAX_QUERY_CHARS) },
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

// Chunks -> distinct articles in order of their best chunk
const articlesOf = (results) => {
  const out = [];
  for (const r of results) {
    const f = fileOf(r);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
};

// Reciprocal rank fusion: an article ranked well in either list rises; ties keep "current" order
const fuse = (...lists) => {
  const score = new Map();
  for (const list of lists) list.forEach((f, i) => score.set(f, (score.get(f) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score.keys()].sort((a, b) => score.get(b) - score.get(a));
};

const lines = fs.readFileSync(path.join(ROOT, "data/eval/followups.jsonl"), "utf8").trim().split("\n");
const cases = lines.map((l) => JSON.parse(l)).filter((c) => c.id);

// Topic switches: the previous question's own articles, to measure old-topic articles leaking in
const sourceFiles = {};
for (const set of ["expertwritten", "simulated"]) {
  fs.readFileSync(path.join(ROOT, `data/eval/${set}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .forEach((l, i) => (sourceFiles[`${set}:${i}`] = JSON.parse(l).files));
}

console.log(`Follow-up eval: ${cases.length} cases, ${cases.length * 2} searches, knowledge base ${kbId}…`);
const rows = new Array(cases.length);
let done = 0;
const started = Date.now();
async function worker(queue) {
  for (let i = queue.next(); i !== undefined; i = queue.next()) {
    const c = cases[i];
    const [previous, latest] = c.messages;
    const [latestOnly, combinedResults] = await Promise.all([
      retrieve(latest),
      retrieve(`${latest}\n${previous}`), // latest first so the cut-off never drops it
    ]);
    const current = articlesOf(latestOnly);
    const combined = articlesOf(combinedResults);
    rows[i] = {
      id: c.id,
      type: c.type,
      area: c.area,
      expected: c.expected,
      previous_expected: c.previous_source
        ? sourceFiles[`${c.previous_source.set}:${c.previous_source.idx}`] ?? []
        : [],
      articles: { current, combined, merged: fuse(current, combined) },
    };
    done++;
    if (done % 20 === 0 || done === cases.length) console.log(`  ${done}/${cases.length}`);
  }
}
const order = cases.map((_, i) => i);
const queue = { next: () => order.shift() };
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// ---- Metrics (computed in code) -----------------------------------------------------------
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const SETUPS = ["current", "combined", "merged"];

function summarize(rs, setup) {
  const s = rs.map((r) => {
    const kept = r.articles[setup].slice(0, KEPT);
    const rank = kept.findIndex((f) => r.expected.includes(f)) + 1;
    return {
      rank,
      allFound: r.expected.every((f) => kept.includes(f)),
      oldTopic: kept.filter((f) => r.previous_expected.includes(f) && !r.expected.includes(f)).length,
    };
  });
  const multi = rs.map((r, i) => [r, s[i]]).filter(([r]) => r.expected.length > 1);
  return {
    cases: rs.length,
    hit_at_1_pct: pct(s.filter((x) => x.rank === 1).length, rs.length),
    hit_at_3_shown_pct: pct(s.filter((x) => x.rank >= 1 && x.rank <= SHOWN).length, rs.length),
    hit_in_kept_articles_pct: pct(s.filter((x) => x.rank >= 1).length, rs.length),
    mrr: round(mean(s.map((x) => (x.rank ? 1 / x.rank : 0)))),
    multi_article_cases: multi.length,
    multi_article_all_found_pct: pct(multi.filter(([, x]) => x.allFound).length, multi.length),
    // Topic switches only: kept articles that belong to the earlier, unrelated question
    cases_with_old_topic_article_pct: pct(s.filter((x) => x.oldTopic > 0).length, rs.length),
  };
}

const byType = Object.fromEntries(
  ["followup", "topic_switch"].map((t) => [
    t,
    Object.fromEntries(SETUPS.map((setup) => [setup, summarize(rows.filter((r) => r.type === t), setup)])),
  ]),
);
const overall = Object.fromEntries(SETUPS.map((setup) => [setup, summarize(rows, setup)]));

const summary = {
  run_at: new Date().toISOString(),
  knowledge_base_id: kbId,
  note:
    "Synthetic two-message cases (see data/eval/followups.jsonl). current = latest message only; combined = latest + previous user message; merged = reciprocal rank fusion of the two searches.",
  settings: { chunks_retrieved: CHUNKS, articles_kept: KEPT, sources_shown: SHOWN, rrf_k: RRF_K },
  searches_made: rows.length * 2,
  by_type: byType,
  overall,
  wall_clock_seconds: Math.round((Date.now() - started) / 1000),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "followups.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(path.join(OUT_DIR, "followups-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.table(
  ["followup", "topic_switch"].flatMap((t) =>
    SETUPS.map((setup) => {
      const m = byType[t][setup];
      return {
        cases: t,
        setup,
        "hit@1 %": m.hit_at_1_pct,
        "hit@3 %": m.hit_at_3_shown_pct,
        "in kept %": m.hit_in_kept_articles_pct,
        mrr: m.mrr,
        "old topic %": m.cases_with_old_topic_article_pct,
      };
    }),
  ),
);
