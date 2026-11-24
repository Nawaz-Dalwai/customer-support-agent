// Report for the /insights page.
// GET /api/insights                         sample data (anyone): fake records, see app/lib/insights-sample.json
// GET /api/insights?source=live             real reply records - owner only (they contain visitors' questions)
// GET /api/insights?...&include_owner=1     also count the owner's own test conversations
// Both include `review`: self-review findings (sample findings, or the owner's saved runs on live)
import { isOwner } from "@/app/lib/access";
import { buildInsights } from "@/app/lib/insights";
import { listSignals, type ReplySignal } from "@/app/lib/signals";
import sample from "@/app/lib/insights-sample.json";
import reviewSample from "@/app/lib/review-sample.json";
import { listRuns, reviewView } from "@/app/lib/review-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const owner = isOwner(req);
  const includeOwner = params.has("include_owner");
  const headers = { "Cache-Control": "no-store" };

  if (params.get("source") === "live") {
    if (!owner) return Response.json({ error: "Owner sign-in required" }, { status: 401, headers });
    const records = await listSignals();
    if (records === null) return Response.json({ error: "Signal store is not configured" }, { status: 503, headers });
    const runs = (await listRuns()) ?? [];
    return Response.json(
      { is_owner: true, ...buildInsights(records, { source: "live", includeOwner }), review: reviewView(runs) },
      { headers },
    );
  }

  return Response.json(
    {
      is_owner: owner, // lets the page show the Sample / Live switch
      sample_note: sample.note,
      ...buildInsights(sample.records as ReplySignal[], { source: "sample", includeOwner }),
      review: reviewSample, // 3 findings from a real review run over the sample replies
    },
    { headers },
  );
}
