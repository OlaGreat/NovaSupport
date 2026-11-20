import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSorobanRpcClient } from "./soroban-rpc-client.js";
import { nativeToScVal } from "@stellar/stellar-sdk";

function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  mock.method(globalThis, "fetch", handler as typeof fetch);
}

afterEach(() => {
  mock.restoreAll();
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

// A request with an empty cursor and no explicit start ledger forces the
// client to look up the latest ledger from the RPC endpoint.
function fetchWithNoCursor() {
  return createSorobanRpcClient("https://rpc.example.com").fetchEvents({
    contractId: CONTRACT_ID,
    cursor: "",
    startLedger: undefined,
  });
}

// ── issue #1355: malformed getLatestLedger must throw, not fall back to 0 ─────

test("getLatestLedger throws when the response has no result field", async () => {
  mockFetch(() => jsonResponse({ jsonrpc: "2.0", id: "1" }));

  await assert.rejects(
    () => fetchWithNoCursor(),
    /malformed response/i,
  );
});

test("getLatestLedger throws when result is null", async () => {
  mockFetch(() => jsonResponse({ jsonrpc: "2.0", id: "1", result: null }));

  await assert.rejects(
    () => fetchWithNoCursor(),
    /malformed response/i,
  );
});

test("getLatestLedger throws when neither sequence nor latestLedger is numeric", async () => {
  mockFetch(() =>
    jsonResponse({ jsonrpc: "2.0", id: "1", result: { sequence: "nope" } }),
  );

  await assert.rejects(
    () => fetchWithNoCursor(),
    /malformed response/i,
  );
});

test("getLatestLedger never silently starts backfilling from ledger 0", async () => {
  let calls = 0;
  mockFetch(() => {
    calls += 1;
    return jsonResponse({ jsonrpc: "2.0", id: "1", result: {} });
  });

  await assert.rejects(() => fetchWithNoCursor(), /malformed response/i);
  // The malformed ledger lookup must abort before issuing a getEvents call.
  assert.equal(calls, 1);
});

test("getLatestLedger accepts a numeric sequence and forwards it as startLedger", async () => {
  let getEventsBody: { params?: { startLedger?: number } } | undefined;
  mockFetch((_url, init) => {
    const body = JSON.parse(init.body as string) as { method: string };
    if (body.method === "getLatestLedger") {
      return jsonResponse({ jsonrpc: "2.0", id: "1", result: { sequence: 424242 } });
    }
    getEventsBody = body as { params?: { startLedger?: number } };
    return jsonResponse({ jsonrpc: "2.0", id: "1", result: { events: [] } });
  });

  const page = await fetchWithNoCursor();

  assert.deepEqual(page.events, []);
  assert.equal(getEventsBody?.params?.startLedger, 424242);
});

test("getLatestLedger exceeds numeric latestLedger fallback when sequence is absent", async () => {
  let getEventsBody: { params?: { startLedger?: number } } | undefined;
  mockFetch((_url, init) => {
    const body = JSON.parse(init.body as string) as { method: string };
    if (body.method === "getLatestLedger") {
      return jsonResponse({ jsonrpc: "2.0", id: "1", result: { latestLedger: 99 } });
    }
    getEventsBody = body as { params?: { startLedger?: number } };
    return jsonResponse({ jsonrpc: "2.0", id: "1", result: { events: [] } });
  });

  await fetchWithNoCursor();

  assert.equal(getEventsBody?.params?.startLedger, 99);
});

// ── issue #1509: transient RPC failures are retried ──────────────────────────

test("getLatestLedger retries a transient 503 before succeeding", async () => {
  let ledgerCalls = 0;
  mockFetch((_url, init) => {
    const body = JSON.parse(init.body as string) as { method: string };
    if (body.method === "getLatestLedger") {
      ledgerCalls++;
      if (ledgerCalls === 1) return { ok: false, status: 503, json: () => Promise.resolve({}) };
      return jsonResponse({ jsonrpc: "2.0", id: "1", result: { sequence: 7 } });
    }
    return jsonResponse({ jsonrpc: "2.0", id: "1", result: { events: [] } });
  });

  await fetchWithNoCursor();

  assert.equal(ledgerCalls, 2);
});

// ── issue #1510: missing timestamp discards the event ────────────────────────

test("support event without a timestamp is discarded, not dated 1970", async () => {
  const value = nativeToScVal({ supporter: "GSUPPORTER", recipient: "GRECIPIENT", amount: "1" }).toXDR("base64");
  mockFetch(() =>
    jsonResponse({
      jsonrpc: "2.0",
      id: "1",
      result: {
        latestLedger: 1,
        events: [{ ledger: 1, txHash: "h", ledgerClosedAt: "", topic: ["t"], value, contractId: CONTRACT_ID, id: "1" }],
      },
    }),
  );

  const page = await createSorobanRpcClient("https://rpc.example.com").fetchEvents({
    contractId: CONTRACT_ID,
    cursor: "c",
    startLedger: undefined,
  });

  assert.deepEqual(page.events, []);
});
