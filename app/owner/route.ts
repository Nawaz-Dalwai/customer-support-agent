// Owner sign-in: open /owner once per browser and enter SITE_PASSWORD (any username).
// Sets a 1-year HttpOnly cookie that unlocks all models and removes the visitor limits.
// /owner?logout clears it.
import { OWNER_COOKIE, OWNER_COOKIE_MAX_AGE, ownerToken, safeEqual } from "@/app/lib/access";

export const dynamic = "force-dynamic";

const cookie = (value: string, maxAge: number) =>
  [
    `${OWNER_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");

const redirectHome = (setCookie: string) =>
  new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": setCookie } });

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.has("logout")) {
    return redirectHome(cookie("", 0));
  }

  const password = process.env.SITE_PASSWORD;
  const token = ownerToken();
  if (!password || !token) {
    return new Response("Owner sign-in is not configured.", { status: 503 });
  }

  const header = req.headers.get("authorization") ?? "";
  let supplied = "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      supplied = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      supplied = "";
    }
  }

  if (supplied && safeEqual(supplied, password)) {
    return redirectHome(cookie(token, OWNER_COOKIE_MAX_AGE));
  }
  return new Response("Owner password required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Owner sign-in", charset="UTF-8"' },
  });
}
