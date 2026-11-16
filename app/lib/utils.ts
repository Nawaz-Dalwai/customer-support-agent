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

export async function retrieveContext(
  query: string,
  knowledgeBaseId: string | undefined,
  numberOfResults = 5,
  maxSources = 3,
): Promise<{ context: string; isRagWorking: boolean; ragSources: RAGSource[] }> {
  const empty = { context: "", isRagWorking: false, ragSources: [] };
  if (!knowledgeBaseId) {
    console.error("KNOWLEDGE_BASE_ID is not set");
    return empty;
  }

  try {
    const response = await getClient().send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: query.slice(0, MAX_QUERY_CHARS) },
        // Managed knowledge bases reject vectorSearchConfiguration
        retrievalConfiguration: { managedSearchConfiguration: { numberOfResults } },
      }),
    );

    const results = (response.retrievalResults ?? []).filter(
      (r): r is KnowledgeBaseRetrievalResult & { content: { text: string } } => !!r.content?.text,
    );

    // Several chunks often come from the same article: show each article once (best score first)
    const seen = new Set<string>();
    const ragSources: RAGSource[] = [];
    results.forEach((r, i) => {
      const uri = r.location?.s3Location?.uri ?? "";
      const key = uri || `chunk-${i}`;
      if (seen.has(key)) return;
      seen.add(key);
      ragSources.push({
        id: String(r.metadata?._chunk_id ?? r.metadata?.["x-amz-bedrock-kb-chunk-id"] ?? key),
        fileName: prettyFileName(uri, i),
        snippet: r.content.text,
        score: r.score ?? 0,
        url: sourceUrl(r.content.text),
      });
    });

    const context = results
      .map((r, i) => `<document index="${i + 1}">\n${r.content.text}\n</document>`)
      .join("\n");

    return { context, isRagWorking: true, ragSources: ragSources.slice(0, maxSources) };
  } catch (error) {
    console.error("RAG Error:", error);
    return empty;
  }
}
