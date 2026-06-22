import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { signJWT, generateChallenge, verifySignature } from "./auth.js";

const baseUsername = "stellar-dev";
const seedEmail = "builder@novasupport.dev";
const walletAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

let baseUrl = "";
let profileId = "";
let userId = "";
let server: ReturnType<typeof app.listen>;
let authToken = "";

// Helper to get auth headers for protected endpoints
function getAuthHeaders() {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${authToken}`,
  };
}

const validProfilePayload = {
  displayName: "Test Creator",
  walletAddress,
  acceptedAssets: [{ code: "XLM" }],
};

async function seedProfile() {
  const user = await prisma.user.upsert({
    where: { email: seedEmail },
    update: {},
    create: {
      email: seedEmail
    }
  });

  userId = user.id;
  authToken = signJWT(walletAddress, user.id);

  const profile = await prisma.profile.upsert({
    where: { username: baseUsername },
    update: {},
    create: {
      username: baseUsername,
      displayName: "Stellar Dev Collective",
      bio: "Shipping guides, tools, and experiments that help more builders work on Stellar.",
      walletAddress,
      ownerId: user.id
    }
  });

  await prisma.acceptedAsset.deleteMany({
    where: {
      profileId: profile.id
    }
  });

  await prisma.acceptedAsset.createMany({
    data: [
      {
        code: "XLM",
        profileId: profile.id
      },
      {
        code: "USDC",
        issuer: "GA5ZSEJYB37Y5WZL56FWSOZ5LX5K7Q4SOX7YH3Y2AWJZQURQW6Z5YB2M",
        profileId: profile.id
      }
    ],
    skipDuplicates: true
  });

  profileId = profile.id;
}

async function startServer() {
  await seedProfile();

  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer() {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  await prisma.supportTransaction.deleteMany({
    where: {
      txHash: {
        startsWith: "ci-test-"
      }
    }
  });

  await prisma.$disconnect();
}

// Username suffixes from raw UUID can contain "010", "011", etc. which
// triggers the confusing-pattern validator (3+ consecutive [l01O] chars).
// Strip 0 and 1 to guarantee all generated usernames pass validation.
function safeSuffix() {
  return randomUUID().replace(/[01]/g, "a").slice(0, 8);
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await startServer();

  try {
    await runTest("returns health status", async () => {
      const response = await fetch(`${baseUrl}/health`);

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.service, "NovaSupport backend");
      assert.equal(body.network, "Stellar Testnet");
      assert.equal(body.checks.database.status, "up");
    });

    await runTest("returns a seeded profile with accepted assets", async () => {
      const response = await fetch(`${baseUrl}/profiles/${baseUsername}`);

      assert.equal(response.status, 200);

      const profile = await response.json();
      assert.equal(profile.username, baseUsername);
      assert.equal(profile.walletAddress, walletAddress);
      assert.equal(profile.acceptedAssets.length, 2);
    });

    await runTest("GET /profiles/:username exposes isOwner only for authenticated requests", async () => {
      const unauthenticated = await fetch(`${baseUrl}/profiles/${baseUsername}`);
      assert.equal(unauthenticated.status, 200);
      const publicProfile = await unauthenticated.json();
      assert.equal("isOwner" in publicProfile, false);

      const ownerResponse = await fetch(`${baseUrl}/profiles/${baseUsername}`, {
        headers: { authorization: `Bearer ${authToken}` },
      });
      assert.equal(ownerResponse.status, 200);
      const ownerProfile = await ownerResponse.json();
      assert.equal(ownerProfile.isOwner, true);

      const otherUser = await prisma.user.create({
        data: { email: `other-${randomUUID()}@example.com` },
      });

      try {
        const otherToken = signJWT(Keypair.random().publicKey(), otherUser.id);
        const otherResponse = await fetch(`${baseUrl}/profiles/${baseUsername}`, {
          headers: { authorization: `Bearer ${otherToken}` },
        });
        assert.equal(otherResponse.status, 200);
        const otherProfile = await otherResponse.json();
        assert.equal(otherProfile.isOwner, false);
      } finally {
        await prisma.user.deleteMany({ where: { id: otherUser.id } });
      }
    });

    await runTest("returns profile stats summary using all non-failed transactions", async () => {
      const supporterOne = `G${"B".repeat(55)}`;
      const supporterTwo = `G${"C".repeat(55)}`;
      const ignoredSupporter = `G${"D".repeat(55)}`;

      await prisma.supportTransaction.createMany({
        data: [
          {
            txHash: `ci-test-${randomUUID()}`,
            amount: "10.5000000",
            assetCode: "XLM",
            status: "SUCCESS",
            stellarNetwork: "TESTNET",
            supporterAddress: supporterOne,
            recipientAddress: walletAddress,
            profileId,
          },
          {
            txHash: `ci-test-${randomUUID()}`,
            amount: "5.0000000",
            assetCode: "XLM",
            status: "SUCCESS",
            stellarNetwork: "TESTNET",
            supporterAddress: supporterTwo,
            recipientAddress: walletAddress,
            profileId,
          },
          {
            txHash: `ci-test-${randomUUID()}`,
            amount: "2.2500000",
            assetCode: "USDC",
            status: "SUCCESS",
            stellarNetwork: "TESTNET",
            supporterAddress: supporterOne,
            recipientAddress: walletAddress,
            profileId,
          },
          {
            txHash: `ci-test-${randomUUID()}`,
            amount: "99.0000000",
            assetCode: "XLM",
            status: "pending",
            stellarNetwork: "TESTNET",
            supporterAddress: ignoredSupporter,
            recipientAddress: walletAddress,
            profileId,
          },
        ],
      });

      const response = await fetch(`${baseUrl}/profiles/${baseUsername}/stats`);

      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.totalTransactions, 4);
      assert.equal(body.uniqueSupporters, 3);
      assert.ok(body.firstSupportedAt);
      assert.ok(body.lastSupportedAt);

      // Sort to ensure deterministic deepEqual
      const sortedTotals = body.totalByAsset.sort((a: any, b: any) => a.assetCode.localeCompare(b.assetCode));
      assert.deepEqual(sortedTotals, [
        { assetCode: "USDC", assetIssuer: null, total: "2.2500000" },
        { assetCode: "XLM", assetIssuer: null, total: "114.5000000" },
      ]);
    });

    await runTest("returns 404 for stats of unknown profile", async () => {
      const response = await fetch(`${baseUrl}/profiles/nonexistent-user/stats`);

      assert.equal(response.status, 404);

      const body = await response.json();
      assert.equal(body.error, "Profile not found");
    });

    await runTest("GET /profiles supports search across username/displayName with trim and 100-char cap", async () => {
      const suffix = safeSuffix();
      const displayNameNeedle = `Needle ${suffix}`;
      const oversizedSearch = `   ${"a".repeat(120)}   `;
      const usernameMatch = `search-user-${suffix}`;

      const createByUsername = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: usernameMatch,
          displayName: `Profile ${suffix}`,
        }),
      });
      assert.equal(createByUsername.status, 201);

      const createByDisplayName = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `search-long-${suffix}`,
          displayName: displayNameNeedle,
        }),
      });
      assert.equal(createByDisplayName.status, 201);

      const withoutSearchResponse = await fetch(`${baseUrl}/profiles`);
      assert.equal(withoutSearchResponse.status, 200);
      const withoutSearch = await withoutSearchResponse.json();
      assert.ok(Array.isArray(withoutSearch.profiles));
      assert.ok(
        withoutSearch.profiles.some((profile: { username: string }) => profile.username === baseUsername),
        "Expected unfiltered profile list to include seeded profile"
      );

      const usernameSearchResponse = await fetch(`${baseUrl}/profiles?search=${encodeURIComponent(usernameMatch.toUpperCase())}`);
      assert.equal(usernameSearchResponse.status, 200);
      const usernameSearch = await usernameSearchResponse.json();
      assert.ok(
        usernameSearch.profiles.some((profile: { username: string }) => profile.username === usernameMatch),
        "Expected case-insensitive username search to match"
      );

      const trimmedSearchResponse = await fetch(`${baseUrl}/profiles?search=${encodeURIComponent(`   ${displayNameNeedle}   `)}`);
      assert.equal(trimmedSearchResponse.status, 200);
      const trimmedSearch = await trimmedSearchResponse.json();
      assert.ok(
        trimmedSearch.profiles.some((profile: { displayName: string }) => profile.displayName === displayNameNeedle),
        "Expected trimmed search to match displayName"
      );

      const sanitizedSearchResponse = await fetch(`${baseUrl}/profiles?search=${encodeURIComponent(oversizedSearch)}`);
      assert.equal(sanitizedSearchResponse.status, 200);
      const sanitizedSearch = await sanitizedSearchResponse.json();
      assert.ok(Array.isArray(sanitizedSearch.profiles));

      const noMatchResponse = await fetch(`${baseUrl}/profiles?search=${encodeURIComponent("definitely-no-profile-match")}`);
      assert.equal(noMatchResponse.status, 200);
      const noMatch = await noMatchResponse.json();
      assert.equal(noMatch.profiles.length, 0);
    });

    await runTest("creates a support transaction when the payload is valid", async () => {
      const response = await fetch(`${baseUrl}/support-transactions`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          txHash: `ci-test-${randomUUID()}`,
          amount: "5.0000000",
          assetCode: "XLM",
          recipientAddress: walletAddress,
          profileId,
          message: "Thanks for maintaining NovaSupport."
        })
      });

      assert.equal(response.status, 201);

      const transaction = await response.json();
      assert.equal(transaction.assetCode, "XLM");
      assert.equal(transaction.status, "pending");
      assert.equal(transaction.profileId, profileId);
    });

    await runTest("returns a validation error for incomplete support payloads", async () => {
      const response = await fetch(`${baseUrl}/support-transactions`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          txHash: "bad"
        })
      });

      assert.equal(response.status, 400);

      const body = await response.json();
      assert.ok(body.error.fieldErrors.amount);
      assert.ok(body.error.fieldErrors.assetCode);
      assert.ok(body.error.fieldErrors.recipientAddress);
      assert.ok(body.error.fieldErrors.profileId);
    });

    await runTest("returns paginated transactions for a valid profile", async () => {
      const txHash = `ci-test-${randomUUID()}`;

      await fetch(`${baseUrl}/support-transactions`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          txHash,
          amount: "10.0000000",
          assetCode: "XLM",
          recipientAddress: walletAddress,
          profileId,
          stellarNetwork: "TESTNET",
          message: "Transaction pagination test"
        })
      });

      const response = await fetch(
        `${baseUrl}/profiles/${baseUsername}/transactions`
      );

      assert.equal(response.status, 200);

      const body = await response.json();
      assert.ok(Array.isArray(body.transactions));
      assert.equal(typeof body.total, "number");
      assert.ok(body.total >= 1);
      assert.equal(body.limit, 20);
      assert.equal(body.offset, 0);
    });

    await runTest("filters transactions by network query param", async () => {
      const response = await fetch(
        `${baseUrl}/profiles/${baseUsername}/transactions?network=TESTNET`
      );

      assert.equal(response.status, 200);

      const body = await response.json();
      assert.ok(Array.isArray(body.transactions));

      for (const tx of body.transactions) {
        assert.equal(tx.stellarNetwork, "TESTNET");
      }
    });

    await runTest("respects limit and offset query params", async () => {
      const response = await fetch(
        `${baseUrl}/profiles/${baseUsername}/transactions?limit=1&offset=0`
      );

      assert.equal(response.status, 200);

      const body = await response.json();
      assert.ok(body.transactions.length <= 1);
      assert.equal(body.limit, 1);
      assert.equal(body.offset, 0);
    });

    await runTest("returns 404 for transactions of unknown profile", async () => {
      const response = await fetch(
        `${baseUrl}/profiles/nonexistent-user/transactions`
      );

      assert.equal(response.status, 404);

      const body = await response.json();
      assert.equal(body.error, "Profile not found");
    });

    // Issue #229 — duplicate txHash returns 409 DUPLICATE_TX
    await runTest("returns 409 DUPLICATE_TX when same txHash submitted twice", async () => {
      const txHash = `ci-test-dup-${randomUUID()}`;
      const payload = {
        txHash,
        amount: "10.0000000",
        assetCode: "XLM",
        status: "SUCCESS",
        stellarNetwork: "TESTNET",
        recipientAddress: walletAddress,
        profileId,
      };

      const first = await fetch(`${baseUrl}/support-transactions`, {
        method: "POST",
        headers: { ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 201, "first submission should succeed");

      const second = await fetch(`${baseUrl}/support-transactions`, {
        method: "POST",
        headers: { ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 409, "second submission should return 409");

      const body = await second.json();
      assert.equal(body.code, "DUPLICATE_TX");
    });

    // Issue #204 — GET /profiles explore endpoint
    await runTest("GET /profiles returns paginated profile list", async () => {
      const response = await fetch(`${baseUrl}/profiles?limit=5&offset=0&sort=newest`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(Array.isArray(body.profiles));
      assert.equal(typeof body.total, "number");
      assert.equal(body.limit, 5);
      assert.equal(body.offset, 0);
    });

    await runTest("GET /profiles?asset=XLM filters by accepted asset", async () => {
      const response = await fetch(`${baseUrl}/profiles?asset=XLM`);
      assert.equal(response.status, 200);
      const body = await response.json();
      for (const profile of body.profiles) {
        const codes = profile.acceptedAssets.map((a: { code: string }) => a.code);
        assert.ok(codes.includes("XLM"), `profile ${profile.username} should accept XLM`);
      }
    });

    // Issue #220 — Webhook CRUD (auth via Bearer JWT)
    await runTest("webhook: create, list, and delete", async () => {
      const whHeaders = { ...getAuthHeaders() };

      // Create
      const createRes = await fetch(
        `${baseUrl}/profiles/${baseUsername}/webhooks`,
        { method: "POST", headers: whHeaders, body: JSON.stringify({ url: "https://example.com/hook" }) },
      );
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      assert.ok(created.id);
      assert.equal(created.url, "https://example.com/hook");
      assert.ok(created.secret, "secret must be present on creation");

      // List — secret must NOT be included
      const listRes = await fetch(`${baseUrl}/profiles/${baseUsername}/webhooks`, { headers: whHeaders });
      assert.equal(listRes.status, 200);
      const list = await listRes.json();
      assert.ok(list.some((w: { id: string }) => w.id === created.id));
      assert.ok(!list.some((w: Record<string, unknown>) => "secret" in w), "secret must not appear in list");

      // Delete
      const deleteRes = await fetch(
        `${baseUrl}/profiles/${baseUsername}/webhooks/${created.id}`,
        { method: "DELETE", headers: whHeaders },
      );
      assert.equal(deleteRes.status, 204);

      // Confirm gone
      const listAfter = await fetch(`${baseUrl}/profiles/${baseUsername}/webhooks`, { headers: whHeaders });
      const listAfterBody = await listAfter.json();
      assert.ok(!listAfterBody.some((w: { id: string }) => w.id === created.id));
    });

    await runTest("webhook: rejects http:// URLs", async () => {
      const res = await fetch(
        `${baseUrl}/profiles/${baseUsername}/webhooks`,
        {
          method: "POST",
          headers: { ...getAuthHeaders() },
          body: JSON.stringify({ url: "http://insecure.example.com/hook" }),
        },
      );
      assert.equal(res.status, 400);
    });

    await runTest("webhook: unauthenticated request returns 401", async () => {
      const res = await fetch(
        `${baseUrl}/profiles/${baseUsername}/webhooks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/hook" }),
        },
      );
      assert.equal(res.status, 401);
    });
    await runTest("PATCH updates social fields on a profile", async () => {
      const response = await fetch(`${baseUrl}/profiles/${baseUsername}`, {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          email: "updated@stellar.example",
          websiteUrl: "https://stellar.example",
          twitterHandle: "stellardev",
          githubHandle: "stellar-dev",
        }),
      });

      assert.equal(response.status, 200);

      const profile = await response.json();
      assert.equal(profile.email, "updated@stellar.example");
      assert.equal(profile.websiteUrl, "https://stellar.example");
      assert.equal(profile.twitterHandle, "stellardev");
      assert.equal(profile.githubHandle, "stellar-dev");
    });

    await runTest("PATCH clears nullable social fields when set to null", async () => {
      const response = await fetch(`${baseUrl}/profiles/${baseUsername}`, {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          email: null,
          twitterHandle: null,
        }),
      });

      assert.equal(response.status, 200);

      const profile = await response.json();
      assert.equal(profile.email, null);
      assert.equal(profile.twitterHandle, null);
    });

    await runTest("PATCH rejects invalid social field formats", async () => {
      const response = await fetch(`${baseUrl}/profiles/${baseUsername}`, {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          email: "not-an-email",
        }),
      });

      assert.equal(response.status, 400);
    });

    await runTest("POST rejects invalid Stellar address checksum", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          username: "bad-wallet-test",
          displayName: "Bad Wallet",
          walletAddress: "GBADADDRESSBADADDRESSBADADDRESSBADADDRESSBADADDRESSBADX",
          acceptedAssets: [{ code: "XLM" }],
        }),
      });

      assert.equal(response.status, 400);
    });

    await runTest("PATCH returns 404 for non-existent profile", async () => {
      const response = await fetch(`${baseUrl}/profiles/nonexistent-user`, {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ displayName: "New Name" }),
      });

      assert.equal(response.status, 404);
    });

    await runTest("POST /profiles - returns 201 with social fields when provided", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `social-test-${safeSuffix()}`,
          email: "social@example.com",
          websiteUrl: "https://example.com",
          twitterHandle: "testhandle",
          githubHandle: "testhandle",
        }),
      });

      assert.equal(response.status, 201);
      const profile = await response.json();
      assert.equal(profile.email, "social@example.com");
      assert.equal(profile.websiteUrl, "https://example.com");
      assert.equal(profile.twitterHandle, "testhandle");
      assert.equal(profile.githubHandle, "testhandle");
    });

    await runTest("POST /profiles - returns 409 EMAIL_TAKEN for duplicate email", async () => {
      const dupEmail = `dup-${safeSuffix()}@example.com`;

      await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `first-${safeSuffix()}`,
          email: dupEmail,
        }),
      });

      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `second-${safeSuffix()}`,
          email: dupEmail,
        }),
      });

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, "EMAIL_TAKEN");
    });

    await runTest("POST /profiles - returns 400 for invalid email format", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `inv-email-${safeSuffix()}`,
          email: "not-an-email",
        }),
      });

      assert.equal(response.status, 400);
    });

    await runTest("POST /profiles - returns 400 for websiteUrl without https", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `inv-url-${safeSuffix()}`,
          websiteUrl: "http://example.com",
        }),
      });

      assert.equal(response.status, 400);
    });

    await runTest("POST /profiles - returns 400 for twitterHandle with only invalid characters", async () => {
      // sanitizeSocialHandle strips non-alphanumeric chars; a handle of only
      // special chars reduces to "" which then fails Zod's regex validation.
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ...validProfilePayload,
          username: `inv-twit-${safeSuffix()}`,
          twitterHandle: "!@#$%^&*()",
        }),
      });

      assert.equal(response.status, 400);
    });

    // ── Rate Limiting (Requirement 1.1, 2.1, 3.1) ─────────────────────────

    await runTest("GET /health includes RateLimit-Limit and RateLimit-Remaining headers", async () => {
      const response = await fetch(`${baseUrl}/health`);

      assert.equal(response.status, 200);
      assert.ok(
        response.headers.get("ratelimit-limit") !== null,
        "Expected ratelimit-limit header to be present"
      );
      assert.ok(
        response.headers.get("ratelimit-remaining") !== null,
        "Expected ratelimit-remaining header to be present"
      );
    });

    await runTest("POST /support-transactions includes RateLimit-Limit and RateLimit-Remaining headers", async () => {
      const response = await fetch(`${baseUrl}/support-transactions`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          txHash: `ci-test-${randomUUID()}`,
          amount: "1.0000000",
          assetCode: "XLM",
          recipientAddress: walletAddress,
          profileId,
        }),
      });

      // 201 on success; either way headers should be present
      assert.ok(
        response.headers.get("ratelimit-limit") !== null,
        "Expected ratelimit-limit header to be present"
      );
      assert.ok(
        response.headers.get("ratelimit-remaining") !== null,
        "Expected ratelimit-remaining header to be present"
      );
    });

    // ── Auth Flow Integration Tests (Issue #282) ─────────────────────────

    await runTest("auth flow: complete challenge-sign-verify-JWT flow", async () => {
      // 1. Generate a new keypair (simulating a user's wallet)
      const keypair = Keypair.random();
      const testWalletAddress = keypair.publicKey();

      // 2. Generate a challenge
      const challenge = generateChallenge(testWalletAddress);
      assert.ok(challenge.includes(testWalletAddress), "Challenge should include wallet address");

      // 3. Sign the challenge
      const messageBuffer = Buffer.from(challenge, "utf8");
      const signature = keypair.sign(messageBuffer).toString("base64");

      // 4. Verify the signature
      const isValidSignature = verifySignature(testWalletAddress, challenge, signature);
      assert.ok(isValidSignature, "Signature should be valid");

      // 5. Issue a JWT
      const token = signJWT(testWalletAddress);
      assert.ok(typeof token === "string", "Token should be issued");

      // 6. Use the JWT to access a protected endpoint
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: `auth-test-${safeSuffix()}`,
          displayName: "Auth Test User",
          walletAddress: testWalletAddress,
          acceptedAssets: [{ code: "XLM" }],
        }),
      });

      assert.equal(response.status, 201, "Should be able to create profile with valid JWT");
    });

    await runTest("auth flow: HTTP challenge -> signature verify -> JWT", async () => {
      const keypair = Keypair.random();
      const testWalletAddress = keypair.publicKey();

      const challengeResponse = await fetch(`${baseUrl}/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: testWalletAddress }),
      });
      assert.equal(challengeResponse.status, 200);
      const challengeBody = await challengeResponse.json();
      assert.equal(challengeBody.walletAddress, testWalletAddress);
      assert.equal(typeof challengeBody.challenge, "string");

      const signature = keypair
        .sign(Buffer.from(challengeBody.challenge, "utf8"))
        .toString("base64");

      const verifyResponse = await fetch(`${baseUrl}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: testWalletAddress, signature }),
      });
      assert.equal(verifyResponse.status, 200);
      const verifyBody = await verifyResponse.json();
      assert.equal(verifyBody.walletAddress, testWalletAddress);
      assert.equal(typeof verifyBody.token, "string");
      assert.equal(typeof verifyBody.userId, "string");
    });

    await runTest("auth flow: rejects invalid signature", async () => {
      const keypair1 = Keypair.random();
      const keypair2 = Keypair.random();
      const testWalletAddress = keypair1.publicKey();

      const challenge = generateChallenge(testWalletAddress);
      
      // Sign with wrong keypair
      const messageBuffer = Buffer.from(challenge, "utf8");
      const wrongSignature = keypair2.sign(messageBuffer).toString("base64");

      const isValidSignature = verifySignature(testWalletAddress, challenge, wrongSignature);
      assert.equal(isValidSignature, false, "Wrong signature should fail verification");
    });

    await runTest("auth flow: protected endpoint rejects missing JWT", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: `no-auth-${safeSuffix()}`,
          displayName: "No Auth User",
          walletAddress: "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
          acceptedAssets: [{ code: "XLM" }],
        }),
      });

      assert.equal(response.status, 401, "Should reject request without JWT");
      const body = await response.json();
      assert.ok(body.error.includes("Missing or invalid token"), "Should return appropriate error");
    });

    await runTest("auth flow: protected endpoint rejects invalid JWT", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer invalid.token.here",
        },
        body: JSON.stringify({
          username: `bad-token-${safeSuffix()}`,
          displayName: "Bad Token User",
          walletAddress: "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
          acceptedAssets: [{ code: "XLM" }],
        }),
      });

      assert.equal(response.status, 401, "Should reject request with invalid JWT");
      const body = await response.json();
      assert.ok(body.error.includes("Invalid or expired token"), "Should return appropriate error");
    });

    await runTest("auth flow: protected endpoint rejects malformed authorization header", async () => {
      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "InvalidFormat token",
        },
        body: JSON.stringify({
          username: `malformed-${safeSuffix()}`,
          displayName: "Malformed Auth User",
          walletAddress: "GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM",
          acceptedAssets: [{ code: "XLM" }],
        }),
      });

      assert.equal(response.status, 401, "Should reject request with malformed header");
    });

    await runTest("auth flow: JWT with userId can access protected endpoints", async () => {
      const keypair = Keypair.random();
      const testWalletAddress = keypair.publicKey();
      
      // Create a user first
      const user = await prisma.user.create({
        data: {
          email: `auth-test-${randomUUID()}@example.com`,
        },
      });

      // Issue JWT with userId
      const token = signJWT(testWalletAddress, user.id);

      const response = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: `userid-test-${safeSuffix()}`,
          displayName: "User ID Test",
          walletAddress: testWalletAddress,
          acceptedAssets: [{ code: "XLM" }],
        }),
      });

      assert.equal(response.status, 201, "Should be able to create profile with JWT containing userId");
    });

  } finally {
    await stopServer();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backend tests failed.");
    console.error(error);
    process.exit(1);
  });
