// #759: Auth token is now stored in an httpOnly cookie set by the backend
// on POST /auth/verify. The browser attaches it automatically on every
// request (credentials: "include") so we never touch localStorage for auth.
// This eliminates the XSS token-exfiltration attack surface.
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit & { suppressAuthExpired?: boolean },
): Promise<Response> {
  // Allow callers to supply extra headers (e.g. Content-Type) without
  // accidentally overwriting anything we set here.
  const { suppressAuthExpired, ...fetchInit } = (init ?? {}) as RequestInit & {
    suppressAuthExpired?: boolean;
  };
  const headers = new Headers(fetchInit.headers);

  const res = await fetch(input, {
    ...fetchInit,
    headers,
    // Tell the browser to include the httpOnly auth_token cookie on
    // cross-origin requests to the API.
    credentials: "include",
  });

  if (!suppressAuthExpired && res.status === 401 && typeof window !== "undefined") {
    // Clean up any legacy authToken that might still be in localStorage
    localStorage.removeItem("authToken");
    localStorage.removeItem("username");

    // Store current path before redirect so user can return after re-login
    localStorage.setItem(
      "redirectAfterLogin",
      window.location.pathname + window.location.search,
    );

    // #826: A full window.location.reload() destroys any in-progress form
    // state (e.g. the edit-profile form or dashboard toggles) the instant a
    // token expires. Dispatch an event instead and let AuthExpiredListener
    // (mounted in Providers) show a re-auth prompt without a hard navigation.
    window.dispatchEvent(new CustomEvent("auth:expired"));
  }

  return res;
}
