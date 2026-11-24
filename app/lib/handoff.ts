// Server-only: turns an escalated conversation into a support ticket for a human agent.
// This is a mock help desk. Tickets are stored in Upstash Redis (the same store as the rate
// limits) and listed for the owner at GET /api/handoff; no real agent is notified.
import crypto from "crypto";
import { getRedis } from "@/app/lib/access";
import { clip } from "@/app/lib/signals";
import customerSupportCategories from "@/app/lib/customer_support_categories.json";
import { FEEDBACK_REASONS, type StuckReason } from "@/app/lib/feedback-reasons";

// Sent when the customer said an answer didn't fix it and then asked for a person
export interface StuckReport {
  reason: StuckReason | null;
  steps_done: number;
  steps_total: number;
}

export type HandoffPriority = "urgent" | "high" | "normal";

export interface HandoffTicket {
  id: string;
  created_at: string;
  status: "queued";
  queue: string;
  priority: HandoffPriority;
  priority_reason: string;
  escalation_reason: string;
  user_mood: string;
  categories: string[];
  // What the agent reads first, so the customer doesn't have to repeat themselves
  summary: string;
  transcript: { role: "user" | "assistant"; text: string }[];
  requested_by: "visitor" | "owner";
  // How far the customer got with the last answer's steps, when they said it didn't fix it
  customer_progress?: string;
}

const TICKETS_KEY = "csa:handoff:tickets";
const MAX_STORED_TICKETS = 100;
const MAX_TRANSCRIPT_CHARS = 2000;

const QUEUES: Record<string, string> = {
  account: "Account & Security",
  billing: "Billing",
  payments: "Payments",
  domains_email: "Domains & Email",
  technical: "Technical Support",
};
const DEFAULT_QUEUE = "General Support";

const categoryName = (id: string) =>
  customerSupportCategories.categories.find((c) => c.id === id)?.name ?? id;

// Words that mean money, access or legal exposure is at stake right now
const URGENT_TERMS =
  /\b(hack(ed)?|compromised|stolen|fraud\w*|unauthori[sz]ed|phishing|scam\w*|lawsuit|lawyer|legal action|subpoena|identity theft)\b/i;

// Assistant turns are stored by the client as the whole JSON reply
type ReplyFields = {
  response?: string;
  user_mood?: string;
  matched_categories?: string[];
  redirect_to_agent?: { should_redirect?: boolean; reason?: string };
};
export function parseReply(content: string): ReplyFields | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function pickPriority(
  userText: string,
  reason: string,
  mood: string,
  categories: string[],
): { priority: HandoffPriority; why: string } {
  const urgentMatch = `${userText}\n${reason}`.match(URGENT_TERMS);
  if (urgentMatch) return { priority: "urgent", why: `Mentions "${urgentMatch[0].toLowerCase()}"` };
  if (mood === "frustrated" || mood === "negative") return { priority: "high", why: `Customer seems ${mood}` };
  const moneyCategory = categories.find((c) => c === "billing" || c === "payments");
  if (moneyCategory) return { priority: "high", why: `${categoryName(moneyCategory)} issue` };
  return { priority: "normal", why: "No urgency signals" };
}

export function buildTicket(
  messages: { role: "user" | "assistant"; content: string }[],
  requestedBy: HandoffTicket["requested_by"],
  stuck?: StuckReport,
): HandoffTicket {
  const transcript = messages.map((m) => {
    const reply = m.role === "assistant" ? parseReply(m.content) : null;
    const text = reply?.response ?? m.content;
    return { role: m.role, text: clip(text, MAX_TRANSCRIPT_CHARS) };
  });

  const lastReply = [...messages].reverse().map((m) => (m.role === "assistant" ? parseReply(m.content) : null)).find(Boolean) ?? {};
  const reason = stuck
    ? `Customer said the answer didn't fix it${stuck.reason ? ` (${FEEDBACK_REASONS[stuck.reason].toLowerCase()})` : ""}`
    : lastReply.redirect_to_agent?.reason?.trim() || "Customer asked to talk to a person";
  const progress =
    stuck && stuck.steps_total > 0
      ? `Ticked off ${stuck.steps_done} of ${stuck.steps_total} steps in the last answer.`
      : undefined;
  const mood = lastReply.user_mood ?? "neutral";
  const categories = (lastReply.matched_categories ?? []).filter((c) =>
    customerSupportCategories.categories.some((known) => known.id === c),
  );

  const userTurns = transcript.filter((t) => t.role === "user").map((t) => t.text);
  const { priority, why } = pickPriority(userTurns.join("\n"), reason, mood, categories);

  const firstQuestion = clip(userTurns[0] ?? "", 300);
  const latestQuestion = clip(userTurns[userTurns.length - 1] ?? "", 300);
  const summary = [
    `Customer asked: "${firstQuestion}"`,
    userTurns.length > 1 ? `Latest message: "${latestQuestion}"` : null,
    stuck ? `Handed off because: ${reason}` : `The assistant handed off because: ${reason}`,
    progress ?? null,
    `${userTurns.length} customer message${userTurns.length === 1 ? "" : "s"} in the conversation; mood: ${mood}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: `SUP-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    created_at: new Date().toISOString(),
    status: "queued",
    queue: QUEUES[categories[0] ?? ""] ?? DEFAULT_QUEUE,
    priority,
    priority_reason: why,
    escalation_reason: reason,
    user_mood: mood,
    categories,
    summary,
    transcript,
    requested_by: requestedBy,
    ...(progress ? { customer_progress: progress } : {}),
  };
}

// Newest first; only the latest MAX_STORED_TICKETS are kept. Returns false when nothing is stored.
export async function saveTicket(ticket: HandoffTicket): Promise<boolean> {
  const store = getRedis();
  if (!store) return false;
  await store.lpush(TICKETS_KEY, JSON.stringify(ticket));
  await store.ltrim(TICKETS_KEY, 0, MAX_STORED_TICKETS - 1);
  return true;
}

export async function listTickets(limit = 50): Promise<HandoffTicket[] | null> {
  const store = getRedis();
  if (!store) return null;
  const raw = await store.lrange<HandoffTicket | string>(TICKETS_KEY, 0, limit - 1);
  return raw.map((t) => (typeof t === "string" ? (JSON.parse(t) as HandoffTicket) : t));
}
