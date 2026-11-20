import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { purgeExpiredReporterIps, purgeExpiredRevokedTokens } from "./ip-retention-purge.js";
import { prisma } from "../db.js";
import { seedUser, seedProfile, cleanupTestData } from "../test-harness.js";

function makePrismaMock(updateManyResult: { count: number } = { count: 0 }) {
  const updateMany = mock.fn((_args: { where: unknown; data: unknown }) =>
    Promise.resolve(updateManyResult),
  );
  return {
    profileReport: { updateMany },
    _updateMany: updateMany,
  };
}

test("purges reporterIp only for reports past their expiresAt", async () => {
  const prisma = makePrismaMock({ count: 2 });
  const now = new Date("2026-07-27T00:00:00Z");

  const purged = await purgeExpiredReporterIps(prisma as any, now);

  assert.equal(purged, 2);
  assert.equal(prisma._updateMany.mock.calls.length, 1);

  const [args] = prisma._updateMany.mock.calls[0].arguments;
  assert.deepEqual(args.where, {
    expiresAt: { lte: now },
    reporterIp: { not: null },
  });
  assert.deepEqual(args.data, { reporterIp: null });
});

test("is a no-op when nothing has expired", async () => {
  const prisma = makePrismaMock({ count: 0 });

  const purged = await purgeExpiredReporterIps(prisma as any, new Date());

  assert.equal(purged, 0);
});

test("purges revoked tokens with expired jtis", async () => {
  const deleteMany = mock.fn(async ({ where }: { where: { expiresAt: { lte: Date } } }) => {
    return { count: 3, where };
  });

  const prisma = { revokedToken: { deleteMany } };
  const now = new Date("2026-07-27T00:00:00Z");

  const purged = await purgeExpiredRevokedTokens(prisma as any, now);

  assert.equal(purged, 3);
  assert.equal(deleteMany.mock.calls.length, 1);
  assert.deepEqual(deleteMany.mock.calls[0].arguments[0], {
    where: { expiresAt: { lte: now } },
  });
});

// ── Integration tests (real Postgres database) ──────────────────────────────

test("purges reporter IPs integration: deletes expired IPs from real database", async () => {
  const userId = await seedUser();
  const profileId = await seedProfile(userId);

  const now = new Date();
  const expiredDate = new Date(now.getTime() - 86400000); // 1 day ago
  const futureDate = new Date(now.getTime() + 86400000); // 1 day in future

  await prisma.profileReport.create({
    data: {
      profileId,
      reason: "test-expired",
      reporterIp: "192.168.1.1",
      expiresAt: expiredDate,
    },
  });

  await prisma.profileReport.create({
    data: {
      profileId,
      reason: "test-active",
      reporterIp: "192.168.1.2",
      expiresAt: futureDate,
    },
  });

  const purged = await purgeExpiredReporterIps(prisma, now);
  assert.equal(purged, 1, "Should purge exactly 1 expired IP");

  const remaining = await prisma.profileReport.findMany({
    where: { profileId },
  });

  assert.equal(remaining.length, 2, "Both reports should still exist");
  const expiredReport = remaining.find((r) => r.reason === "test-expired");
  const activeReport = remaining.find((r) => r.reason === "test-active");

  assert.equal(expiredReport?.reporterIp, null, "Expired report IP should be nulled");
  assert.equal(activeReport?.reporterIp, "192.168.1.2", "Active report IP should be preserved");

  await cleanupTestData([profileId], [userId]);
});

test("purges revoked tokens integration: deletes expired tokens from real database", async () => {
  const now = new Date();
  const expiredDate = new Date(now.getTime() - 86400000); // 1 day ago
  const futureDate = new Date(now.getTime() + 86400000); // 1 day in future

  const expiredToken = await prisma.revokedToken.create({
    data: {
      jti: "jti-expired",
      expiresAt: expiredDate,
    },
  });

  const activeToken = await prisma.revokedToken.create({
    data: {
      jti: "jti-active",
      expiresAt: futureDate,
    },
  });

  const purged = await purgeExpiredRevokedTokens(prisma, now);
  assert.equal(purged, 1, "Should purge exactly 1 expired token");

  const expiredExists = await prisma.revokedToken.findUnique({
    where: { jti: "jti-expired" },
  });
  const activeExists = await prisma.revokedToken.findUnique({
    where: { jti: "jti-active" },
  });

  assert.equal(expiredExists, null, "Expired token should be deleted");
  assert.ok(activeExists, "Active token should still exist");

  await prisma.revokedToken.delete({ where: { jti: "jti-active" } });
});
