import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { fillGaps, getAnalytics, clearAnalyticsCache } from "./analytics.js";
import { prisma } from "./db.js";

describe("Analytics Tests", () => {
  const testProfileId = "test-profile-analytics-" + Date.now();

  before(async () => {
    // Create test profile
    await prisma.profile.create({
      data: {
        id: testProfileId,
        username: `test-analytics-${Date.now()}`,
        displayName: "Test Analytics User",
        bio: "Test bio",
        walletAddress: "GTEST" + "A".repeat(51),
        ownerId: "test-owner-" + Date.now(),
        acceptedAssets: {
          create: [{ code: "XLM" }],
        },
      },
    });

    // Create test transactions with gaps
    const baseDate = new Date("2025-01-01");
    const transactions = [
      {
        date: new Date("2025-01-01"),
        amount: "100",
        supporter: "SUPP1" + "A".repeat(51),
      },
      {
        date: new Date("2025-01-01"),
        amount: "50",
        supporter: "SUPP2" + "A".repeat(51),
      },
      {
        date: new Date("2025-01-03"),
        amount: "200",
        supporter: "SUPP1" + "A".repeat(51),
      },
      {
        date: new Date("2025-01-05"),
        amount: "150",
        supporter: "SUPP3" + "A".repeat(51),
      },
    ];

    for (const tx of transactions) {
      await prisma.supportTransaction.create({
        data: {
          txHash: `test-tx-${Date.now()}-${Math.random()}`,
          amount: tx.amount,
          assetCode: "XLM",
          status: "SUCCESS",
          stellarNetwork: "TESTNET",
          recipientAddress: "GTEST" + "A".repeat(51),
          supporterAddress: tx.supporter,
          profileId: testProfileId,
          createdAt: tx.date,
        },
      });
    }
  });

  after(async () => {
    // Cleanup
    await prisma.supportTransaction.deleteMany({
      where: { profileId: testProfileId },
    });
    await prisma.acceptedAsset.deleteMany({
      where: { profileId: testProfileId },
    });
    await prisma.profile.delete({
      where: { id: testProfileId },
    });
    clearAnalyticsCache();
  });

  describe("fillGaps", () => {
    it("should fill missing days with zero values", () => {
      const results = [
        {
          date: new Date("2025-01-01"),
          total: 100,
          txCount: 2,
          uniqueContributors: 2,
          avgContribution: 50,
        },
        {
          date: new Date("2025-01-03"),
          total: 200,
          txCount: 1,
          uniqueContributors: 1,
          avgContribution: 200,
        },
      ];

      const filled = fillGaps(
        results,
        "daily",
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      assert.strictEqual(filled.data.length, 5);
      assert.strictEqual(filled.data[0].amount, "100");
      assert.strictEqual(filled.data[1].amount, "0"); // Gap on Jan 2
      assert.strictEqual(filled.data[2].amount, "200");
      assert.strictEqual(filled.data[3].amount, "0"); // Gap on Jan 4
      assert.strictEqual(filled.data[4].amount, "0"); // Gap on Jan 5
    });

    it("should handle weekly period", () => {
      const results = [
        {
          date: new Date("2025-01-06"),
          total: 100,
          txCount: 1,
          uniqueContributors: 1,
          avgContribution: 100,
        }, // Monday
      ];

      const filled = fillGaps(
        results,
        "weekly",
        new Date("2025-01-01"),
        new Date("2025-01-21"),
      );

      assert.ok(filled.data.length >= 3); // At least 3 weeks
      assert.strictEqual(filled.period, "weekly");
    });

    it("should handle monthly period", () => {
      const results = [
        {
          date: new Date("2025-01-15"),
          total: 100,
          txCount: 1,
          uniqueContributors: 1,
          avgContribution: 100,
        },
      ];

      const filled = fillGaps(
        results,
        "monthly",
        new Date("2025-01-01"),
        new Date("2025-03-31"),
      );

      assert.ok(filled.data.length >= 3); // At least 3 months
      assert.strictEqual(filled.period, "monthly");
    });

    it("should preserve existing data", () => {
      const results = [
        {
          date: new Date("2025-01-01"),
          total: 100,
          txCount: 2,
          uniqueContributors: 2,
          avgContribution: 50,
        },
      ];

      const filled = fillGaps(
        results,
        "daily",
        new Date("2025-01-01"),
        new Date("2025-01-01"),
      );

      assert.strictEqual(filled.data.length, 1);
      assert.strictEqual(filled.data[0].amount, "100");
      assert.strictEqual(filled.data[0].count, 2);
      assert.strictEqual(filled.data[0].uniqueContributors, 2);
      assert.strictEqual(filled.data[0].avgContribution, "50");
    });
  });

  describe("getAnalytics", () => {
    it("should return analytics with filled gaps", async () => {
      const analytics = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      assert.ok(analytics.dailyContributions);
      assert.strictEqual(analytics.dailyContributions.length, 5);

      // Check that gaps are filled with zeros
      assert.strictEqual(analytics.dailyContributions[1].amount, "0"); // Jan 2
      assert.strictEqual(analytics.dailyContributions[3].amount, "0"); // Jan 4
    });

    it("should calculate summary metrics correctly", async () => {
      const analytics = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      assert.ok(analytics.summary);
      assert.strictEqual(analytics.summary.totalRaised, "500"); // 100+50+200+150
      assert.strictEqual(analytics.summary.totalContributors, 3); // SUPP1, SUPP2, SUPP3
      assert.strictEqual(analytics.summary.transactionCount, 4);
    });

    it("should calculate daily unique contributors", async () => {
      const analytics = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      // Jan 1 has 2 unique contributors (SUPP1, SUPP2)
      assert.strictEqual(analytics.dailyContributions[0].uniqueContributors, 2);

      // Jan 3 has 1 unique contributor (SUPP1)
      assert.strictEqual(analytics.dailyContributions[2].uniqueContributors, 1);
    });

    it("should calculate daily average contribution", async () => {
      const analytics = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      // Jan 1: (100+50)/2 = 75
      assert.strictEqual(analytics.dailyContributions[0].avgContribution, "75");

      // Jan 3: 200/1 = 200
      assert.strictEqual(
        analytics.dailyContributions[2].avgContribution,
        "200",
      );
    });

    it("should provide asset breakdown", async () => {
      const analytics = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      assert.ok(analytics.assetBreakdown);
      assert.ok(Array.isArray(analytics.assetBreakdown));

      const xlmBreakdown = analytics.assetBreakdown.find(
        (a: any) => a.asset === "XLM",
      );
      assert.ok(xlmBreakdown);
      assert.strictEqual(xlmBreakdown.amount, "500"); // 100+50+200+150
      assert.strictEqual(xlmBreakdown.count, 4);
    });

    it("should support date range filtering", async () => {
      const analytics = await getAnalytics(
        testProfileId,
        new Date("2025-01-03"),
        new Date("2025-01-05"),
      );

      assert.strictEqual(analytics.summary.transactionCount, 2); // Only Jan 3 and Jan 5
      assert.strictEqual(analytics.summary.totalRaised, "350"); // 200+150
    });

    it("should export to CSV format", async () => {
      const csv = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-03"),
        "csv",
      );

      assert.ok(typeof csv === "string");
      assert.ok(csv.includes("Date"));
      assert.ok(csv.includes("Amount"));
      assert.ok(csv.includes("Transaction Count"));
      assert.ok(csv.includes("Unique Contributors"));
      assert.ok(csv.includes("Avg Contribution"));

      // Check data rows
      const lines = csv.trim().split("\n");
      assert.ok(lines.length >= 4); // Header + 3 days
    });

    it("should cache analytics results", async () => {
      clearAnalyticsCache(testProfileId);

      const analytics1 = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      const originalTotal = analytics1.summary.totalRaised;

      // Mutate the underlying data
      await prisma.supportTransaction.create({
        data: {
          txHash: `test-tx-new-${Date.now()}`,
          amount: "999",
          assetCode: "XLM",
          status: "SUCCESS",
          stellarNetwork: "TESTNET",
          recipientAddress: "GTEST" + "A".repeat(51),
          supporterAddress: "SUPPNEW" + "A".repeat(47),
          profileId: testProfileId,
          createdAt: new Date("2025-01-01"),
        },
      });

      const analytics2 = await getAnalytics(
        testProfileId,
        new Date("2025-01-01"),
        new Date("2025-01-05"),
      );

      // Second call should return the stale cached result
      // (if caching works, totals won't include the new 999 transaction)
      assert.strictEqual(analytics2.summary.totalRaised, originalTotal);
    });

    it("should use default date range when not specified", async () => {
      const analytics = await getAnalytics(testProfileId);

      assert.ok(analytics.summary);
      assert.ok(analytics.dailyContributions);
      assert.ok(analytics.summary.dateRange);

      // Should default to last 30 days
      const start = new Date(analytics.summary.dateRange.start);
      const end = new Date(analytics.summary.dateRange.end);
      const daysDiff = Math.ceil(
        (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
      );
      assert.ok(daysDiff >= 29 && daysDiff <= 31);
    });
  });

  describe("clearAnalyticsCache", () => {
    it("should clear cache for specific profile", async () => {
      await getAnalytics(testProfileId);
      clearAnalyticsCache(testProfileId);

      // Cache should be cleared, so next call will hit database
      const analytics = await getAnalytics(testProfileId);
      assert.ok(analytics);
    });

    it("should clear all cache when no profileId specified", async () => {
      await getAnalytics(testProfileId);
      clearAnalyticsCache();

      // All cache should be cleared
      const analytics = await getAnalytics(testProfileId);
      assert.ok(analytics);
    });
  });
});
