// Thumbs up/down on a reply (POST), and the owner's report over the logged reply signals (GET).
// GET /api/feedback                    visitor replies only, summary + every thumbs-down reply
// GET /api/feedback?include_owner=1    also counts the owner's own test conversations
import { z } from "zod/v4";
import { isOwner } from "@/app/lib/access";
import { FEEDBACK_REASONS, type FeedbackReason } from "@/app/lib/feedback-reasons";
import { listSignals, saveFeedback, summarize } from "@/app/lib/signals";

export const dynamic = "force-dynamic";

const reasonIds = Object.keys(FEEDBACK_REASONS) as [FeedbackReason, ...FeedbackReason[]];
const feedbackSchema = z.object({
  id: z.uuid(),
  rating: z.enum(["up", "down"]),
  reason: z.enum(reasonIds).nullable().optional(),
});

export async function POST(req: Request) {
  const parsed = feedbackSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid feedback" }, { status: 400 });
  }
  const { id, rating, reason } = parsed.data;
  try {
    const result = await saveFeedback(id, rating, reason ?? null);
    if (result === "no_store") return Response.json({ error: "Feedback isn't being collected right now" }, { status: 503 });
    if (result === "not_found") return Response.json({ error: "Unknown or expired reply" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Feedback not saved:", error);
    return Response.json({ error: "Feedback not saved" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  if (!isOwner(req)) {
    return Response.json({ error: "Owner sign-in required" }, { status: 401 });
  }
  const all = await listSignals();
  if (all === null) {
    return Response.json({ error: "Signal store is not configured" }, { status: 503 });
  }
  const includeOwner = new URL(req.url).searchParams.has("include_owner");
  const signals = includeOwner ? all : all.filter((s) => s.requested_by === "visitor");

  return Response.json(
    {
      generated_at: new Date().toISOString(),
      scope: includeOwner ? "visitors and owner" : "visitors only",
      reply_count: signals.length,
      oldest: signals.at(-1)?.created_at ?? null,
      ...summarize(signals),
      thumbs_down: signals.filter((s) => s.feedback?.rating === "down"),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
