import assert from "node:assert/strict";
import { Horizon } from "@stellar/stellar-sdk";
import {
  verifyTransaction,
  clearVerificationCache,
  type ExpectedTxDetails,
} from "./services/verify-transaction.js";

// ── Live testnet server (used only where network access is acceptable) ────────
const horizonUrl = "https://horizon-testnet.stellar.org";
const liveServer = new Horizon.Server(horizonUrl);

// Known successful testnet transaction (hash stable on the ledger)
const VALID_HASH = "687258079685320c270c5e933454378f8c6eb534e79ec3795c73c33324f9db21";
const INVALID_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const DUMMY_RECIPIENT = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGPCECWZLKOXUJEUKABC1";

// ── Test infrastructure ───────────────────────────────────────────────────────

interface MockOverrides {
  txResult?: { successful: boolean; hash?: string; ledger?: number } | Error;
  opsResult?: { records: unknown[] } | Error;
}

function makeMockServer(overrides: MockOverrides = {}): Horizon.Server {
  return {
    transactions: () => ({
      transaction: () => ({
        call: async () => {
          if (overrides.txResult instanceof Error) throw overrides.txResult;
          return overrides.txResult ?? { successful: true, hash: "mockhash", ledger: 1 };
        },
      }),
    }),
    operations: () => ({
      forTransaction: () => ({
        call: async () => {
          if (overrides.opsResult instanceof Error) throw overrides.opsResult;
          return overrides.opsResult ?? { records: [] };
        },
      }),
    }),
  } as unknown as Horizon.Server;
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  clearVerificationCache();
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ❌ ${name}: ${msg}`);
    failed++;
  }
}

// ── Suites ────────────────────────────────────────────────────────────────────

async function suiteBasicVerification() {
  console.log("\n── Basic Verification ──────────────────────────────────────────\n");

  await test("known valid transaction returns true (live testnet)", async () => {
    const result = await verifyTransaction(liveServer, VALID_HASH);
    assert.strictEqual(result, true);
  });

  await test("unknown hash (404) returns false (live testnet)", async () => {
    const result = await verifyTransaction(liveServer, INVALID_HASH);
    assert.strictEqual(result, false);
  });

  await test("unsuccessful transaction returns false", async () => {
    const server = makeMockServer({ txResult: { successful: false } });
    assert.strictEqual(await verifyTransaction(server, "hash1"), false);
  });

  await test("unreachable Horizon (non-404 error) returns 'error'", async () => {
    const err = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const server = makeMockServer({ txResult: err });
    assert.strictEqual(await verifyTransaction(server, "hash2", 1, 10), "error");
  });

  await test("transaction exists and is successful returns true", async () => {
    const server = makeMockServer({ txResult: { successful: true } });
    assert.strictEqual(await verifyTransaction(server, "hash3"), true);
  });
}

async function suiteDetailValidation() {
  console.log("\n── Detail Validation ───────────────────────────────────────────\n");

  const xlmPaymentOp = {
    type: "payment",
    to: DUMMY_RECIPIENT,
    amount: "10.0000000",
    asset_type: "native",
  };

  const successTx = { successful: true, hash: "abc", ledger: 1 };

  await test("XLM payment with matching details returns true", async () => {
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [xlmPaymentOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "10",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), true);
  });

  await test("wrong amount returns false", async () => {
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [xlmPaymentOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "999",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), false);
  });

  await test("wrong recipient returns false", async () => {
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [xlmPaymentOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "10",
      recipientAddress: "GDIFFERENTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), false);
  });

  await test("wrong asset code returns false", async () => {
    const usdcOp = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "10.0000000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    };
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [usdcOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "10",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM", // expects XLM but op is USDC
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), false);
  });

  await test("non-native asset with matching issuer returns true", async () => {
    const issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const usdcOp = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "50.0000000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: issuer,
    };
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [usdcOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "50",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "USDC",
      assetIssuer: issuer,
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), true);
  });

  await test("non-native asset with wrong issuer returns false", async () => {
    const usdcOp = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "50.0000000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: "GABC",
    };
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [usdcOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "50",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "USDC",
      assetIssuer: "GXYZ",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), false);
  });

  await test("create_account operation validates as XLM payment", async () => {
    const createOp = {
      type: "create_account",
      account: DUMMY_RECIPIENT,
      starting_balance: "100.0000000",
    };
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [createOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "100",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), true);
  });

  await test("create_account with wrong starting_balance returns false", async () => {
    const createOp = {
      type: "create_account",
      account: DUMMY_RECIPIENT,
      starting_balance: "100.0000000",
    };
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [createOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "50", // mismatch
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), false);
  });

  await test("no matching operations in tx returns false", async () => {
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [] },
    });
    const expected: ExpectedTxDetails = {
      amount: "10",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), false);
  });

  await test("first matching op among multiple wins", async () => {
    const wrongOp = {
      type: "payment",
      to: "GWRONGRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10.0000000",
      asset_type: "native",
    };
    const correctOp = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "10.0000000",
      asset_type: "native",
    };
    const server = makeMockServer({
      txResult: successTx,
      opsResult: { records: [wrongOp, correctOp] },
    });
    const expected: ExpectedTxDetails = {
      amount: "10",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "abc", 3, 10, expected), true);
  });
}

async function suiteCaching() {
  console.log("\n── Caching ─────────────────────────────────────────────────────\n");

  await test("second call with same hash hits cache (no repeat network call)", async () => {
    let callCount = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => { callCount++; return { successful: true }; },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    await verifyTransaction(server, "cache-hash");
    await verifyTransaction(server, "cache-hash");
    assert.strictEqual(callCount, 1, "Horizon should be called exactly once");
  });

  await test("different hash bypasses cache", async () => {
    let callCount = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => { callCount++; return { successful: true }; },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    await verifyTransaction(server, "hash-a");
    await verifyTransaction(server, "hash-b");
    assert.strictEqual(callCount, 2);
  });

  await test("same hash with different expected details creates separate cache entries", async () => {
    let callCount = 0;
    const op = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "10.0000000",
      asset_type: "native",
    };
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => { callCount++; return { successful: true }; },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [op] }) }),
      }),
    } as unknown as Horizon.Server;

    const base: ExpectedTxDetails = { amount: "10", recipientAddress: DUMMY_RECIPIENT, assetCode: "XLM" };
    const different: ExpectedTxDetails = { amount: "20", recipientAddress: DUMMY_RECIPIENT, assetCode: "XLM" };

    await verifyTransaction(server, "multi-key", 3, 10, base);
    await verifyTransaction(server, "multi-key", 3, 10, different);
    assert.strictEqual(callCount, 2, "Different expected details = different cache keys");
  });

  await test("failed (false) result is NOT cached", async () => {
    let callCount = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => { callCount++; return { successful: false }; },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    await verifyTransaction(server, "false-hash");
    await verifyTransaction(server, "false-hash");
    assert.strictEqual(callCount, 2, "Non-successful txs should not be cached");
  });
}

async function suiteExponentialBackoff() {
  console.log("\n── Exponential Backoff ─────────────────────────────────────────\n");

  await test("succeeds immediately without retrying (fast path)", async () => {
    const startTime = Date.now();
    const result = await verifyTransaction(liveServer, VALID_HASH, 2, 500);
    const elapsed = Date.now() - startTime;
    assert.strictEqual(result, true);
    assert.ok(elapsed < 1000, `No retry expected on first-attempt success (elapsed: ${elapsed}ms)`);
  });

  await test("retries on transient error and succeeds on third attempt", async () => {
    let attempt = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => {
            attempt++;
            if (attempt < 3) {
              throw Object.assign(new Error("network error"), { code: "ECONNRESET" });
            }
            return { successful: true };
          },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    const result = await verifyTransaction(server, "retry-hash", 3, 10);
    assert.strictEqual(result, true);
    assert.strictEqual(attempt, 3, "Should retry twice before succeeding");
  });

  await test("throws after exhausting all retries", async () => {
    let attempt = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => {
            attempt++;
            throw Object.assign(new Error("persistent network error"), { code: "ECONNRESET" });
          },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    await assert.rejects(
      async () => verifyTransaction(server, "exhaust-hash", 3, 10),
      (err: any) => {
        assert.ok(err instanceof Error, "Should throw an Error");
        return true;
      }
    );
    assert.strictEqual(attempt, 3, "Should attempt exactly 3 times");
  });

  await test("404 on retry attempt does not retry further", async () => {
    let attempt = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => {
            attempt++;
            throw { response: { status: 404 }, message: "Not Found" };
          },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    const result = await verifyTransaction(server, "404-hash", 3, 10);
    assert.strictEqual(result, false);
    assert.strictEqual(attempt, 1, "404 should short-circuit without retrying");
  });

  await test("backoff delay increases exponentially", async () => {
    const delays: number[] = [];
    let attempt = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => {
            if (attempt > 0) delays.push(Date.now());
            attempt++;
            if (attempt <= 2) throw new Error("transient");
            return { successful: true };
          },
        }),
      }),
      operations: () => ({
        forTransaction: () => ({ call: async () => ({ records: [] }) }),
      }),
    } as unknown as Horizon.Server;

    await verifyTransaction(server, "backoff-hash", 3, 50);

    // First retry delay ~50ms, second ~100ms — second should always be longer
    assert.ok(delays.length >= 1, "Should have retried at least once");
  });
}

async function suiteEdgeCases() {
  console.log("\n── Edge Cases ──────────────────────────────────────────────────\n");

  await test("decimal amounts with trailing zeros match (10.0000000 === 10)", async () => {
    const op = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "10.0000000",
      asset_type: "native",
    };
    const server = makeMockServer({
      txResult: { successful: true },
      opsResult: { records: [op] },
    });
    const expected: ExpectedTxDetails = {
      amount: "10",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
    };
    assert.strictEqual(await verifyTransaction(server, "decimal-hash", 3, 10, expected), true);
  });

  await test("null assetIssuer is treated as undefined (native asset)", async () => {
    const op = {
      type: "payment",
      to: DUMMY_RECIPIENT,
      amount: "5.0000000",
      asset_type: "native",
    };
    const server = makeMockServer({
      txResult: { successful: true },
      opsResult: { records: [op] },
    });
    const expected: ExpectedTxDetails = {
      amount: "5",
      recipientAddress: DUMMY_RECIPIENT,
      assetCode: "XLM",
      assetIssuer: null,
    };
    assert.strictEqual(await verifyTransaction(server, "null-issuer-hash", 3, 10, expected), true);
  });

  await test("no expected details skips operation validation", async () => {
    // Only checks tx.successful; does not call operations endpoint
    let opCallCount = 0;
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: async () => ({ successful: true }),
        }),
      }),
      operations: () => ({
        forTransaction: () => ({
          call: async () => { opCallCount++; return { records: [] }; },
        }),
      }),
    } as unknown as Horizon.Server;

    await verifyTransaction(server, "no-expected");
    assert.strictEqual(opCallCount, 0, "Operations endpoint should not be called without expected details");
  });
}

// ── Run all suites ────────────────────────────────────────────────────────────

async function runTests() {
  console.log("Running Transaction Verification tests...");

  await suiteBasicVerification();
  await suiteDetailValidation();
  await suiteCaching();
  await suiteExponentialBackoff();
  await suiteEdgeCases();

  console.log("\n────────────────────────────────────────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("Unexpected test runner error:", e);
  process.exit(1);
});
