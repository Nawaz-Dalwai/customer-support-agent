// Server-only: saved self-review runs (Upstash Redis) and the once-a-day run limit shared by
// the monthly cron job and the owner's "Run review now" button.
import type Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "@/app/lib/access";
import { listSignals } from "@/app/lib/signals";
import { runReview, type FindingStatus, type ReviewRun } from "@/app/lib/review";

const runKey = (id: string) => `csa:review:run:${id}`;
const RUNS_KEY = "csa:review:runs"; // newest first
const REVIEWED_KEY = "csa:review:reviewed"; // reply ids already reviewed, so no reply is reviewed twice
const lockKey = (day: string) => `csa:review:lock:${day}`;
const RETENTION_SECONDS = 60 * 60 * 24 * 90; // findings outlive the 30-day reply records
const MAX_RUNS = 24;

export type StoredRun = ReviewRun & { trigger: "cron" | "manual" };
export type LiveReviewResult =
  | { status: "no_store" }
  | { status: "already_ran_today" }
  | { status: "done"; run: StoredRun };

export async function startLiveReview(opts: {
  trigger: "cron" | "manual";
  includeOwner: boolean;
  client: Anthropic;
}): Promise<LiveReviewResult> {
  const store = getRedis();
  if (!store) return { status: "no_store" };

  // One run per UTC day, whoever starts it: caps spend if the button is pressed repeatedly
  const lock = lockKey(new Date().toISOString().slice(0, 10));
  if ((await store.set(lock, opts.trigger, { nx: true, ex: 60 * 60 * 24 })) !== "OK") {
    return { status: "already_ran_today" };
  }
  try {
    const records = (await listSignals()) ?? [];
    const reviewedIds = new Set(await store.smembers(REVIEWED_KEY));
    const run = await runReview(records, {
      source: "live",
      now: Date.now(),
      includeOwner: opts.includeOwner,
      reviewedIds,
      knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
      client: opts.client,
    });
    const stored: StoredRun = { ...run, trigger: opts.trigger };
    await store.set(runKey(run.id), JSON.stringify(stored), { ex: RETENTION_SECONDS });
    await store.lpush(RUNS_KEY, run.id);
    await store.ltrim(RUNS_KEY, 0, MAX_RUNS - 1);
    if (run.reviewed_ids.length) {
      await store.sadd(REVIEWED_KEY, run.reviewed_ids[0], ...run.reviewed_ids.slice(1));
      await store.expire(REVIEWED_KEY, RETENTION_SECONDS);
    }
    return { status: "done", run: stored };
  } catch (error) {
    await store.del(lock); // nothing was saved, so let a retry happen today
    throw error;
  }
}

export async function listRuns(): Promise<StoredRun[] | null> {
  const store = getRedis();
  if (!store) return null;
  const ids = await store.lrange<string>(RUNS_KEY, 0, MAX_RUNS - 1);
  if (ids.length === 0) return [];
  const runs = await store.mget<(StoredRun | null)[]>(...ids.map(runKey));
  return runs.filter((r): r is StoredRun => !!r);
}

// Approve / reject / mark applied (with the commit that applied it)
export async function updateFinding(
  runId: string,
  findingId: string,
  status: FindingStatus,
  appliedCommit?: string,
): Promise<"saved" | "not_found" | "no_store"> {
  const store = getRedis();
  if (!store) return "no_store";
  const run = await store.get<StoredRun>(runKey(runId));
  const finding = run?.findings.find((f) => f.id === findingId);
  if (!run || !finding) return "not_found";
  finding.status = status;
  if (status === "applied" && appliedCommit) finding.applied_commit = appliedCommit;
  else delete finding.applied_commit;
  await store.set(runKey(runId), JSON.stringify(run), { keepTtl: true });
  return "saved";
}

// What /insights shows: the latest run's summary and every finding not rejected, newest run first
export function reviewView(runs: StoredRun[]) {
  const last = runs[0];
  const all = runs.flatMap((r) => r.findings.map((f) => ({ ...f, run_id: r.id, run_at: r.finished_at })));
  return {
    last_run: last
      ? {
          id: last.id,
          finished_at: last.finished_at,
          trigger: last.trigger,
          reviewed: last.reviewed_ids.length,
          candidates: last.candidates,
          findings: last.findings.length,
          cost_usd: last.cost_usd,
          model: last.model,
          errors: last.errors,
        }
      : null,
    findings: all.filter((f) => f.status !== "rejected"),
    rejected_hidden: all.filter((f) => f.status === "rejected").length,
  };
}
