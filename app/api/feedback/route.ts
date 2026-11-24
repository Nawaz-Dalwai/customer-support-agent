// "Did this fix it?" on a reply (POST), and the owner's report over the logged reply signals (GET).
// GET /api/feedback                    visitor replies only, summary + every negative reply
// GET /api/feedback?include_owner=1    also counts the owner's own test conversations
import { z } from "zod/v4";
import { isOwner } from "@/app/lib/access";
import { STUCK_REASONS } from "@/app/lib/feedback-reasons";
import { isNegative, listSignals, saveOutcome, summarize } from "@/app/lib/signals";

export const dynamic = "force-dynamic";

const MAX_STEPS = 50;
const outcomeSchema = z
  .object({
    id: z.uuid(),
    result: z.enum(["resolved", "stuck", "unneeded_handoff"]),
    reason: z.enum(STUCK_REASONS).nullable().optional(),
    steps_done: z.int().min(0).max(MAX_STEPS).optional(),
    steps_total: z.int().min(0).max(MAX_STEPS).optional(),
    escalated: z.boolean().optional(),
  })
  .refine((o) => (o.steps_done ?? 0) <= (o.steps_total ?? 0), { message: "steps_done exceeds steps_total" });

export async function POST(req: Request) {
  const parsed = outcomeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid feedback" }, { status: 400 });
  }
  const { id, result, reason, steps_done, steps_total, escalated } = parsed.data;
  try {
    const saved = await saveOutcome(id, {
      result,
      reason: reason ?? null,
      steps_done: steps_done ?? 0,
      steps_total: steps_total ?? 0,
      escalated: result === "stuck" && !!escalated,
    });
    if (saved === "no_store") return Response.json({ error: "Feedback isn't being collected right now" }, { status: 503 });
    if (saved === "not_found") return Response.json({ error: "Unknown or expired reply" }, { status: 404 });
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
      // Still stuck, didn't need a person, or (older records) thumbs down
      negative: signals.filter(isNegative),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
