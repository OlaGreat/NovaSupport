import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pino from "pino";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "./app.js";
import { prisma } from "./db.js";
import { signJWT } from "./auth.js";

// #1497: GET /analytics/:username validated limit/offset but never used them.
// They now page recentTransactions.
const hasDb = Boolean(process.env.DATABASE_URL);
const walletAddress = Keypair.random().publicKey();

describe("GET /analytics/:username recentTransactions pagination (#1497)", { skip: !hasDb }, () => {
  let server: Server;
  let baseUrl = "";
  let ownerId = "";
  let profileId = "";
  let username = "";
  let token = "";
  const txHashes: string[] = [];

  before(async () => {
    const app = createApp(pino({ level: "silent" }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    ownerId = (await prisma.user.create({ data: { email: `pagination-${randomUUID()}@example.com` } })).id;
    const profile = await prisma.profile.create({
      data: {
        username: `pagination-${randomUUID().slice(0, 8)}`,
        displayName: "Pagination Test",
        bio: "",
        walletAddress,
        ownerId,
        acceptedAssets: { create: [{ code: "XLM" }] },
      },
    });
    profileId = profile.id;
    username = profile.username;
    token = signJWT(walletAddress, ownerId);

    // Newest first: txHashes[0] is the most recent transaction.
    const base = Date.now();
    for (let i = 0; i < 12; i++) {
      const txHash = randomUUID().replace(/-/g, "");
      txHashes.push(txHash);
      await prisma.supportTransaction.create({
        data: {
          txHash,
          amount: 1,
          assetCode: "XLM",
          status: "SUCCESS",
          stellarNetwork: "testnet",
          recipientAddress: walletAddress,
          profileId,
          supporterAddress: "GSUPPORTER",
          createdAt: new Date(base - i * 60_000),
        },
      });
    }
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.supportTransaction.deleteMany({ where: { profileId } });
    await prisma.acceptedAsset.deleteMany({ where: { profileId } });
    await prisma.profile.deleteMany({ where: { id: profileId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  type AnalyticsBody = {
    recentTransactions: { txHash: string }[];
    recentTransactionsPagination: { limit: number; offset: number };
  };

  async function get(query: string) {
    const res = await fetch(`${baseUrl}/analytics/${username}${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as AnalyticsBody };
  }

  it("keeps the 10 most recent by default", async () => {
    const { status, body } = await get("");
    assert.equal(status, 200);
    assert.deepEqual(body.recentTransactions.map((t) => t.txHash), txHashes.slice(0, 10));
    assert.deepEqual(body.recentTransactionsPagination, { limit: 10, offset: 0 });
  });

  it("applies limit and offset", async () => {
    const { status, body } = await get("?limit=3&offset=2");
    assert.equal(status, 200);
    assert.deepEqual(body.recentTransactions.map((t) => t.txHash), txHashes.slice(2, 5));
    assert.deepEqual(body.recentTransactionsPagination, { limit: 3, offset: 2 });
  });

  it("returns the tail past the default page", async () => {
    const { body } = await get("?offset=10");
    assert.deepEqual(body.recentTransactions.map((t) => t.txHash), txHashes.slice(10));
  });

  it("still rejects out-of-range values", async () => {
    assert.equal((await get("?limit=0")).status, 400);
    assert.equal((await get("?limit=101")).status, 400);
    assert.equal((await get("?offset=-1")).status, 400);
  });
});
