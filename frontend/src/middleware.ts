import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Built here (at request time) rather than in next.config.mjs's headers(),
// since process.env there is only resolved at build time and would bake in
// an empty connect-src on hosts where these vars are injected at runtime.
export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${process.env.NEXT_PUBLIC_API_BASE_URL ?? ""} ${process.env.NEXT_PUBLIC_HORIZON_URL ?? ""} ${process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? ""}`,
    "img-src 'self' data: blob: https:",
    "frame-ancestors 'none'",
  ].join("; ");

  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Excludes /embed/*, which keeps its own permissive frame-ancestors CSP
  // set in next.config.mjs, plus static assets.
  matcher: "/((?!embed|_next/static|_next/image|favicon.ico).*)",
};
