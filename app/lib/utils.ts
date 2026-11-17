// Server-only helpers: knowledge base retrieval (Amazon Bedrock Managed Knowledge Base).
// Client components may import *types* from here (`import type`), never values.
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
} from "@aws-sdk/client-bedrock-agent-runtime";

export interface RAGSource {
  id: string;
  fileName: string;
  snippet: string;
  score: number;
  url?: string;
}

const REGION = process.env.BAWS_REGION || "us-east-1";
const MAX_QUERY_CHARS = 1000;

let client: BedrockAgentRuntimeClient | null = null;

// Built lazily so a missing key surfaces as a clear error on first use, not at import time.
// Keys are passed explicitly (BAWS_* - Amplify rejects env names starting with AWS),
// so the app never silently falls back to a developer's admin CLI profile.
function getClient(): BedrockAgentRuntimeClient {
  if (client) return client;
  const accessKeyId = process.env.BAWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BAWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("BAWS_ACCESS_KEY_ID / BAWS_SECRET_ACCESS_KEY are not set");
  }
  client = new BedrockAgentRuntimeClient({
    region: REGION,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

// "Wix_Payments_Verification_Process.txt" -> "Wix Payments Verification Process"
const prettyFileName = (uri: string, index: number) =>
  (uri.split("/").pop() || `Source ${index + 1}`).replace(/\.txt$/, "").replace(/_/g, " ");

// Each article file starts with "Title\nSource: <url>" - pull the URL out for citations.
const sourceUrl = (text: string) => text.match(/^Source: (https?:\/\/\S+)/m)?.[1];

type Chunk = KnowledgeBaseRetrievalResult & { content: { text: string } };

const articleKey = (r: Chunk, i: number) => r.location?.s3Location?.uri || `chunk-${i}`;
const chunkKey = (r: Chunk) => String(r.metadata?._chunk_id ?? r.metadata?.["x-amz-bedrock-kb-chunk-id"] ?? r.content.text);

async function search(knowledgeBaseId: string, text: string, numberOfResults: number): Promise<Chunk[]> {
  const response = await getClient().send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: text.slice(0, MAX_QUERY_CHARS) },
      // Managed knowledge bases reject vectorSearchConfiguration
      retrievalConfiguration: { managedSearchConfiguration: { numberOfResults } },
    }),
  );
  return (response.retrievalResults ?? []).filter((r): r is Chunk => !!r.content?.text);
}

// Reciprocal rank fusion over each search's article order (60 is the standard constant).
// Ties keep the order of the first list (the latest message on its own).
const RRF_K = 60;
function fuseArticles(lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((key, i) => score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!);
}

// Settings come from the evaluations in data/eval/results/:
// - retrieval-sweep-summary.json: 10 chunks kept to the top 5 articles put the right article in
//   Claude's context for 95% of test questions (vs 90.5% with 5 chunks).
// - followups-summary.json: for follow-up messages, searching the latest message alone AND the
//   latest + previous user message, then merging, reached the right article for 97.5% of
//   follow-ups (vs 72.5% alone) and 92.5% of topic changes (vs 100% alone).
export async function retrieveContext(
  { latest, previous }: { latest: string; previous?: string },
  knowledgeBaseId: string | undefined,
  { numberOfResults = 10, maxArticles = 5, maxSources = 3 } = {},
): Promise<{ context: string; isRagWorking: boolean; ragSources: RAGSource[]; articles: string[] }> {
  const empty = { context: "", isRagWorking: false, ragSources: [], articles: [] };
  if (!knowledgeBaseId) {
    console.error("KNOWLEDGE_BASE_ID is not set");
    return empty;
  }

  // Latest message first in the combined search, so the length cut-off never drops it
  const queries = previous?.trim() ? [latest, `${latest}\n${previous}`] : [latest];
  const settled = await Promise.allSettled(queries.map((q) => search(knowledgeBaseId, q, numberOfResults)));
  settled.forEach((s) => s.status === "rejected" && console.error("RAG Error:", s.reason));
  const searches = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  if (searches.length === 0) return empty;

  // Each search: chunks -> articles in order of their best chunk. Then merge the article lists.
  const articleOrders = searches.map((chunks) => {
    const order: string[] = [];
    chunks.forEach((r, i) => {
      const key = articleKey(r, i);
      if (!order.includes(key)) order.push(key);
    });
    return order;
  });
  const kept = fuseArticles(articleOrders).slice(0, maxArticles);
  const rankOf = new Map(kept.map((key, i) => [key, i]));

  // Every chunk from the kept articles, once, grouped by article rank then best score first.
  // Extra chunks bring in more distinct articles without padding the prompt with weak matches.
  const seen = new Set<string>();
  const chunks: { r: Chunk; key: string }[] = [];
  for (const list of searches) {
    list.forEach((r, i) => {
      const key = articleKey(r, i);
      const id = chunkKey(r);
      if (!rankOf.has(key) || seen.has(id)) return;
      seen.add(id);
      chunks.push({ r, key });
    });
  }
  chunks.sort((a, b) => rankOf.get(a.key)! - rankOf.get(b.key)! || (b.r.score ?? 0) - (a.r.score ?? 0));

  const context = chunks
    .map(({ r }, i) => `<document index="${i + 1}">\n${r.content.text}\n</document>`)
    .join("\n");

  // Sources panel: the top articles, each shown once with its best-scoring chunk
  const ragSources: RAGSource[] = kept.slice(0, maxSources).flatMap((key, i) => {
    const best = chunks.find((c) => c.key === key)?.r;
    if (!best) return [];
    return [
      {
        id: String(best.metadata?._chunk_id ?? best.metadata?.["x-amz-bedrock-kb-chunk-id"] ?? key),
        fileName: prettyFileName(best.location?.s3Location?.uri ?? "", i),
        snippet: best.content.text,
        score: best.score ?? 0,
        url: sourceUrl(best.content.text),
      },
    ];
  });

  // Display order only: with two searches the scores come from different queries, so list the
  // shown sources by score (best match first) rather than by merged rank. Claude's context is unchanged.
  ragSources.sort((a, b) => b.score - a.score);

  // articles: every kept article's name in merged order (used by the evaluation scripts)
  const articles = kept.map((key, i) => prettyFileName(key.startsWith("chunk-") ? "" : key, i));

  return { context, isRagWorking: true, ragSources, articles };
}
