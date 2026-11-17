import { NextResponse, type NextRequest } from "next/server";

// Site-wide password (HTTP Basic Auth): every page and /api/chat require it.
// Username can be anything; the password is SITE_PASSWORD.
// Fails closed: if SITE_PASSWORD is not set, nobody gets in.

export const config = {
  // Everything except Next's static build assets
  matcher: ["/((?!_next/static|_next/image).*)"],
};

// Constant-time comparison so response timing doesn't leak how much of the password matched
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

const challenge = (message: string) =>
  new NextResponse(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Support Assistant", charset="UTF-8"' },
  });

export function middleware(req: NextRequest) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) {
    return new NextResponse("Site password is not configured.", { status: 503 });
  }

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return challenge("Password required.");

  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return challenge("Password required.");
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);

  return safeEqual(password, expected) ? NextResponse.next() : challenge("Wrong password.");
}
