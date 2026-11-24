// Mock human handoff. POST turns the conversation into a queued ticket; GET lists recent
// tickets for the owner (the "agent queue"). No real agent is notified.
import { z } from "zod/v4";
import { clientIp, consumePublicHandoff, isOwner } from "@/app/lib/access";
import { buildTicket, listTickets, saveTicket } from "@/app/lib/handoff";
import { STUCK_REASONS } from "@/app/lib/feedback-reasons";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20000),
      }),
    )
    .min(2)
    .max(40),
  // Present when the customer clicked "Still stuck" and then "Talk to a person"
  stuck: z
    .object({
      reason: z.enum(STUCK_REASONS).nullable(),
      steps_done: z.int().min(0).max(50),
      steps_total: z.int().min(0).max(50),
    })
    .refine((s) => s.steps_done <= s.steps_total)
    .optional(),
});

export async function POST(req: Request) {
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { messages, stuck } = parsed.data;
  if (!messages.some((m) => m.role === "user")) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const owner = isOwner(req);
  if (!owner) {
    const limit = await consumePublicHandoff(clientIp(req));
    if (!limit.allowed) {
      const error =
        limit.denyReason === "store_unavailable"
          ? "Connecting to an agent is unavailable right now. Please try again later."
          : "You've reached the demo's limit for agent requests today. Please try again tomorrow.";
      return Response.json(
        { error },
        { status: limit.denyReason === "store_unavailable" ? 503 : 429 },
      );
    }
  }

  const ticket = buildTicket(messages, owner ? "owner" : "visitor", stuck);
  let stored = false;
  try {
    stored = await saveTicket(ticket);
  } catch (error) {
    console.error("Handoff ticket not stored:", error);
  }
  console.log("🎫 Handoff ticket", { id: ticket.id, queue: ticket.queue, priority: ticket.priority, stored });

  return Response.json({ ticket, stored });
}

export async function GET(req: Request) {
  if (!isOwner(req)) {
    return Response.json({ error: "Owner sign-in required" }, { status: 401 });
  }
  const tickets = await listTickets();
  if (tickets === null) {
    return Response.json({ error: "Ticket store is not configured" }, { status: 503 });
  }
  return Response.json({ tickets }, { headers: { "Cache-Control": "no-store" } });
}
