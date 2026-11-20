import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";

export async function seedUser(): Promise<string> {
  const email = `test-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email } });
  return user.id;
}

export async function seedProfile(ownerId: string): Promise<string> {
  const id = `test-profile-${randomUUID()}`;
  await prisma.profile.create({
    data: {
      id,
      username: `user-${randomUUID()}`,
      displayName: "Test User",
      walletAddress: "G" + "A".repeat(55),
      ownerId,
      acceptedAssets: { create: [{ code: "XLM" }] },
    },
  });
  return id;
}

export async function seedRecurringSupport(
  profileId: string,
  supporterId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = `drip-${randomUUID()}`;
  const now = new Date();
  await prisma.recurringSupport.create({
    data: {
      id,
      profileId,
      supporterId,
      amount: 100n,
      assetCode: "XLM",
      frequency: "weekly",
      status: "active",
      nextRunAt: new Date(now.getTime() - 60000),
      ...overrides,
    } as any,
  });
  return id;
}

export async function cleanupTestData(profileIds: string[], userIds: string[]): Promise<void> {
  // Delete in dependency order
  for (const profileId of profileIds) {
    await prisma.recurringSupportExecution.deleteMany({
      where: { recurringSupport: { profileId } },
    });
    await prisma.recurringSupport.deleteMany({ where: { profileId } });
    await prisma.supportTransaction.deleteMany({ where: { profileId } });
    await prisma.acceptedAsset.deleteMany({ where: { profileId } });
    await prisma.profile.deleteMany({ where: { id: profileId } });
  }

  for (const userId of userIds) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}
