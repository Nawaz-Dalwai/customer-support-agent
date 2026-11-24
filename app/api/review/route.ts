// Self-review of problem replies (see app/lib/review.ts). All owner only.
// GET   /api/review                                  saved runs, newest first
// POST  /api/review  {"source": "live"}              "Run review now": reviews real replies, saves findings
// POST  /api/review  {"source": "sample"}            dry run on the sample data; nothing is saved
// PATCH /api/review  {"run_id", "finding_id", "status", "applied_commit"?}   approve / reject / applied
// The monthly run is GET /api/review/cron (Vercel Cron).
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { isOwner } from "@/app/lib/access";
import { runReview } from "@/app/lib/review";
import { listRuns, startLiveReview, updateFinding } from "@/app/lib/review-store";
import type { ReplySignal } from "@/app/lib/signals";
import sample from "@/app/lib/insights-sample.json";

export const dynamic = "force-dynamic";
// Several Claude calls run in batches; the Hobby plan allows functions up to 300s
export const maxDuration = 300;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const headers = { "Cache-Control": "no-store" };
const ownerOnly = () => Response.json({ error: "Owner sign-in required" }, { status: 401, headers });
const noStore = () => Response.json({ error: "Review store is not configured" }, { status: 503, headers });

export async function GET(req: Request) {
  if (!isOwner(req)) return ownerOnly();
  const runs = await listRuns();
  return runs === null ? noStore() : Response.json({ runs }, { headers });
}

const runSchema = z.object({
  source: z.enum(["sample", "live"]),
  include_owner: z.boolean().default(true),
});

export async function POST(req: Request) {
  if (!isOwner(req)) return ownerOnly();
  const parsed = runSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400, headers });
  const { source, include_owner } = parsed.data;

  if (source === "sample") {
    const run = await runReview(sample.records as ReplySignal[], {
      source: "sample",
      now: Date.parse(sample.generated_for), // the sample's own "today", so its 30-day window is full
      includeOwner: include_owner,
      knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
      client,
    });
    return Response.json(run, { headers });
  }

  const result = await startLiveReview({ trigger: "manual", includeOwner: include_owner, client });
  if (result.status === "no_store") return noStore();
  if (result.status === "already_ran_today") {
    return Response.json({ error: "A review already ran today. Try again tomorrow." }, { status: 429, headers });
  }
  return Response.json(result.run, { headers });
}

const updateSchema = z.object({
  run_id: z.uuid(),
  finding_id: z.uuid(),
  status: z.enum(["pending", "approved", "rejected", "applied"]),
  applied_commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
});

export async function PATCH(req: Request) {
  if (!isOwner(req)) return ownerOnly();
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400, headers });
  const { run_id, finding_id, status, applied_commit } = parsed.data;
  const saved = await updateFinding(run_id, finding_id, status, applied_commit);
  if (saved === "no_store") return noStore();
  if (saved === "not_found") return Response.json({ error: "Unknown run or finding" }, { status: 404, headers });
  return Response.json({ ok: true }, { headers });
}
