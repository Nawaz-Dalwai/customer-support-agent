// Server-only: who is calling (owner vs public visitor) and the public visitor limits.
import crypto from "crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export const OWNER_COOKIE = "owner_session";
export const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export const PUBLIC_MODEL_ID = "claude-haiku-5-5";
export const PUBLIC_MAX_MESSAGE_CHARS = 500;
export const PUBLIC_REQUESTS_PER_WINDOW = 10;
const PUBLIC_WINDOW = "24 h";
export const OWNER_MAX_MESSAGE_CHARS = 20000; // effectively unlimited for a support question

// ---- Owner identification ------------------------------------------------------------
// The owner cookie holds an HMAC keyed by SITE_PASSWORD, so it can't be forged without the
// password, and changing SITE_PASSWORD signs every owner browser out.
export function ownerToken(): string | null {
  const secret = process.env.SITE_PASSWORD;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("owner-session-v1").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isOwner(req: Request): boolean {
  const expected = ownerToken();
  const cookie = readCookie(req, OWNER_COOKIE);
  return !!expected && !!cookie && safeEqual(cookie, expected);
}

// Vercel sets x-forwarded-for / x-real-ip to the real client address
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ---- Public visitor rate limit (Upstash Redis) ----------------------------------------
let redis: Redis | null | undefined;

// Shared by the rate limiters and the handoff ticket queue; null when no store is configured.
export function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const configured =
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  redis = configured ? Redis.fromEnv() : null;
  return redis;
}

let ratelimit: Ratelimit | null | undefined;

function getRatelimit(): Ratelimit | null {
  if (ratelimit !== undefined) return ratelimit;
  const store = getRedis();
  ratelimit = store
    ? new Ratelimit({
        redis: store,
        limiter: Ratelimit.slidingWindow(PUBLIC_REQUESTS_PER_WINDOW, PUBLIC_WINDOW),
        prefix: "csa:visitor",
      })
    : null;
  return ratelimit;
}

// Handoff requests have their own, smaller quota so they can't be used to fill the ticket queue.
export const PUBLIC_HANDOFFS_PER_WINDOW = 3;
let handoffLimit: Ratelimit | null | undefined;

export async function consumePublicHandoff(ip: string): Promise<LimitResult> {
  if (handoffLimit === undefined) {
    const store = getRedis();
    handoffLimit = store
      ? new Ratelimit({
          redis: store,
          limiter: Ratelimit.slidingWindow(PUBLIC_HANDOFFS_PER_WINDOW, PUBLIC_WINDOW),
          prefix: "csa:handoff-limit",
        })
      : null;
  }
  if (!handoffLimit) {
    return { allowed: false, remaining: 0, reset: null, denyReason: "store_unavailable" };
  }
  const { success, remaining, reset } = await handoffLimit.limit(ip);
  return success
    ? { allowed: true, remaining, reset }
    : { allowed: false, remaining, reset, denyReason: "quota_exceeded" };
}

export type LimitDenyReason = "store_unavailable" | "quota_exceeded";

export type LimitResult = {
  allowed: boolean;
  remaining: number;
  reset: number | null;
  denyReason?: LimitDenyReason;
};

// Counts one request. Fails closed: without a configured store, public visitors are refused
// rather than allowed to run up unbounded costs.
export async function consumePublicRequest(ip: string): Promise<LimitResult> {
  const rl = getRatelimit();
  if (!rl) {
    console.error("Rate limit store not configured (UPSTASH_REDIS_REST_URL / KV_REST_API_URL)");
    return { allowed: false, remaining: 0, reset: null, denyReason: "store_unavailable" };
  }
  const { success, remaining, reset } = await rl.limit(ip);
  return success
    ? { allowed: true, remaining, reset }
    : { allowed: false, remaining, reset, denyReason: "quota_exceeded" };
}

export async function peekPublicRemaining(ip: string): Promise<number | null> {
  const rl = getRatelimit();
  if (!rl) return null;
  try {
    return (await rl.getRemaining(ip)).remaining;
  } catch {
    return null;
  }
}
