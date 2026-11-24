import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import crypto from "crypto";
import { retrieveContext } from "@/app/lib/utils";
import { MODELS } from "@/app/lib/models";
import {
  OWNER_MAX_MESSAGE_CHARS,
  PUBLIC_MAX_MESSAGE_CHARS,
  PUBLIC_MODEL_ID,
  clientIp,
  consumePublicRequest,
  isOwner,
} from "@/app/lib/access";
import customerSupportCategories from "@/app/lib/customer_support_categories.json";
import { clip, saveSignal } from "@/app/lib/signals";
import {
  DEFAULT_ESCALATION_LEVEL,
  ESCALATION_LEVEL_IDS,
  type EscalationLevel,
} from "@/app/lib/escalation-levels";
import { systemInstructions } from "@/app/lib/chat-prompt";
import { after } from "next/server";

// Opus replies can take ~10-20s; give the serverless function room beyond short platform defaults
export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORY_IDS = customerSupportCategories.categories.map((c) => c.id) as [string, ...string[]];
const MAX_MESSAGES = 40;

// ---- Request validation (everything from the browser is untrusted) ----------------------
const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20000),
      }),
    )
    .min(1)
    .max(MAX_MESSAGES),
  model: z.string(),
  escalation_level: z.enum(ESCALATION_LEVEL_IDS).default(DEFAULT_ESCALATION_LEVEL),
  // Set when this message was sent by "Try again" under a reply the customer said didn't fix it
  retry_of: z.uuid().optional(),
});

// ---- Structured output: Claude's reply must match this schema ----------------------------
// (Replaces the original "prefill `{` and hope" approach - prefill returns a 400 on current models.)
const responseSchema = z.object({
  thinking: z.string().describe("One or two sentences on how you approached the user's question"),
  response: z.string().describe("Your reply to the user, in Markdown"),
  user_mood: z.enum(["positive", "neutral", "negative", "curious", "frustrated", "confused"]),
  suggested_questions: z
    .array(z.string())
    .describe(
      "Up to 3 short follow-up questions the user might ask next that the provided help articles answer; fewer or none if the articles don't support them; empty when redirecting",
    ),
  debug: z.object({
    context_used: z.boolean().describe("True if the retrieved help articles were used in the answer"),
  }),
  matched_categories: z.array(z.enum(CATEGORY_IDS)),
  redirect_to_agent: z.object({
    should_redirect: z.boolean(),
    reason: z.string().describe("Why a human agent is needed; empty string when should_redirect is false"),
  }),
});
type SupportResponse = z.infer<typeof responseSchema>;

// Earlier assistant turns are stored by the client as the whole JSON reply; send Claude only the text.
const toHistoryText = (role: string, content: string) => {
  if (role !== "assistant") return content;
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.response === "string" && parsed.response ? parsed.response : content;
  } catch {
    return content;
  }
};

const PUBLIC_DAILY_LABEL = "10 questions per 24 hours";
// 10 exchanges of a 500-char question plus a typical reply fit comfortably under this
const PUBLIC_MAX_HISTORY_CHARS = 40000;

const hoursUntil = (resetMs: number) => {
  const hours = Math.max(1, Math.ceil((resetMs - Date.now()) / 3_600_000));
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
};

// Shown when the Claude API spend limit (or account credit) is used up
const USAGE_LIMIT_MESSAGE =
  "This demo has reached its monthly AI usage limit, so I can't answer right now. Please check back later.";

// The API reports billing problems as a 402 `billing_error`. A Console spend limit or empty
// credit balance has also been reported as a 400 with an explanatory message, so check both.
// (No typed SDK class covers these, so the 400 case falls back to the message text.)
function isUsageLimitError(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false;
  if (error.status === 402 || error.type === "billing_error") return true;
  return (
    error.status === 400 &&
    /usage limit|spend limit|credit balance is too low/i.test(error.message)
  );
}

const debugHeader =(data: Record<string, unknown>) =>
  JSON.stringify({ msg: "chat route", data, timestamp: new Date().toISOString() })
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, 1000);

const jsonResponse = (body: unknown, status = 200, debug?: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(debug ? { "X-Debug-Data": debugHeader(debug) } : {}),
    },
  });

const fallbackReply = (response: string, reason: string, redirect = false): SupportResponse & { id: string } => ({
  id: crypto.randomUUID(),
  thinking: reason,
  response,
  user_mood: "neutral",
  suggested_questions: [],
  debug: { context_used: false },
  matched_categories: [],
  redirect_to_agent: { should_redirect: redirect, reason: redirect ? reason : "" },
});

export async function POST(req: Request) {
  const started = performance.now();
  const elapsed = () => Number(((performance.now() - started) / 1000).toFixed(2));

  // 1. Validate input
  const parsedRequest = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsedRequest.success) {
    return jsonResponse({ error: "Invalid request" }, 400);
  }
  const { messages, escalation_level: escalationLevel, retry_of: retryOf } = parsedRequest.data;

  // Owner (signed-in browser): any allowed model, no limits. Public visitors: Haiku only,
  // short messages, and a per-IP request quota - all enforced here, not just in the UI.
  const owner = isOwner(req);
  const model = owner ? parsedRequest.data.model : PUBLIC_MODEL_ID;
  const modelConfig = MODELS.find((m) => m.id === model);
  if (!modelConfig) {
    return jsonResponse({ error: "Unsupported model" }, 400);
  }
  const latest = messages[messages.length - 1];
  if (latest.role !== "user" || !latest.content.trim()) {
    return jsonResponse({ error: "Invalid message" }, 400);
  }
  const maxChars = owner ? OWNER_MAX_MESSAGE_CHARS : PUBLIC_MAX_MESSAGE_CHARS;
  if (latest.content.length > maxChars) {
    return jsonResponse(
      fallbackReply(
        `Please keep your message under ${maxChars} characters (this one has ${latest.content.length}).`,
        "Message too long",
      ),
      400,
    );
  }

  // Visitors could otherwise send a long fabricated history to inflate each request's cost
  const historyChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (!owner && historyChars > PUBLIC_MAX_HISTORY_CHARS) {
    return jsonResponse(
      fallbackReply("This conversation is getting long. Please refresh the page to start a new one.", "History too long"),
      400,
    );
  }

  let remaining: number | null = null;
  if (!owner) {
    const limit = await consumePublicRequest(clientIp(req));
    if (!limit.allowed) {
      if (limit.denyReason === "store_unavailable") {
        return jsonResponse(
          fallbackReply(
            "The demo is temporarily unavailable. Please try again later.",
            "Rate limit store unavailable",
          ),
          503,
        );
      }
      const message =
        limit.reset != null
          ? `You've used all ${PUBLIC_DAILY_LABEL} for this demo. Please come back in ${hoursUntil(limit.reset)}.`
          : "You've used today's demo questions. Please come back tomorrow.";
      return jsonResponse(
        { ...fallbackReply(message, "Visitor rate limit"), limits: { remaining: 0 } },
        429,
      );
    }
    remaining = limit.remaining;
  }

  // 2. Retrieve help articles (knowledge base ID comes from the server env). For a follow-up,
  //    the user's previous message is searched alongside it so "what if that fails?" keeps its topic.
  const previousUser = messages.slice(0, -1).findLast((m) => m.role === "user")?.content;
  const rag = await retrieveContext({ latest: latest.content, previous: previousUser }, process.env.KNOWLEDGE_BASE_ID);
  const ragSeconds = elapsed();

  const articlesBlock = rag.isRagWorking && rag.context
    ? `Help articles retrieved for the user's latest message:\n<documents>\n${rag.context}\n</documents>`
    : "No help articles were found for the user's latest message.";

  // 3. Ask Claude for a structured reply
  try {
    const response = await client.beta.messages.parse({
      model: modelConfig.id,
      max_tokens: 16000,
      system: [
        { type: "text", text: systemInstructions(escalationLevel) },
        { type: "text", text: articlesBlock },
      ],
      messages: messages.map((m) => ({ role: m.role, content: toHistoryText(m.role, m.content) })),
      output_config: {
        format: betaZodOutputFormat(responseSchema),
        effort: "low", // chat: low effort keeps replies fast; raise if answers need more reasoning
      },
      ...(modelConfig.serverFallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });

    const debug = {
      model: response.model,
      stop_reason: response.stop_reason,
      rag_working: rag.isRagWorking,
      rag_seconds: ragSeconds,
      total_seconds: elapsed(),
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
    console.log("💬 chat", debug);

    // Logged after the response is sent, so a slow or missing store never delays the reply
    const logReply = (reply: SupportResponse & { id: string }, refused: boolean) =>
      after(() =>
        saveSignal({
          id: reply.id,
          created_at: new Date().toISOString(),
          requested_by: owner ? "owner" : "visitor",
          model: response.model,
          escalation_level: escalationLevel,
          ...(retryOf ? { retry_of: retryOf } : {}),
          turn: messages.filter((m) => m.role === "user").length,
          question: clip(latest.content, 1000),
          response: clip(reply.response, 4000),
          user_mood: reply.user_mood,
          matched_categories: reply.matched_categories,
          handed_off: reply.redirect_to_agent.should_redirect,
          handoff_reason: reply.redirect_to_agent.reason,
          context_used: reply.debug.context_used,
          refused,
          rag_working: rag.isRagWorking,
          sources: rag.ragSources.map((s) => ({ file: s.fileName, score: Number(s.score.toFixed(3)) })),
          search_seconds: ragSeconds,
          total_seconds: debug.total_seconds,
          input_tokens: debug.input_tokens,
          output_tokens: debug.output_tokens,
        }).catch((error) => console.error("Reply signal not saved:", error)),
      );

    if (response.stop_reason === "refusal") {
      const reply = fallbackReply(
        "I'm not able to help with that here, so I've passed this conversation to our support team.",
        `Declined by safety checks (${response.stop_details?.category ?? "unspecified"})`,
        true,
      );
      logReply(reply, true);
      return jsonResponse(reply, 200, debug);
    }
    if (!response.parsed_output) {
      console.error("No parsed output; stop_reason:", response.stop_reason);
      return jsonResponse(
        fallbackReply("Sorry, I couldn't put together a reply. Please try again.", "Reply did not match the schema"),
        502,
        debug,
      );
    }

    if (response.parsed_output.redirect_to_agent.should_redirect) {
      console.log("🚨 Agent redirect:", response.parsed_output.redirect_to_agent.reason);
    }

    const reply = { id: crypto.randomUUID(), ...response.parsed_output };
    logReply(reply, false);

    return jsonResponse(
      {
        ...reply,
        rag_sources: rag.ragSources,
        limits: { remaining },
      },
      200,
      debug,
    );
  } catch (error) {
    let status = 500;
    let message = "Sorry, there was an issue processing your request. Please try again later.";
    if (isUsageLimitError(error)) {
      status = 503;
      message = USAGE_LIMIT_MESSAGE;
      console.error("Claude API usage/spend limit reached:", (error as Error).message);
    } else if (error instanceof Anthropic.AuthenticationError) {
      console.error("Anthropic API key rejected");
    } else if (error instanceof Anthropic.RateLimitError) {
      status = 429;
      message = "We're getting a lot of questions right now. Please try again in a moment.";
    } else if (error instanceof Anthropic.BadRequestError) {
      console.error("Bad request to Claude:", error.message);
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
    } else {
      console.error("Chat route error:", error);
    }
    return jsonResponse(fallbackReply(message, "Error during message generation"), status);
  }
}
