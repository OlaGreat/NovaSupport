import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "./app.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startFreshServer(): Promise<TestServer> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  return { baseUrl: `http://127.0.0.1:${port}`, close };
}

// #1191: the per-IP view count limiter is attached to the canonical
// `v1Router.get("/profiles/:username", viewCountLimiter, ...)` route. It used to
// be mounted on `app` at `/profiles/:username`, which never matched
// `/v1/profiles/:username` and never ran for the versioned handler either.
test("view count limiter applies to the canonical /v1 profile route (#1191)", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  // The limiter's `skip` returns true under NODE_ENV=test, so drive the real
  // middleware by presenting this server as a development instance.
  process.env.NODE_ENV = "development";

  const server = await startFreshServer();
  try {
    const url = `${server.baseUrl}/v1/profiles/some-user`;

    // The first request may succeed, fail on the database or time out — what
    // matters is that it reaches the handler instead of being rate-limited.
    const first = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    assert.notEqual(first?.status, 429, "the first request must reach the handler");

    // Second request in the same window: the limiter must answer before the
    // handler runs, so this stays fast even without a database.
    const second = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    assert.equal(second?.status, 429, "a second request in the window must be rate-limited");

    const body = (await second?.json()) as { error?: string } | undefined;
    assert.match(body?.error ?? "", /Too many requests/);
  } finally {
    await server.close();
    process.env.NODE_ENV = previousNodeEnv;
  }
});

// The deprecated unversioned alias is served by the same versioned handler, so
// it must be limited too — otherwise the alias becomes a bypass around the
// canonical route's per-IP bucket.
test("the deprecated unversioned alias cannot bypass the v1 view count limiter (#1191)", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  const server = await startFreshServer();
  try {
    const url = `${server.baseUrl}/profiles/some-user`;
    const first = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    assert.notEqual(first?.status, 429, "the first request must reach the handler");

    const second = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    assert.equal(second?.status, 429, "the alias must share the canonical route's limiter");
  } finally {
    await server.close();
    process.env.NODE_ENV = previousNodeEnv;
  }
});
