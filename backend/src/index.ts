// tracing.ts must be the very first import so OTel patches all subsequent modules
import "./tracing.js";
import "dotenv/config";
import * as Sentry from "@sentry/node";
import { logger } from "./logger.js";

// Initialise Sentry as early as possible so all subsequent imports are instrumented
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    integrations: [
      Sentry.prismaIntegration(),
    ],
  });
  logger.info("Sentry error monitoring initialised");
} else {
  logger.warn("SENTRY_DSN not set — error monitoring is disabled");
}

const REQUIRED_ENV_VARS = ["DATABASE_URL", "DIRECT_URL"];

function redact(value: string | undefined): string {
  if (!value) return "missing";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    logger.error({ variable: key }, `Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const startupConfig = {
  databaseUrl: redact(process.env.DATABASE_URL),
  directUrl: redact(process.env.DIRECT_URL),
  jwtSecret:
    !process.env.JWT_SECRET || process.env.JWT_SECRET === "your-secret-key-change-in-production"
      ? "default"
      : "configured",
  smtp:
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
      ? {
          enabled: true,
          host: redact(process.env.SMTP_HOST),
          user: redact(process.env.SMTP_USER),
          pass: redact(process.env.SMTP_PASS),
          from: redact(process.env.SMTP_FROM ?? ""),
        }
      : { enabled: false },
  supabase:
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? {
          enabled: true,
          url: redact(process.env.SUPABASE_URL),
          serviceRoleKey: redact(process.env.SUPABASE_SERVICE_ROLE_KEY),
        }
      : { enabled: false },
  horizonUrl:
    process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
};

logger.info(
  { env: startupConfig },
  "Validated backend environment configuration",
);

if (startupConfig.jwtSecret === "default") {
  logger.warn(
    "JWT_SECRET is missing or using the default placeholder — authentication tokens are not production-safe",
  );
}

if (!startupConfig.smtp.enabled) {
  logger.warn(
    "SMTP_HOST, SMTP_USER, or SMTP_PASS is missing — email delivery is disabled",
  );
}

if (!startupConfig.supabase.enabled) {
  logger.warn(
    "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing — avatar uploads are disabled",
  );
}

if (!process.env.ADMIN_WALLET_ADDRESS) {
  logger.warn("ADMIN_WALLET_ADDRESS is not set — admin endpoints are disabled");
}

if (startupConfig.horizonUrl.includes("testnet")) {
  logger.warn(
    { horizonUrl: startupConfig.horizonUrl },
    "Using Horizon testnet endpoint",
  );
}

if (process.env.SKIP_HORIZON_VALIDATION === "true") {
  logger.warn(
    "SKIP_HORIZON_VALIDATION is enabled — transaction verification bypassed",
  );
}

import { app } from "./app.js";
import { startDripScheduler } from "./services/drip-scheduler.js";
import { startWebhookProcessor } from "./services/webhook-processor.js";
import { EventIndexer } from "./services/event-indexer.js";
import { createSorobanRpcClient } from "./services/soroban-rpc-client.js";
import { startWeeklyDigestScheduler, stopWeeklyDigestScheduler } from "./services/weekly-digest.js";
import {
  startIpRetentionPurgeScheduler,
  stopIpRetentionPurgeScheduler,
  startRevokedTokenPurgeScheduler,
  stopRevokedTokenPurgeScheduler,
} from "./services/ip-retention-purge.js";
import {
  startBadgeSweepScheduler,
  stopBadgeSweepScheduler,
} from "./services/badge-awarder.js";
import { prisma } from "./db.js";
import { connectRedis, disconnectRedis } from "./services/redis.js";
import { resolveStellarNetwork } from "./network.js";

const port = Number(process.env.PORT ?? 4000);
// Derive the indexer's network from the same source of truth used by the rest
// of the backend (API responses, email links) instead of a separate variable,
// so switching the active network can't leave the indexer tagging rows with the
// wrong network label (#1353).
const indexerNetwork = resolveStellarNetwork();
const contractId =
  process.env.SOROBAN_CONTRACT_ID ??
  process.env.CONTRACT_ID ??
  process.env.NEXT_PUBLIC_CONTRACT_ID ??
  "";
const sorobanRpcUrl =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const indexerStartLedger = process.env.INDEXER_START_LEDGER
  ? Number(process.env.INDEXER_START_LEDGER)
  : undefined;
const rawMaxPages = process.env.INDEXER_MAX_PAGES_PER_TICK
  ? Number(process.env.INDEXER_MAX_PAGES_PER_TICK)
  : undefined;
const indexerMaxPagesPerTick =
  rawMaxPages !== undefined && Number.isFinite(rawMaxPages)
    ? rawMaxPages
    : undefined;

const eventIndexer =
  contractId.trim().length > 0
    ? new EventIndexer({
        prisma,
        rpcClient: createSorobanRpcClient(sorobanRpcUrl),
        network: indexerNetwork,
        contractId,
        startLedger: indexerStartLedger,
        maxPagesPerTick: indexerMaxPagesPerTick,
      })
    : null;

let dripScheduler: ReturnType<typeof startDripScheduler> | null = null;
let webhookProcessor: ReturnType<typeof startWebhookProcessor> | null = null;
let shuttingDown = false;

await connectRedis();

const server = app.listen(port, () => {
  logger.info({ port }, `NovaSupport backend listening on http://localhost:${port}`);

  // Start the recurring drip scheduler if enabled
  dripScheduler = startDripScheduler();

  // Start the weekly digest email scheduler
  startWeeklyDigestScheduler();

  // Start the reporter IP retention purge scheduler
  startIpRetentionPurgeScheduler();

  // Start the revoked token purge scheduler
  startRevokedTokenPurgeScheduler();

  // Start the badge sweep safety net (re-awards badges missed by the reactive
  // post-transaction check)
  startBadgeSweepScheduler();

  // Start the webhook delivery processor
  webhookProcessor = startWebhookProcessor();

  if (eventIndexer) {
    eventIndexer.start();
    logger.info(
      { contractId, network: indexerNetwork, rpcUrl: sorobanRpcUrl },
      "Soroban event indexer started",
    );
  } else {
    logger.warn(
      "Soroban event indexer disabled - set SOROBAN_CONTRACT_ID to enable it",
    );
  }
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutdown signal received");

  try {
    await Promise.all([
      dripScheduler?.stop(),
      webhookProcessor?.stop(),
      eventIndexer?.stop(),
      Promise.resolve().then(() => stopWeeklyDigestScheduler()),
      Promise.resolve().then(() => stopIpRetentionPurgeScheduler()),
      Promise.resolve().then(() => stopRevokedTokenPurgeScheduler()),
      Promise.resolve().then(() => stopBadgeSweepScheduler()),
    ]);

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await prisma.$disconnect();
    await disconnectRedis();
    await Sentry.close(2_000);
    logger.info({ signal }, "Graceful shutdown complete");
    process.exit(signal === "SIGINT" ? 130 : 143);
  } catch (err) {
    logger.error({ err, signal }, "Graceful shutdown failed");
    process.exit(1);
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
