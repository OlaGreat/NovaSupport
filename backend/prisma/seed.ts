import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "builder@novasupport.dev" },
    update: {},
    create: {
      email: "builder@novasupport.dev"
    }
  });

  const profile = await prisma.profile.upsert({
    where: { username: "stellar-dev" },
    update: {},
    create: {
      username: "stellar-dev",
      displayName: "Stellar Dev Collective",
      bio: "Shipping guides, tools, and experiments that help more builders work on Stellar.",
      walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      email: "hello@stellar-dev.example",
      websiteUrl: "https://stellar-dev.example",
      twitterHandle: "stellardev",
      githubHandle: "stellar-dev",
      ownerId: user.id,
      acceptedAssets: {
        create: [
          { code: "XLM" },
          {
            code: "USDC",
            issuer: "GA5ZSEJYB37Y5WZL56FWSOZ5LX5K7Q4SOX7YH3Y2AWJZQURQW6Z5YB2M"
          }
        ]
      }
    },
    include: {
      acceptedAssets: true
    }
  });

  // Seed badge definitions for auto-award system (#545)
  const badgeDefinitions = [
    { name: "First Supporter", description: "Received your very first support transaction", icon: "🎉", criteria: "first_support" },
    { name: "10 Supporters", description: "10 unique supporters have contributed to your profile", icon: "🌟", criteria: "ten_supporters" },
    { name: "100 XLM Club", description: "Received 100+ XLM in total support", icon: "💎", criteria: "total_100_xlm" },
    { name: "Milestone Maker", description: "Reached at least one milestone", icon: "🏆", criteria: "milestone_reached" },
  ];

  for (const badge of badgeDefinitions) {
    await prisma.badge.upsert({
      where: { name: badge.name },
      update: {},
      create: badge,
    });
  }

  await prisma.supportTransaction.upsert({
    where: { txHash: "demo-tx-hash-stellar-testnet" },
    update: {},
    create: {
      txHash: "demo-tx-hash-stellar-testnet",
      amount: "25.0000000",
      assetCode: "XLM",
      status: "SUCCESS",
      message: "Thanks for maintaining open-source tooling.",
      stellarNetwork: "TESTNET",
      supporterAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      recipientAddress: profile.walletAddress,
      profileId: profile.id,
      supporterId: user.id
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("Seed failed", error);
    await prisma.$disconnect();
    process.exit(1);
  });
