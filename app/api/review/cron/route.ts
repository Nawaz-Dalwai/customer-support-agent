// Monthly self-review, started by Vercel Cron (schedule in vercel.json: 1st of the month, 03:00 UTC;
// on the Hobby plan it fires at some point within that hour). Vercel sends
// "Authorization: Bearer <CRON_SECRET>"; without CRON_SECRET set, this refuses every request.
import Anthropic from "@anthropic-ai/sdk";
import { safeEqual } from "@/app/lib/access";
import { startLiveReview } from "@/app/lib/review-store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await startLiveReview({ trigger: "cron", includeOwner: true, client });
  if (result.status !== "done") {
    console.log("🔁 monthly review skipped:", result.status);
    return Response.json({ status: result.status }, { status: result.status === "no_store" ? 503 : 200 });
  }
  const { run } = result;
  console.log("🔁 monthly review", { reviewed: run.reviewed_ids.length, findings: run.findings.length, cost_usd: run.cost_usd });
  return Response.json({
    status: "done",
    run_id: run.id,
    reviewed: run.reviewed_ids.length,
    findings: run.findings.length,
    cost_usd: run.cost_usd,
    errors: run.errors,
  });
}
