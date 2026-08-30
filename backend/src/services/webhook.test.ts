import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deliverWebhook } from "./webhook.js";

const PAYLOAD = { event: "support.created", amount: "10" };

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  mock.method(globalThis, "fetch", handler as typeof fetch);
}

afterEach(() => {
  mock.restoreAll();
});

test("deliverWebhook must not follow redirects", async () => {
  let capturedInit: RequestInit | undefined;
  mockFetch((_url: string, init: RequestInit) => {
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      type: "basic",
    };
  });

  const result = await deliverWebhook("https://example.com/hook", "s3cret", PAYLOAD);

  assert.equal(result.status, "success");
  assert.equal(capturedInit!.redirect, "manual");
});

test("deliverWebhook treats an opaqueredirect (3xx) response as a delivery failure", async () => {
  mockFetch(() => ({
    ok: false,
    status: 0,
    statusText: "",
    type: "opaqueredirect",
  }));

  const result = await deliverWebhook("https://example.com/hook", "s3cret", PAYLOAD);

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.match(result.error, /redirect/i);
    assert.equal(result.willRetry, false);
  }
});

test("deliverWebhook treats explicit 3xx status as a delivery failure", async () => {
  mockFetch(() => ({
    ok: false,
    status: 302,
    statusText: "Found",
    type: "basic",
  }));

  const result = await deliverWebhook("https://example.com/hook", "s3cret", PAYLOAD);

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.match(result.error, /redirect/i);
    assert.equal(result.willRetry, false);
  }
});

test("deliverWebhook returns success for a 2xx response", async () => {
  mockFetch(() => ({
    ok: true,
    status: 204,
    statusText: "No Content",
    type: "basic",
  }));

  const result = await deliverWebhook("https://example.com/hook", "s3cret", PAYLOAD);

  assert.deepEqual(result, { status: "success", statusCode: 204 });
});

test("deliverWebhook flags server errors for retry", async () => {
  mockFetch(() => ({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    type: "basic",
  }));

  const result = await deliverWebhook("https://example.com/hook", "s3cret", PAYLOAD);

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.willRetry, true);
  }
});