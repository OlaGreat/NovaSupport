import { NextResponse } from "next/server";
import { API_BASE_URL, HORIZON_URL, SOROBAN_RPC_URL } from "@/lib/config";

// Built here (at request time) rather than in next.config.mjs's headers(),
// since process.env there is only resolved at build time and would bake in
// an empty connect-src on hosts where these vars are injected at runtime.
export function middleware() {
  const csp = [
    "default-src 'self'",
    // Next.js inlines its bootstrap/flight-data scripts into every statically
    // prerendered page. That HTML is built ahead of time, so it cannot carry a
    // per-request nonce — and a nonce in this directive makes browsers ignore
    // 'unsafe-inline', which blocked all client-side JS on every static route.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // Resolved through lib/config so the policy allows exactly the origins the
    // client calls. Reading process.env directly here omitted them whenever the
    // vars were unset, while the client still fell back to its own defaults —
    // so every API and Horizon request was blocked.
    `connect-src 'self' ${API_BASE_URL} ${HORIZON_URL} ${SOROBAN_RPC_URL}`,
    "img-src 'self' data: blob: https:",
    "frame-ancestors 'none'",
  ].join("; ");

  const response = NextResponse.next();

  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Excludes /embed/* (path-segment boundary) which keeps its own permissive
  // frame-ancestors CSP set in next.config.mjs, plus static assets.
  // The boundary "embed(/|$)" ensures only the exact /embed route and its
  // children are excluded, not any future route that merely starts with
  // the same letters.
  matcher: "/((?!embed(/|$)|_next/static|_next/image|favicon.ico).*)",
};
