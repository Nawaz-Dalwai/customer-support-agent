// Smoke test: can the app's own AWS keys search the knowledge base?
// Run with: npm run test:kb
//
// Uses ONLY the BAWS_* keys from .env.local (passed explicitly, like the app does),
// so it can't accidentally succeed through your admin CLI profile.
// Prints file names and scores only, never article text or keys.
import fs from "node:fs";
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

const REGION = "us-east-1";
const N_QUESTIONS = 10;

const { BAWS_ACCESS_KEY_ID: id, BAWS_SECRET_ACCESS_KEY: secret, KNOWLEDGE_BASE_ID: kbId } =
  Object.fromEntries(
    ["BAWS_ACCESS_KEY_ID", "BAWS_SECRET_ACCESS_KEY", "KNOWLEDGE_BASE_ID"].map((k) => [
      k,
      process.env[k]?.trim(),
    ]),
  );

const missing = Object.entries({ BAWS_ACCESS_KEY_ID: id, BAWS_SECRET_ACCESS_KEY: secret, KNOWLEDGE_BASE_ID: kbId })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`❌ Missing in .env.local: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`🔑 App key found (${id.slice(0, 4)}…${id.slice(-4)}), knowledge base ${kbId}`);

const client = new BedrockAgentRuntimeClient({
  region: REGION,
  credentials: { accessKeyId: id, secretAccessKey: secret },
});

// Managed knowledge bases need managedSearchConfiguration (vectorSearchConfiguration is rejected)
const retrieve = (text, n = 3) =>
  client.send(
    new RetrieveCommand({
      knowledgeBaseId: kbId,
      retrievalQuery: { text },
      retrievalConfiguration: { managedSearchConfiguration: { numberOfResults: n } },
    }),
  );
const fileOf = (r) => (r.location?.s3Location?.uri ?? "").split("/").pop() || "(no uri)";

const questions = fs
  .readFileSync(new URL("../data/eval/expertwritten.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .slice(0, N_QUESTIONS);

try {
  let hit1 = 0, hit3 = 0;
  const start = performance.now();
  for (const [i, q] of questions.entries()) {
    const res = await retrieve(q.question);
    const files = [...new Set((res.retrievalResults ?? []).map(fileOf))];
    const top = (res.retrievalResults ?? [])[0];
    const h1 = q.files.includes(fileOf(top ?? {}));
    const h3 = files.some((f) => q.files.includes(f));
    hit1 += h1; hit3 += h3;
    console.log(
      `${h1 ? "✅" : h3 ? "🟡" : "❌"} Q${i + 1} score ${top?.score?.toFixed(2) ?? "-"}  ${q.question.slice(0, 60)}…`,
    );
  }
  const avg = ((performance.now() - start) / questions.length / 1000).toFixed(2);
  console.log(`\nTop-1 correct: ${hit1}/${questions.length}   In top 3: ${hit3}/${questions.length}   Avg ${avg}s per search`);
} catch (err) {
  const name = err?.name ?? "Error";
  const hints = {
    UnrecognizedClientException: "Access key ID is wrong — re-copy it from the IAM console.",
    InvalidSignatureException: "Secret access key is wrong — re-copy it (it's only shown once; create a new key if lost).",
    AccessDeniedException: "Key works but lacks permission — check you used the customer-support-kb-app user's key and the right KNOWLEDGE_BASE_ID.",
    ResourceNotFoundException: "KNOWLEDGE_BASE_ID not found in us-east-1.",
    ValidationException: "Request rejected — see message above.",
  };
  console.error(`❌ Search failed: ${name}\n   ${err?.message}\n   → ${hints[name] ?? "See the error above."}`);
  process.exit(1);
}
