// Lightweight unit tests for the EventIndexer (#281 / #423).
//
// Mocked unit tests validate the indexer logic against Prisma surface area.
// Integration tests (below) hit a real Postgres database to catch schema drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EventIndexer,
  type EventIndexerRpcClient,
  type SupportEventRecord,
} from "./event-indexer.js";
import { prisma } from "../db.js";
import { seedUser, seedProfile, cleanupTestData } from "../test-harness.js";

interface CursorRow {
  network: string;
  contractId: string;
  lastPagingToken: string;
  lastLedger: number;
  updatedAt: Date;
  createdAt: Date;
}

interface ProfileRow {
  id: string;
  walletAddress: string;
}

interface UpsertCall {
  txHash: string;
  profileId: string;
  amount: string;
  assetCode: string;
  recipientAddress: string;
  supporterAddress: string | null;
}

function buildPrismaMock(): {
  prisma: any;
  cursors: CursorRow[];
  profiles: ProfileRow[];
  txCalls: number;
  insertedHashes: string[];
  updatedHashes: string[];
  profileLookups: number;
  upsertCalls: UpsertCall[];
} {
  const cursors: CursorRow[] = [];
  const profiles: ProfileRow[] = [];
  const insertedHashes: string[] = [];
  const updatedHashes: string[] = [];
  const upsertCalls: UpsertCall[] = [];
  let txCalls = 0;
  let profileLookups = 0;

  const cursorClient = {
    findUnique: async (args: { where: { network_contractId: { network: string; contractId: string } } }) => {
      const key = args.where.network_contractId;
      return cursors.find(
        (c) => c.network === key.network && c.contractId === key.contractId,
      ) ?? null;
    },
    upsert: async (args: {
      where: { network_contractId: { network: string; contractId: string } };
      create: any;
      update: any;
    }) => {
      const key = args.where.network_contractId;
      const idx = cursors.findIndex(
        (c) => c.network === key.network && c.contractId === key.contractId,
      );
      const now = new Date();
      if (idx === -1) {
        const row: CursorRow = {
          network: args.create.network,
          contractId: args.create.contractId,
          lastPagingToken: args.create.lastPagingToken,
          lastLedger: args.create.lastLedger ?? 0,
          updatedAt: now,
          createdAt: now,
        };
        cursors.push(row);
        return row;
      }
      const existing = cursors[idx]!;
      Object.assign(existing, args.update, { updatedAt: now });
      return existing;
    },
  };

  const profileClient = {
    findMany: async (args: { where: { walletAddress: { in: string[] } } }) => {
      profileLookups++;
      return profiles.filter(
        (p) => args.where.walletAddress.in.includes(p.walletAddress),
      );
    },
  };

  const supportTxClient = {
    findMany: async () => [],
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
    upsert: async (args: { where: { txHash: string }; create: any; update: any }) => {
      upsertCalls.push({
        txHash: args.where.txHash,
        profileId: args.create.profileId ?? args.update.profileId,
        amount: args.create.amount,
        assetCode: args.create.assetCode,
        recipientAddress: args.create.recipientAddress,
        supporterAddress: args.create.supporterAddress,
      });
      const existing = insertedHashes.includes(args.where.txHash);
      if (existing) {
        updatedHashes.push(args.where.txHash);
        // Distinct timestamps so the "createdAt === updatedAt" heuristic
        // counts this as an update, not a fresh insert.
        return {
          createdAt: new Date(2024, 0, 1),
          updatedAt: new Date(2024, 0, 2),
        };
      }
      insertedHashes.push(args.where.txHash);
      const ts = new Date();
      return { createdAt: ts, updatedAt: ts };
    },
  };

  const prisma = {
    indexerCursor: cursorClient,
    supportTransaction: supportTxClient,
    profile: profileClient,
    $transaction: async (cb: (tx: any) => Promise<unknown>) => {
      txCalls += 1;
      return cb({
        indexerCursor: cursorClient,
        supportTransaction: supportTxClient,
      });
    },
  };

  return {
    prisma,
    cursors,
    profiles,
    get txCalls() {
      return txCalls;
    },
    get profileLookups() {
      return profileLookups;
    },
    insertedHashes,
    updatedHashes,
    upsertCalls,
  };
}

function event(overrides: Partial<SupportEventRecord> = {}): SupportEventRecord {
  return {
    txHash: "tx-hash-1",
    ledger: 100,
    pagingToken: "100-1",
    amount: "10.0000000",
    assetCode: "XLM",
    assetIssuer: null,
    recipientAddress: "GAAA",
    supporterAddress: "GBBB",
    message: "thanks",
    emittedAt: new Date(),
    ...overrides,
  };
}

function rpc(pages: Array<{ events: SupportEventRecord[]; nextPagingToken: string | null }>): EventIndexerRpcClient {
  let i = 0;
  return {
    async fetchEvents() {
      const page = pages[i] ?? { events: [], nextPagingToken: null };
      i = Math.min(i + 1, pages.length - 1);
      return page;
    },
  };
}

await test("EventIndexer.pollOnce ingests events and advances the cursor", async () => {
  const { prisma, cursors, insertedHashes } = buildPrismaMock();
  const indexer = new EventIndexer({
    prisma,
    rpcClient: rpc([
      {
        events: [
          event({ txHash: "tx-1", pagingToken: "100-1", ledger: 100 }),
          event({ txHash: "tx-2", pagingToken: "100-2", ledger: 100 }),
        ],
        nextPagingToken: "100-2",
      },
    ]),
    network: "TESTNET",
    contractId: "C123",
  });

  const { ingested, nextCursor } = await indexer.pollOnce();
  assert.equal(ingested, 2);
  assert.equal(nextCursor, "100-2");
  assert.deepEqual(insertedHashes, ["tx-1", "tx-2"]);
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0]!.lastPagingToken, "100-2");
  assert.equal(cursors[0]!.lastLedger, 100);
});

await test("EventIndexer.pollOnce treats duplicate tx hashes as no-ops (idempotent)", async () => {
  const mock = buildPrismaMock();
  // Pre-seed: tx-1 already ingested.
  mock.insertedHashes.push("tx-1");

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient: rpc([
      {
        events: [
          event({ txHash: "tx-1", pagingToken: "100-1" }),
          event({ txHash: "tx-2", pagingToken: "100-2" }),
        ],
        nextPagingToken: "100-2",
      },
    ]),
    network: "TESTNET",
    contractId: "C123",
  });

  const { ingested } = await indexer.pollOnce();
  // Only tx-2 was new; tx-1 went down the update branch.
  assert.equal(ingested, 1);
  assert.deepEqual(mock.updatedHashes, ["tx-1"]);
});

await test("EventIndexer.pollOnce on empty page advances cursor only when RPC reports one", async () => {
  const { prisma, cursors } = buildPrismaMock();
  const indexer = new EventIndexer({
    prisma,
    rpcClient: rpc([{ events: [], nextPagingToken: "100-EMPTY" }]),
    network: "TESTNET",
    contractId: "C123",
  });

  const { ingested, nextCursor } = await indexer.pollOnce();
  assert.equal(ingested, 0);
  assert.equal(nextCursor, "100-EMPTY");
  assert.equal(cursors[0]!.lastPagingToken, "100-EMPTY");
});

await test("EventIndexer.pollOnce on empty page with no RPC cursor leaves state untouched", async () => {
  const { prisma, cursors } = buildPrismaMock();
  const indexer = new EventIndexer({
    prisma,
    rpcClient: rpc([{ events: [], nextPagingToken: null }]),
    network: "TESTNET",
    contractId: "C123",
  });

  const { ingested, nextCursor } = await indexer.pollOnce();
  assert.equal(ingested, 0);
  assert.equal(nextCursor, null);
  assert.equal(cursors.length, 0);
});

await test("EventIndexer.pollOnce reads pre-existing cursor before fetching", async () => {
  const mock = buildPrismaMock();
  mock.cursors.push({
    network: "TESTNET",
    contractId: "C123",
    lastPagingToken: "200-5",
    lastLedger: 200,
    updatedAt: new Date(),
    createdAt: new Date(),
  });

  let receivedCursor = "";
  const rpcClient: EventIndexerRpcClient = {
    async fetchEvents(args) {
      receivedCursor = args.cursor;
      return { events: [], nextPagingToken: null };
    },
  };

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient,
    network: "TESTNET",
    contractId: "C123",
  });
  await indexer.pollOnce();
  assert.equal(receivedCursor, "200-5");
});

await test("EventIndexer.pollOnce resolves profileId from recipient address", async () => {
  const mock = buildPrismaMock();
  mock.profiles.push({
    id: "profile-abc",
    walletAddress: "GAAA",
  });

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient: rpc([
      {
        events: [
          event({
            txHash: "tx-pro-1",
            pagingToken: "300-1",
            recipientAddress: "GAAA",
          }),
        ],
        nextPagingToken: "300-1",
      },
    ]),
    network: "TESTNET",
    contractId: "C123",
  });

  await indexer.pollOnce();
  assert.equal(mock.upsertCalls.length, 1);
  assert.equal(mock.upsertCalls[0]!.profileId, "profile-abc");
  assert.equal(mock.profileLookups, 1);
});

await test("EventIndexer.pollOnce falls back to __orphan__ when no profile matches", async () => {
  const mock = buildPrismaMock();

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient: rpc([
      {
        events: [
          event({
            txHash: "tx-orphan-1",
            pagingToken: "400-1",
            recipientAddress: "GUNKNOWN",
          }),
        ],
        nextPagingToken: "400-1",
      },
    ]),
    network: "TESTNET",
    contractId: "C123",
  });

  await indexer.pollOnce();
  assert.equal(mock.upsertCalls.length, 1);
  assert.equal(mock.upsertCalls[0]!.profileId, "__orphan__");
});

await test("EventIndexer.pollOnce handles multi-page pagination by advancing cursor each page", async () => {
  const { prisma, cursors, insertedHashes } = buildPrismaMock();

  const indexer = new EventIndexer({
    prisma,
    rpcClient: rpc([
      {
        events: [
          event({ txHash: "tx-p1-1", pagingToken: "100-1", ledger: 100 }),
          event({ txHash: "tx-p1-2", pagingToken: "100-2", ledger: 100 }),
        ],
        nextPagingToken: "100-2",
      },
      {
        events: [
          event({ txHash: "tx-p2-1", pagingToken: "101-1", ledger: 101 }),
        ],
        nextPagingToken: "101-1",
      },
    ]),
    network: "TESTNET",
    contractId: "C123",
  });

  // First poll — page 1
  const result1 = await indexer.pollOnce();
  assert.equal(result1.ingested, 2);
  assert.equal(result1.nextCursor, "100-2");
  assert.equal(cursors[0]!.lastPagingToken, "100-2");

  // Second poll — page 2 (cursor was advanced)
  const result2 = await indexer.pollOnce();
  assert.equal(result2.ingested, 1);
  assert.equal(result2.nextCursor, "101-1");
  assert.equal(cursors[0]!.lastPagingToken, "101-1");

  // All 3 unique hashes were inserted
  assert.deepEqual(insertedHashes, ["tx-p1-1", "tx-p1-2", "tx-p2-1"]);
});

await test("EventIndexer.pollOnce advances cursor across sequential pages", async () => {
  const mock = buildPrismaMock();
  let callCount = 0;

  const rpcClient: EventIndexerRpcClient = {
    async fetchEvents({ cursor }) {
      callCount++;
      if (cursor === "") {
        return {
          events: [event({ txHash: "tx-p1", pagingToken: "500-1" })],
          nextPagingToken: "500-1",
        };
      }
      if (cursor === "500-1") {
        return {
          events: [event({ txHash: "tx-p2", pagingToken: "500-2", ledger: 101 })],
          nextPagingToken: null,
        };
      }
      return { events: [], nextPagingToken: null };
    },
  };

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient,
    network: "TESTNET",
    contractId: "C123",
  });

  // First page
  const page1 = await indexer.pollOnce();
  assert.equal(page1.ingested, 1);
  assert.equal(page1.nextCursor, "500-1");

  // Second page — reads cursor from DB which was updated by page 1
  const page2 = await indexer.pollOnce();
  assert.equal(page2.ingested, 1);
  assert.equal(page2.nextCursor, "500-2");

  assert.equal(mock.upsertCalls.length, 2);
  assert.deepEqual(mock.insertedHashes, ["tx-p1", "tx-p2"]);
  assert.equal(mock.cursors.length, 1);
  assert.equal(mock.cursors[0]!.lastPagingToken, "500-2");
});

await test("EventIndexer.resolveOrphans links orphaned transactions to matching profiles", async () => {
  const mock = buildPrismaMock();

  const orphanId = "orphan-tx-id";
  const recipientAddress = "GAAA";
  const profileId = "profile-123";

  const orphans = [{ id: orphanId, recipientAddress }];
  const profiles = [{ id: profileId, walletAddress: recipientAddress }];
  const updatedIds: string[] = [];

  mock.prisma.supportTransaction.findMany = async () => orphans;
  mock.prisma.profile = {
    findMany: async () => profiles,
  };
  mock.prisma.supportTransaction.updateMany = async (args: { where: { recipientAddress: string }; data: { profileId: string } }) => {
    updatedIds.push(orphanId);
    return { count: 1 };
  };

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient: rpc([]),
    network: "TESTNET",
    contractId: "C123",
  });

  const resolved = await indexer.resolveOrphans();
  assert.equal(resolved, 1);
  assert.deepEqual(updatedIds, [orphanId]);
});

await test("EventIndexer.resolveOrphans rotates past a full page of unresolvable orphans (#1503)", async () => {
  const mock = buildPrismaMock();
  const page = Array.from({ length: 100 }, (_, i) => ({
    id: `id-${String(i).padStart(3, "0")}`,
    recipientAddress: "GNOBODY",
  }));
  const queries: any[] = [];
  mock.prisma.supportTransaction.findMany = async (args: any) => {
    queries.push(args);
    return queries.length === 1 ? page : [];
  };
  mock.prisma.profile = { findMany: async () => [] };

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient: rpc([]),
    network: "TESTNET",
    contractId: "C123",
  });

  await indexer.resolveOrphans();
  await indexer.resolveOrphans();
  assert.deepEqual(queries[0].orderBy, { id: "asc" });
  assert.deepEqual(queries[1].where.id, { gt: "id-099" });
});

await test("EventIndexer.resolveOrphans returns 0 when no orphans exist", async () => {
  const mock = buildPrismaMock();
  mock.prisma.supportTransaction.findMany = async () => [];

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient: rpc([]),
    network: "TESTNET",
    contractId: "C123",
  });

  const resolved = await indexer.resolveOrphans();
  assert.equal(resolved, 0);
});

await test("EventIndexer.resolveOrphans sets the metric to zero when backlog drains", async () => {
  const mock = buildPrismaMock();
  mock.prisma.supportTransaction.findMany = async () => [];
  mock.prisma.supportTransaction.count = async () => 0;

  const calls: number[] = [];
  const { Metrics } = await import("../metrics.js");
  const original = Metrics.orphanCount;
  Metrics.orphanCount = (count: number) => calls.push(count);

  try {
    const indexer = new EventIndexer({
      prisma: mock.prisma,
      rpcClient: rpc([]),
      network: "TESTNET",
      contractId: "C123",
    });

    const resolved = await indexer.resolveOrphans();
    assert.equal(resolved, 0);
    assert.deepEqual(calls, [0]);
  } finally {
    Metrics.orphanCount = original;
  }
});

await test("EventIndexer passes startLedger to RPC client when cursor is empty", async () => {
  let receivedStartLedger: number | undefined;
  const rpcClient: EventIndexerRpcClient = {
    async fetchEvents(args) {
      receivedStartLedger = args.startLedger;
      return { events: [], nextPagingToken: null };
    },
  };

  const indexer = new EventIndexer({
    prisma: buildPrismaMock().prisma,
    rpcClient,
    network: "TESTNET",
    contractId: "C123",
    startLedger: 42,
  });

  await indexer.pollOnce();
  assert.equal(receivedStartLedger, 42);
});

await test("EventIndexer does NOT pass startLedger when cursor already exists", async () => {
  const mock = buildPrismaMock();
  mock.cursors.push({
    network: "TESTNET",
    contractId: "C123",
    lastPagingToken: "600-5",
    lastLedger: 600,
    updatedAt: new Date(),
    createdAt: new Date(),
  });

  let receivedStartLedger: number | undefined;
  const rpcClient: EventIndexerRpcClient = {
    async fetchEvents(args) {
      receivedStartLedger = args.startLedger;
      return { events: [], nextPagingToken: null };
    },
  };

  const indexer = new EventIndexer({
    prisma: mock.prisma,
    rpcClient,
    network: "TESTNET",
    contractId: "C123",
    startLedger: 42,
  });

  await indexer.pollOnce();
  assert.equal(receivedStartLedger, undefined);
});

await test("EventIndexer.stop prevents further ticks from being scheduled", async () => {
  const { prisma } = buildPrismaMock();
  let pollCount = 0;

  const rpcClient: EventIndexerRpcClient = {
    async fetchEvents() {
      pollCount += 1;
      return { events: [], nextPagingToken: null };
    },
  };

  const indexer = new EventIndexer({
    prisma,
    rpcClient,
    network: "TESTNET",
    contractId: "C123",
    pollIntervalMs: 10,
  });

  indexer.start();
  // Let one tick fire
  await new Promise((resolve) => setTimeout(resolve, 30));
  indexer.stop();
  const countAfterStop = pollCount;
  // Wait to confirm no more ticks fire after stop
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pollCount, countAfterStop, "No more polls should fire after stop()");
});

// ── Integration tests (real Postgres database) ──────────────────────────────

await test("EventIndexer integration: ingests support transactions into real Postgres", async () => {
  const userId = await seedUser();
  const profileId = await seedProfile(userId);

  const mockRpc: EventIndexerRpcClient = {
    async fetchEvents() {
      return {
        events: [
          {
            txHash: "tx-integration-1",
            ledger: 100,
            pagingToken: "100-1",
            amount: "50.0000000",
            assetCode: "XLM",
            assetIssuer: null,
            recipientAddress: "G" + "A".repeat(55),
            supporterAddress: "G" + "B".repeat(55),
            message: "test",
            emittedAt: new Date(),
          },
        ],
        nextPagingToken: null,
      };
    },
  };

  const indexer = new EventIndexer({
    prisma,
    rpcClient: mockRpc,
    network: "TESTNET",
    contractId: "CINTEGRATION1",
  });

  const result = await indexer.pollOnce();
  assert.equal(result.ingested, 1, "Should ingest 1 transaction");

  const tx = await prisma.supportTransaction.findFirst({
    where: { txHash: "tx-integration-1" },
  });
  assert.ok(tx, "Transaction should be stored in real database");
  assert.equal(tx.amount, "50.0000000");

  const cursor = await prisma.indexerCursor.findUnique({
    where: { network_contractId: { network: "TESTNET", contractId: "CINTEGRATION1" } },
  });
  assert.ok(cursor, "Cursor should be saved in real database");
  assert.equal(cursor.lastPagingToken, "100-1");

  await cleanupTestData([profileId], [userId]);
});

await test("EventIndexer integration: handles duplicate txHash idempotently", async () => {
  const userId = await seedUser();
  const profileId = await seedProfile(userId);

  let callCount = 0;
  const mockRpc: EventIndexerRpcClient = {
    async fetchEvents() {
      callCount++;
      if (callCount === 1) {
        return {
          events: [
            {
              txHash: "tx-duplicate-test",
              ledger: 200,
              pagingToken: "200-1",
              amount: "100.0000000",
              assetCode: "XLM",
              assetIssuer: null,
              recipientAddress: "G" + "A".repeat(55),
              supporterAddress: "G" + "C".repeat(55),
              message: "first",
              emittedAt: new Date(),
            },
          ],
          nextPagingToken: "200-1",
        };
      }
      return {
        events: [
          {
            txHash: "tx-duplicate-test",
            ledger: 200,
            pagingToken: "200-1",
            amount: "100.0000000",
            assetCode: "XLM",
            assetIssuer: null,
            recipientAddress: "G" + "A".repeat(55),
            supporterAddress: "G" + "C".repeat(55),
            message: "first",
            emittedAt: new Date(),
          },
        ],
        nextPagingToken: null,
      };
    },
  };

  const indexer = new EventIndexer({
    prisma,
    rpcClient: mockRpc,
    network: "TESTNET",
    contractId: "CINTEGRATION2",
  });

  const result1 = await indexer.pollOnce();
  assert.equal(result1.ingested, 1, "First poll should ingest 1 transaction");

  const result2 = await indexer.pollOnce();
  assert.equal(result2.ingested, 0, "Second poll should not re-ingest duplicate");

  const txs = await prisma.supportTransaction.findMany({
    where: { txHash: "tx-duplicate-test" },
  });
  assert.equal(txs.length, 1, "Should have exactly 1 transaction (no duplicates)");

  await cleanupTestData([profileId], [userId]);
});
