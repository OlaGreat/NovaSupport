import cors from "cors";
import cookieParser from "cookie-parser";
import express, { Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import { z } from "zod";
import { StrKey, Horizon } from "@stellar/stellar-sdk";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import * as Sentry from "@sentry/node";
import compression from "compression";
import nodemailer from "nodemailer";
import { prisma } from "./db.js";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { logger } from "./logger.js";
import {
  generateChallenge,
  verifySignature,
  signJWT,
  requireAuth,
  optionalAuth,
  isValidStellarAddress,
  type AuthContext,
} from "./auth.js";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { sendSupportReceivedEmail, escapeHtml } from "./services/email.js";
import { sendVerificationEmail } from "./emails/verify-email.js";
import {
  getCachedLeaderboard,
  invalidateProfileLeaderboardCache,
  setCachedLeaderboard,
  type LeaderboardSort,
} from "./services/profile-leaderboard-cache.js";
import { processPendingWebhookDeliveries } from "./services/webhook-processor.js";
import { getIsRedisAvailable } from "./services/redis.js";
import { enqueueWebhookDelivery } from "./services/webhook-queue.js";
import { addMonths } from "./services/drip-scheduler.js";
import { sanitizeBody, sanitizeQuery, sanitizeString } from "./middleware/sanitize.js";
import { CircuitBreaker, type CircuitBreakerStorage, type State } from "./services/circuit-breaker.js";
import {
  validateUsername,
  validateUsernameWithTakenCheck,
} from "./utils/username-validator.js";
import {
  verifyTransaction as verifyTransactionService,
  type ExpectedTxDetails,
} from "./services/verify-transaction.js";
import { checkAndAwardBadges } from "./services/badge-awarder.js";
import { getMetricsText } from "./metrics.js";

// Extend Express Request to include auth context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE = 2_097_152;

const horizonUrl =
  process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const stellarServer = new Horizon.Server(horizonUrl);
function createPrismaCircuitBreakerStorage(name: string): CircuitBreakerStorage {
  return {
    async load() {
      const row = await prisma.circuitBreakerState.findUnique({
        where: { name },
      });
      if (!row) return null;
      const state = ["CLOSED", "OPEN", "HALF_OPEN"].includes(row.state)
        ? (row.state as State)
        : "CLOSED";
      return {
        state,
        failureCount: row.failureCount,
        nextAttempt: row.nextAttemptAt ? row.nextAttemptAt.getTime() : 0,
      };
    },
    async save(snapshot) {
      await prisma.circuitBreakerState.upsert({
        where: { name },
        create: {
          name,
          state: snapshot.state,
          failureCount: snapshot.failureCount,
          nextAttemptAt: snapshot.nextAttempt ? new Date(snapshot.nextAttempt) : null,
        },
        update: {
          state: snapshot.state,
          failureCount: snapshot.failureCount,
          nextAttemptAt: snapshot.nextAttempt ? new Date(snapshot.nextAttempt) : null,
        },
      });
    },
  };
}
const rawHorizonFailureThreshold = process.env.HORIZON_CIRCUIT_BREAKER_THRESHOLD
  ? Number(process.env.HORIZON_CIRCUIT_BREAKER_THRESHOLD)
  : undefined;
const horizonFailureThreshold =
  rawHorizonFailureThreshold !== undefined && Number.isFinite(rawHorizonFailureThreshold)
    ? rawHorizonFailureThreshold
    : 5;
const rawHorizonResetTimeoutMs = process.env.HORIZON_CIRCUIT_BREAKER_RESET_TIMEOUT_MS
  ? Number(process.env.HORIZON_CIRCUIT_BREAKER_RESET_TIMEOUT_MS)
  : undefined;
const horizonResetTimeoutMs =
  rawHorizonResetTimeoutMs !== undefined && Number.isFinite(rawHorizonResetTimeoutMs)
    ? rawHorizonResetTimeoutMs
    : 30000;
const horizonCircuitBreaker = new CircuitBreaker(
  horizonFailureThreshold,
  horizonResetTimeoutMs,
  createPrismaCircuitBreakerStorage("horizon"),
); // defaults: 5 failures, 30s reset — configurable via HORIZON_CIRCUIT_BREAKER_THRESHOLD / HORIZON_CIRCUIT_BREAKER_RESET_TIMEOUT_MS

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
    }
  },
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseClient =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

if (!supabaseClient) {
  logger.warn(
    "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set — avatar upload endpoint will return 503",
  );
}

type HealthStatus = "up" | "down" | "skipped";

type ServiceHealth = {
  status: HealthStatus;
  critical: boolean;
  responseTimeMs?: number;
  message?: string;
};

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

async function withHealthTimeout<T>(
  check: Promise<T>,
  service: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${service} health check timed out`)),
      HEALTH_CHECK_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([check, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runHealthCheck(
  service: string,
  critical: boolean,
  check: () => Promise<void>,
): Promise<ServiceHealth> {
  const startedAt = Date.now();

  try {
    await withHealthTimeout(check(), service);
    return {
      status: "up",
      critical,
      responseTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "down",
      critical,
      responseTimeMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS,
  );
}

async function checkSmtpConnection(): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });

  await transporter.verify();
}

function createRateLimiters() {
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many requests, please try again later.",
      code: "RATE_LIMIT_EXCEEDED",
    },
  });

  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: {
      error: "Too many requests, please try again later.",
      code: "RATE_LIMIT_EXCEEDED",
    },
  });

  // Stricter limiter for profile creation: 3 per hour per IP (#316)
  const profileCreationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 3,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    keyGenerator: (req) => req.ip ?? "unknown",
    message: {
      error: "Too many profiles created from this IP address. You can create up to 3 profiles per hour. Please try again later.",
      code: "PROFILE_CREATION_RATE_LIMIT_EXCEEDED",
    },
  });

  const resendLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 1,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: {
      error: "Verification email already sent. Please wait 5 minutes before trying again.",
      code: "RATE_LIMIT_EXCEEDED",
    },
    keyGenerator: (req: any) => `${req.ip}-${req.params.username}`,
  });

  // 1 view count increment per IP per hour (issue #463)
  const viewCountLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 1,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: { error: "Too many requests, please try again later." },
  });

  // Dedicated auth limiter — 10 requests per 15 min per IP (#561)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: { error: "Too many auth attempts, please try again later." },
  });

  // Federation / stellar.toml limiter — 30 requests per minute per IP (#763)
  const federationLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: { error: "Too many requests, please try again later." },
  });

  // RSS feed limiter — 10 requests per minute per IP (#799)
  const feedLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    message: { error: "Too many requests, please try again later." },
  });

  return {
    globalLimiter,
    writeLimiter,
    profileCreationLimiter,
    resendLimiter,
    viewCountLimiter,
    authLimiter,
    federationLimiter,
    feedLimiter,
  };
}

// ── API versioning constants ───────────────────────────────────────────
const CURRENT_API_VERSION = "1";
const SUPPORTED_API_VERSIONS = ["1"];

// ── Shared pagination schema (used across multiple routes) ────────────
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const profileSearchPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

type OwnedProfile = {
  ownerId: string;
  walletAddress: string;
};

function isProfileOwner(auth: AuthContext | undefined, profile: OwnedProfile): boolean {
  if (!auth) return false;
  return auth.walletAddress === profile.walletAddress || auth.userId === profile.ownerId;
}

function sendError(
  res: Response,
  status: number,
  message: string,
  code?: string,
) {
  const body: Record<string, unknown> = { error: message };
  if (code) body.code = code;
  const reqId = (res.req as express.Request).requestId;
  if (reqId) body.requestId = reqId;
  return res.status(status).json(body);
}

function getQueryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: unknown[][]): string {
  return `${rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n")}\n`;
}

function createAnalyticsCsv(transactions: any[]): string {
  const headers = [
    "Created At",
    "Transaction Hash",
    "Status",
    "Amount",
    "Asset Code",
    "Asset Issuer",
    "Supporter Address",
    "Recipient Address",
    "Message",
  ];

  const rows = transactions.map((tx) => [
    tx.createdAt,
    tx.txHash,
    tx.status,
    tx.amount.toString(),
    tx.assetCode,
    tx.assetIssuer ?? "",
    tx.supporterAddress ?? "",
    tx.recipientAddress,
    tx.message ?? "",
  ]);

  return toCsv([headers, ...rows]);
}

export function createApp(customLogger?: Logger) {
  const app = express();
  const {
    globalLimiter,
    writeLimiter,
    profileCreationLimiter,
    resendLimiter,
    viewCountLimiter,
    authLimiter,
    federationLimiter,
    feedLimiter,
  } = createRateLimiters();

  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: "3.0.0",
      info: {
        title: "NovaSupport API",
        version: "1.0.0",
        description: `Backend API for NovaSupport — Stellar-native creator support platform.

## Authentication
Most write endpoints require a JWT Bearer token. Obtain one via the \`/auth/challenge\` + \`/auth/verify\` flow:
1. POST \`/auth/challenge\` with your Stellar wallet address to get a challenge nonce.
2. Sign the challenge with your wallet.
3. POST \`/auth/verify\` with the wallet address and signature to receive a JWT.
4. Include the JWT in subsequent requests as \`Authorization: Bearer <token>\`.

## Rate Limiting
All endpoints are subject to rate limiting. Response headers include:
- \`RateLimit-Limit\`: Max requests per window
- \`RateLimit-Remaining\`: Requests left in current window
- \`RateLimit-Reset\`: Unix timestamp when the window resets

| Limiter | Window | Limit | Applies to |
|---------|--------|-------|------------|
| Global | 15 min | 200 | All requests |
| Write | 15 min | 20 | POST/PATCH/DELETE endpoints |
| Profile creation | 1 hour | 3 | POST /profiles |
| Email resend | 5 min | 1 | Resend verification emails |

Exceeding the limit returns \`429 Too Many Requests\` with code \`RATE_LIMIT_EXCEEDED\`.

## Pagination
List endpoints accept \`limit\` (1–100, default 20) and \`offset\` (≥0, default 0) query parameters.
Responses include \`total\`, \`limit\`, and \`offset\` fields.

## Error Responses
All errors return JSON with an \`error\` field and optional \`code\`:
\`\`\`json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE", "requestId": "abc123" }
\`\`\``,
      },
      servers: [{ url: process.env.BACKEND_URL || "http://localhost:4000" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
        headers: {
          "RateLimit-Limit": {
            description: "Request limit for the current window.",
            schema: { type: "integer" },
          },
          "RateLimit-Remaining": {
            description: "Requests remaining in the current window.",
            schema: { type: "integer" },
          },
          "RateLimit-Reset": {
            description:
              "Unix timestamp (seconds) when the current rate limit window resets.",
            schema: { type: "integer" },
          },
          "X-Request-ID": {
            description: "Unique request identifier for tracing.",
            schema: { type: "string" },
          },
        },
        schemas: {
          Error: {
            type: "object",
            properties: {
              error: { type: "string", description: "Human-readable error message" },
              code: { type: "string", description: "Machine-readable error code" },
              requestId: { type: "string", description: "Request tracing ID" },
            },
            required: ["error"],
          },
          PaginationMeta: {
            type: "object",
            properties: {
              total: { type: "integer", description: "Total number of items" },
              limit: { type: "integer", description: "Items per page" },
              offset: { type: "integer", description: "Items skipped" },
            },
          },
        },
      },
    },
    apis: ["./src/app.ts"],
  });

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/docs.json", (req, res) => {
    const dynamicSpec = {
      ...swaggerSpec,
      servers: [
        {
          url: process.env.BACKEND_URL
            ? process.env.BACKEND_URL.replace(/\/$/, "")
            : `${req.protocol}://${req.get("host")}/api/v1`
        }
      ]
    };
    res.json(dynamicSpec);
  });

  // ── Stellar TOML (#514) ───────────────────────────────────────────────
  // Must be registered before any other middleware that might intercept it.
  // Required by Stellar wallets and federation resolvers.
  // Spec: https://developers.stellar.org/docs/learn/encyclopedia/network-configuration/stellar-toml
  let tomlCache: { body: string; expiresAt: number } | null = null;

  app.get("/.well-known/stellar.toml", federationLimiter, async (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    const now = Date.now();
    if (tomlCache && now < tomlCache.expiresAt) {
      return res.send(tomlCache.body);
    }

    try {
      const profiles = await prisma.profile.findMany({
        select: { walletAddress: true },
        take: 10_000,
      });

      const accountLines = profiles
        .map((p) => `[[ACCOUNTS]]\naddress = "${p.walletAddress}"`)
        .join("\n\n");

      const body = [
        `NETWORK_PASSPHRASE="${process.env.STELLAR_NETWORK === 'PUBLIC'
          ? 'Public Global Stellar Network ; September 2015'
          : 'Test SDF Network ; September 2015'}"`,
        `FEDERATION_SERVER="https://api.novasupport.xyz/federation"`,
        ``,
        accountLines || `# no accounts yet`,
      ].join("\n");

      tomlCache = { body, expiresAt: now + 60_000 };
      return res.send(body);
    } catch {
      return res.status(500).send("# Internal server error");
    }
  });

  const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? "http://localhost:3000"
  )
    .split(",")
    .map((o) => o.trim());

  // ── HTTP security headers (#564) ─────────────────────────────────────
  app.use((_req, res, next) => {
    // Prevent MIME-type sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Disallow framing by other origins
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    // Don't send referrer to cross-origin destinations
    res.setHeader("Referrer-Policy", "no-referrer");
    // Disable DNS prefetching
    res.setHeader("X-DNS-Prefetch-Control", "off");
    // Enforce HTTPS for 1 year (only meaningful in production behind TLS)
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    // Allow cross-origin resource loading (e.g. Supabase avatar images)
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (curl, Postman, server-to-server)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      // Required so browsers send the auth_token httpOnly cookie (#759)
      credentials: true,
    }),
  );
  // Parse cookie header so req.cookies.auth_token is available in requireAuth (#759)
  app.use(cookieParser());
  app.use(express.json());
  app.use(compression({ threshold: 1024 }));
  app.use(sanitizeBody);
  app.use(sanitizeQuery);

  // ── Request ID middleware (#452) ──────────────────────────────────────
  app.use((req, res, next) => {
    const clientId = req.headers["x-request-id"] as string | undefined;
    const requestId =
      clientId && /^[a-zA-Z0-9\-_.]{1,64}$/.test(clientId)
        ? clientId
        : randomBytes(16).toString("hex");
    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    next();
  });

  app.use(
    pinoHttp({
      logger: customLogger ?? logger,
      genReqId: (req) => req.requestId ?? randomBytes(16).toString("hex"),
    }),
  );
  // Attach Sentry request/tracing breadcrumbs when DSN is configured
  if (process.env.SENTRY_DSN) {
    app.use(Sentry.expressErrorHandler());
  }
  app.use(globalLimiter);

  // ── API-Version header on every response ──────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader("API-Version", CURRENT_API_VERSION);
    res.setHeader("X-Supported-API-Versions", SUPPORTED_API_VERSIONS.join(", "));
    next();
  });

  // ── Build the versioned v1 router ─────────────────────────────────────
  const v1Router = express.Router();

  /**
   * @openapi
   * /health:
   *   get:
   *     summary: Health check with database connectivity
   *     responses:
   *       200:
   *         description: Service is healthy
   *         content:
   *           application/json:
   *             example:
   *               ok: true
   *               service: "NovaSupport backend"
   *               network: "Stellar Testnet"
   *               database: "connected"
   *       503:
   *         description: Service is unhealthy or database is unreachable
   *         content:
   *           application/json:
   *             example:
   *               ok: false
   *               service: "NovaSupport backend"
   *               database: "unreachable"
   */
  // ── Health check with database connectivity ────────────────────────────

  v1Router.get("/health", async (req, res) => {
    const checks = {
      database: await runHealthCheck("database", true, async () => {
        await prisma.$queryRaw`SELECT 1`;
      }),
      horizon: await runHealthCheck("horizon", true, async () => {
        await stellarServer.ledgers().order("desc").limit(1).call();
      }),
      supabase: supabaseClient
        ? await runHealthCheck("supabase", false, async () => {
            const { error } = await supabaseClient.storage.listBuckets();
            if (error) {
              throw error;
            }
          })
        : {
            status: "skipped",
            critical: false,
            message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured",
          } satisfies ServiceHealth,
      smtp: isSmtpConfigured()
        ? await runHealthCheck("smtp", false, checkSmtpConnection)
        : {
            status: "skipped",
            critical: false,
            message: "SMTP_HOST, SMTP_USER, or SMTP_PASS is not configured",
          } satisfies ServiceHealth,
    };

    for (const [service, status] of Object.entries(checks)) {
      if (status.critical && status.status === "down") {
        req.log.error({ service, status }, "critical health check failed");
      } else if (!status.critical && status.status === "down") {
        req.log.warn({ service, status }, "non-critical health check failed");
      }
    }

    const criticalServicesHealthy = Object.values(checks).every(
      (status) => !status.critical || status.status === "up",
    );

    res.status(criticalServicesHealthy ? 200 : 503).json({
      ok: criticalServicesHealthy,
      service: "NovaSupport backend",
      network: process.env.STELLAR_NETWORK === "PUBLIC" ? "Stellar Mainnet" : "Stellar Testnet",
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // ── Prometheus-compatible metrics endpoint ────────────────────────────
  v1Router.get("/metrics", (_req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(getMetricsText());
  });

  // ── Authentication ─────────────────────────────────────────────────────

  /**
   * @openapi
   * /auth/challenge:
   *   post:
   *     summary: Request a challenge nonce for wallet signature
   *     description: |
   *       Step 1 of authentication. Send your Stellar wallet address to receive a challenge nonce.
   *       Sign the challenge with your wallet, then call POST /auth/verify to get a JWT.
   *       Rate limited to 200 requests per 15 minutes (global) and 20 per 15 minutes (write).
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               walletAddress:
   *                 type: string
   *                 description: User's Stellar wallet address
   *                 example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
   *             required:
   *               - walletAddress
   *           examples:
   *             validRequest:
   *               summary: Valid challenge request
   *               value:
   *                 walletAddress: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
   *     responses:
   *       200:
   *         description: Challenge generated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 challenge:
   *                   type: string
   *                   example: "NovaSupport authentication challenge: 1234567890"
   *                 walletAddress:
   *                   type: string
   *                   example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
   *       400:
   *         description: Invalid wallet address
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *                   example: Invalid wallet address
   */
  // Request a challenge nonce for wallet signature
  v1Router.post("/auth/challenge", authLimiter, async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress || !isValidStellarAddress(walletAddress)) {
      return sendError(res, 400, "Invalid wallet address");
    }

    const challenge = generateChallenge(walletAddress);
    const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MS);

    await prisma.authChallenge.upsert({
      where: { walletAddress },
      create: { walletAddress, challenge, expiresAt },
      update: { challenge, expiresAt },
    });

    res.json({ challenge, walletAddress });
  });

  // Verify signature and return JWT
  const verifySchema = z.object({
    walletAddress: z.string(),
    signature: z.string(),
  });

  /**
   * @openapi
   * /auth/verify:
   *   post:
   *     summary: Verify signature and return JWT
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               walletAddress:
   *                 type: string
   *                 description: User's Stellar wallet address
   *               signature:
   *                 type: string
   *                 description: Signature of the challenge message
   *             required:
   *               - walletAddress
   *               - signature
   *     responses:
   *       200:
   *         description: Signature verified and JWT returned
   *       400:
   *         description: Invalid request or challenge expired
   *       401:
   *         description: Invalid signature
   */
  v1Router.post("/auth/verify", authLimiter, async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body");
    }

    const { walletAddress, signature } = parsed.data;

    if (!isValidStellarAddress(walletAddress)) {
      return sendError(res, 400, "Invalid wallet address");
    }

    try {
      const challengeRow = await prisma.authChallenge.findUnique({
        where: { walletAddress },
      });
      if (!challengeRow) {
        return sendError(res, 400, "No challenge found for this wallet");
      }

      // Check if challenge expired
      if (challengeRow.expiresAt < new Date()) {
        await prisma.authChallenge.delete({ where: { walletAddress } });
        return sendError(res, 400, "Challenge expired");
      }

      // Verify the signature
      const isValid = verifySignature(
        walletAddress,
        challengeRow.challenge,
        signature,
      );
      if (!isValid) {
        return sendError(res, 401, "Invalid signature");
      }

      // Clear the used challenge
      await prisma.authChallenge.delete({ where: { walletAddress } });

      // Create or get user
      let user = await prisma.user.findFirst({
        where: { email: walletAddress },
      });

      if (!user) {
        user = await prisma.user.create({
          data: { email: walletAddress },
        });
      }

      // Sign JWT
      const token = signJWT(walletAddress, user.id);

      // Attach wallet address as Sentry user context for session breadcrumbs
      if (process.env.SENTRY_DSN) {
        Sentry.setUser({ id: user.id, username: walletAddress });
      }

      // #759: Set httpOnly cookie so the browser sends it automatically.
      // The token is still returned in the JSON body for API / mobile consumers
      // that cannot access httpOnly cookies.
      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 1000, // 1 hour — matches JWT_EXPIRY
      });

      res.json({ token, walletAddress, userId: user.id });
    } catch (error) {
      // #974: two concurrent /auth/verify calls for the same wallet can both
      // read the same challenge row before either deletes it — the loser's
      // delete throws P2025, or its user.create() throws P2002 on the email
      // unique constraint. Both mean the other request already completed
      // the verification, so the client can just retry.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "P2025" || error.code === "P2002")
      ) {
        return sendError(
          res,
          409,
          "Verification already in progress for this wallet, please retry",
          "VERIFY_RACE",
        );
      }
      req.log.error({ err: error }, "Error verifying auth challenge");
      return sendError(res, 500, "Internal server error");
    }
  });

  /**
   * @openapi
   * /auth/logout:
   *   post:
   *     summary: Invalidate the current session server-side
   *     description: |
   *       Revokes the JWT presented in the Authorization header or auth_token cookie by
   *       storing its jti until expiry, and clears the auth_token cookie.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Logged out
   *       401:
   *         description: Missing or invalid token
   */
  v1Router.post("/auth/logout", requireAuth, async (req, res) => {
    try {
      if (req.auth?.jti && req.auth.exp) {
        await prisma.revokedToken.upsert({
          where: { jti: req.auth.jti },
          create: { jti: req.auth.jti, expiresAt: new Date(req.auth.exp * 1000) },
          update: {},
        });
      }

      res.clearCookie("auth_token");
      res.json({ ok: true });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error during logout");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── List profiles with pagination ──────────────────────────────────────

  /**
   * @openapi
   * /profiles:
   *   get:
   *     summary: List profiles with pagination
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *           example: 20
   *         description: "Number of profiles to return (Min: 1, Max: 100)"
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *           example: 0
   *         description: Number of profiles to skip
   *       - in: query
   *         name: search
   *         schema:
   *           type: string
   *           maxLength: 100
   *           example: john
   *         description: Optional search term for username or displayName (case-insensitive)
   *       - in: query
   *         name: sort
   *         schema:
   *           type: string
   *           enum: [newest, most_supported, most_transactions]
   *           default: newest
   *           example: newest
   *         description: Sort order for profiles
   *       - in: query
   *         name: asset
   *         schema:
   *           type: string
   *           example: XLM
   *         description: Filter by accepted asset code (e.g., XLM, USDC)
   *       - in: query
   *         name: assetIssuer
   *         schema:
   *           type: string
   *           example: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJ2E37CEGOEZWDSP
   *         description: >
   *           Filter by asset issuer address. Use together with `asset` to distinguish
   *           different issuers of the same asset code (e.g., Circle USDC vs another USDC).
   *           Omit or leave empty to return profiles accepting any issuer of the given asset.
   *     responses:
   *       200:
   *         description: List of profiles
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 profiles:
   *                   type: array
   *                   items:
   *                     type: object
   *                 total:
   *                   type: integer
   *                   example: 42
   *                 limit:
   *                   type: integer
   *                   example: 20
   *                 offset:
   *                   type: integer
   *                   example: 0
   *       500:
   *         description: Internal server error
   */
  v1Router.get("/profiles", async (req, res) => {
    try {
      const pagination = paginationSchema.safeParse(req.query);
      if (!pagination.success) {
        return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
      }
      const { limit, offset } = pagination.data;
      const rawSearch =
        typeof req.query.search === "string" ? req.query.search : "";
      const search = rawSearch.trim().slice(0, 100);
      const sort = (req.query.sort as string) || "newest";
      const asset = typeof req.query.asset === "string" ? req.query.asset : "";
      // #287: optional issuer filter so callers can distinguish e.g.
      // circle.com USDC from a different USDC issuer. Empty value means
      // "any issuer" and falls back to the existing behaviour.
      const assetIssuer =
        typeof req.query.assetIssuer === "string"
          ? req.query.assetIssuer.trim()
          : "";

      const where = search
        ? {
            OR: [
              { username: { contains: search, mode: "insensitive" as const } },
              {
                displayName: { contains: search, mode: "insensitive" as const },
              },
            ],
          }
        : {};

      let orderBy: object = { createdAt: "desc" };

      if (sort === "most_supported" || sort === "most_transactions") {
        // For sorting by support metrics, we fetch up to 1000 profiles to
        // avoid loading unbounded rows into memory (#790). A production-grade
        // solution should use a precomputed totalSupported column incremented
        // transactionally. The take cap is a safe short-term mitigation.
        const profiles = await prisma.profile.findMany({
          where,
          take: 1000,
          select: {
            id: true,
            username: true,
            displayName: true,
            bio: true,
            avatarUrl: true,
            websiteUrl: true,
            twitterHandle: true,
            githubHandle: true,
            walletAddress: true,
            viewCount: true,
            createdAt: true,
            updatedAt: true,
            acceptedAssets: true,
            supportTransactions: {
              where: { status: "SUCCESS" },
              select: { amount: true, supporterAddress: true },
            },
          },
        });

        let sorted = profiles;
        if (sort === "most_supported") {
          sorted = profiles.sort((a: any, b: any) => {
            const aTotal = a.supportTransactions.reduce(
              (sum: number, tx: any) => sum + Number(tx.amount),
              0,
            );
            const bTotal = b.supportTransactions.reduce(
              (sum: number, tx: any) => sum + Number(tx.amount),
              0,
            );
            return bTotal - aTotal;
          });
        } else if (sort === "most_transactions") {
          sorted = profiles.sort(
            (a: any, b: any) =>
              b.supportTransactions.length - a.supportTransactions.length,
          );
        }

        const filtered = asset
          ? sorted.filter((p: any) =>
              p.acceptedAssets.some(
                (a: any) =>
                  a.code === asset &&
                  (assetIssuer === "" || a.issuer === assetIssuer),
              ),
            )
          : sorted;

        const paginated = filtered.slice(offset, offset + limit);
        const result = paginated.map((p: any) => {
          const { supportTransactions: _supportTransactions, ...profile } = p;
          return profile;
        });

        return res.json({
          profiles: result,
          total: filtered.length,
          limit,
          offset,
        });
      }

      // Default sorting by newest.
      // When an asset filter is supplied, push it into the DB query so that
      // `total` reflects the actual matched count rather than the page-slice
      // size returned by an in-memory filter (#602).
      const assetWhere = asset
        ? {
            acceptedAssets: {
              some: {
                code: asset,
                ...(assetIssuer !== "" ? { issuer: assetIssuer } : {}),
              },
            },
          }
        : {};

      const combinedWhere = { ...where, ...assetWhere };

      const [profiles, total] = await Promise.all([
        prisma.profile.findMany({
          where: combinedWhere,
          take: limit,
          skip: offset,
          orderBy,
          select: {
            id: true,
            username: true,
            displayName: true,
            bio: true,
            avatarUrl: true,
            websiteUrl: true,
            twitterHandle: true,
            githubHandle: true,
            walletAddress: true,
            viewCount: true,
            createdAt: true,
            updatedAt: true,
            acceptedAssets: true,
          },
        }),
        prisma.profile.count({ where: combinedWhere }),
      ]);

      res.json({
        profiles,
        total,
        limit,
        offset,
      });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error listing profiles");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Search profiles ────────────────────────────────────────────────────

  /**
   * @openapi
   * /profiles/search:
   *   get:
   *     summary: Search profiles with fuzzy matching
   *     description: |
   *       Searches profiles by username or display name using PostgreSQL pg_trgm fuzzy matching.
   *       Tolerates typos and returns results sorted by relevance score.
   *       Returns suggestions when no matches are found.
   *     parameters:
   *       - in: query
   *         name: q
   *         required: true
   *         schema:
   *           type: string
   *           minLength: 1
   *           maxLength: 100
   *           example: jhonn
   *         description: Search query (fuzzy, typo-tolerant)
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 50
   *           default: 10
   *         description: Max results to return
   *     responses:
   *       200:
   *         description: Search results sorted by relevance
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 profiles:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       username:
   *                         type: string
   *                         example: john_doe
   *                       displayName:
   *                         type: string
   *                         example: John Doe
   *                       avatarUrl:
   *                         type: string
   *                         nullable: true
   *                       bio:
   *                         type: string
   *                       relevance:
   *                         type: number
   *                         format: float
   *                         description: Similarity score (0–1)
   *                         example: 0.65
   *                 suggestions:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: Suggested usernames when no profiles match
   *             examples:
   *               matchFound:
   *                 summary: Profiles found
   *                 value:
   *                   profiles:
   *                     - username: john_doe
   *                       displayName: John Doe
   *                       avatarUrl: "https://example.com/avatar.jpg"
   *                       bio: "Creator on Stellar"
   *                       relevance: 0.65
   *                   suggestions: []
   *               noMatch:
   *                 summary: No matches — suggestions returned
   *                 value:
   *                   profiles: []
   *                   suggestions: ["john_doe", "jane_doe"]
   *                   message: "No profiles found. Did you mean one of these?"
   *       400:
   *         description: Missing or empty query parameter
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Query parameter 'q' is required and cannot be empty"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  v1Router.get("/profiles/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (!q) {
      return sendError(
        res,
        400,
        "Query parameter 'q' is required and cannot be empty",
      );
    }

    try {
      const pagination = profileSearchPaginationSchema.safeParse(req.query);
      if (!pagination.success) {
        return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
      }
      const { limit } = pagination.data;

      // Fuzzy search with relevance scoring using pg_trgm similarity
      const profiles = await prisma.$queryRawUnsafe<
        Array<{
          username: string;
          displayName: string;
          avatarUrl: string | null;
          bio: string;
          relevance: number;
        }>
      >(
        `SELECT
          "username",
          "displayName",
          "avatarUrl",
          "bio",
          GREATEST(
            similarity("username", $1),
            similarity("displayName", $1)
          ) AS relevance
        FROM "Profile"
        WHERE
          similarity("username", $1) > 0.1
          OR similarity("displayName", $1) > 0.1
          OR "username" ILIKE '%' || $1 || '%'
          OR "displayName" ILIKE '%' || $1 || '%'
        ORDER BY relevance DESC, "username" ASC
        LIMIT $2`,
        q,
        limit,
      );

      if (profiles.length === 0) {
        // Return search suggestions when no results found
        const suggestions = await prisma.$queryRawUnsafe<
          Array<{ username: string; displayName: string }>
        >(
          `SELECT "username", "displayName"
          FROM "Profile"
          WHERE similarity("username", $1) > 0.05
            OR "username" ILIKE '%' || $1 || '%'
          ORDER BY similarity("username", $1) DESC
          LIMIT 3`,
          q,
        );

        return res.json({
          profiles: [],
          suggestions: suggestions.map((s) => s.username),
          message: "No profiles found. Did you mean one of these?",
        });
      }

      res.json({ profiles, suggestions: [] });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error searching profiles");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Get profile by username ────────────────────────────────────────────

  /**
   * @openapi
   * /profiles/{username}:
   *   get:
   *     summary: Get a profile by username
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *           example: john_doe
   *     responses:
   *       200:
   *         description: Profile found
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   *                 username:
   *                   type: string
   *                 displayName:
   *                   type: string
   *                 bio:
   *                   type: string
   *                 avatarUrl:
   *                   type: string
   *                   nullable: true
   *                 walletAddress:
   *                   type: string
   *                 isOwner:
   *                   type: boolean
   *                   description: Present on authenticated requests; true when the JWT user owns this profile.
   *                 email:
   *                   type: string
   *                   nullable: true
   *                 websiteUrl:
   *                   type: string
   *                   nullable: true
   *                 twitterHandle:
   *                   type: string
   *                   nullable: true
   *                 githubHandle:
   *                   type: string
   *                   nullable: true
   *                 acceptedAssets:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       code:
   *                         type: string
   *                       issuer:
   *                         type: string
   *                         nullable: true
   *                 createdAt:
   *                   type: string
   *                   format: date-time
   *             example:
   *               id: "clx1abc123"
   *               username: "john_doe"
   *               displayName: "John Doe"
   *               bio: "Stellar ecosystem builder"
   *               avatarUrl: "https://example.com/avatar.jpg"
   *               walletAddress: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
   *               isOwner: true
   *               email: "john@example.com"
   *               websiteUrl: "https://johndoe.com"
   *               twitterHandle: "johndoe"
   *               githubHandle: "johndoe"
   *               acceptedAssets:
   *                 - code: "XLM"
   *                 - code: "USDC"
   *                   issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJ2E37CEGOEZWDSP"
   *               createdAt: "2025-01-15T10:30:00.000Z"
   *       404:
   *         description: Profile not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Profile not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // #463 — view count: increment once per IP per hour via viewCountLimiter
//   app.get("/profiles/:username", async (req, res) => {
  v1Router.get("/profiles/:username", optionalAuth, async (req, res) => {
    try {
      const profile = await prisma.profile.findUnique({
        where: { username: req.params.username as string },
        select: {
          id: true,
          username: true,
          displayName: true,
          bio: true,
          avatarUrl: true,
          websiteUrl: true,
          twitterHandle: true,
          githubHandle: true,
          walletAddress: true,
          ownerId: true,
          viewCount: true,
          createdAt: true,
          updatedAt: true,
          acceptedAssets: true,
        },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Attempt to increment view count; viewCountLimiter will skip duplicate
      // IPs within the same hour window (applied as middleware below).
      // Skip increment if the viewer is the profile owner (#542).
      const isOwner = isProfileOwner(req.auth, profile);
      if (!isOwner) {
        void prisma.profile.update({
          where: { id: profile.id },
          data: { viewCount: { increment: 1 } },
        }).catch(() => {
          // Non-fatal — do not block the response
        });
      }

      const { ownerId: _, ...publicProfile } = profile;
      const responseBody: Record<string, unknown> = { ...publicProfile };
      if (req.auth) {
        responseBody.isOwner = isOwner;
      }

      res.json(responseBody);
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error fetching profile");
      return sendError(res, 500, "Internal server error");
    }
  });

  // Apply per-IP view count limiter (rate-limits the increment, not the read)
  app.use("/profiles/:username", viewCountLimiter);

//   app.get("/profiles/:username/stats", async (req, res) => {
  v1Router.get("/profiles/:username/stats", async (req, res) => {
    try {
      const profile = await prisma.profile.findUnique({
        where: { username: req.params.username },
        select: { id: true },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      const profileId = profile.id;
      const where = { profileId, status: { not: "failed" } };

      const [uniqueSupportersList, assetGroups, aggregates] = await Promise.all([
        prisma.supportTransaction.findMany({
          where: { ...where, supporterAddress: { not: null } },
          distinct: ["supporterAddress"],
          select: { supporterAddress: true },
        }),
        prisma.supportTransaction.groupBy({
          by: ["assetCode", "assetIssuer"],
          where,
          _sum: { amount: true },
          _count: true,
        }),
        prisma.supportTransaction.aggregate({
          where,
          _min: { createdAt: true },
          _max: { createdAt: true },
        }),
      ]);

      const totalTransactions = assetGroups.reduce((acc: number, g: any) => acc + g._count, 0);

      const assetTotals = assetGroups.map((g: any) => ({
        assetCode: g.assetCode,
        assetIssuer: g.assetIssuer,
        total: g._sum.amount ? g._sum.amount.toFixed(7) : "0.0000000",
      }));

      res.json({
        totalTransactions,
        uniqueSupporters: uniqueSupportersList.length,
        assetTotals,
        firstSupportedAt: aggregates._min.createdAt ? aggregates._min.createdAt.toISOString() : null,
        lastSupportedAt: aggregates._max.createdAt ? aggregates._max.createdAt.toISOString() : null,
      });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error fetching profile stats");
      return sendError(res, 500, "Internal server error");
    }
  });

  const stellarAddress = z
    .string()
    .refine((val) => StrKey.isValidEd25519PublicKey(val), {
      message: "Must be a valid Stellar public key",
    });

  const createProfileSchema = z.object({
    username: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9-]+$/),
    displayName: z.string().min(1).max(64),
    bio: z.string().max(280).optional().default(""),
    walletAddress: stellarAddress,
    email: z.string().email().optional().nullable(),
    websiteUrl: z.string().url().startsWith("https://").optional().nullable(),
    twitterHandle: z
      .string()
      .max(15)
      .regex(/^[a-zA-Z0-9_]+$/)
      .optional()
      .nullable(),
    githubHandle: z
      .string()
      .max(39)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,37}[a-zA-Z0-9]$/)
      .optional()
      .nullable(),
    // ownerId removed - now derived from JWT
    acceptedAssets: z
      .array(
        z
          .object({
            code: z.string().min(1).max(12),
            issuer: z.string().optional(),
          })
          .refine(
            (asset) =>
              asset.code.toUpperCase() === "XLM" ||
              (typeof asset.issuer === "string" && asset.issuer.trim().length > 0),
            { message: "issuer is required for non-XLM assets" },
          ),
      )
      .min(1),
  });

  /**
   * @openapi
   * /profiles:
   *   post:
   *     summary: Create a new profile
   *     description: |
   *       Create a new creator profile. Requires JWT authentication — the wallet address in the request must match the authenticated user.
   *       **Rate limits:** 3 profiles per hour per IP (profile creation limiter) + 20 requests per 15 min (write limiter).
   *       Usernames must be 3–32 characters, lowercase alphanumeric with hyphens only.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               username:
   *                 type: string
   *                 minLength: 3
   *                 maxLength: 32
   *                 pattern: '^[a-z0-9-]+$'
   *                 example: john_doe
   *               displayName:
   *                 type: string
   *                 maxLength: 64
   *                 example: John Doe
   *               bio:
   *                 type: string
   *                 maxLength: 280
   *                 example: "Stellar ecosystem builder and content creator"
   *               walletAddress:
   *                 type: string
   *                 example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
   *               email:
   *                 type: string
   *                 format: email
   *                 example: john@example.com
   *               websiteUrl:
   *                 type: string
   *                 format: uri
   *                 example: "https://johndoe.com"
   *               twitterHandle:
   *                 type: string
   *                 example: johndoe
   *               githubHandle:
   *                 type: string
   *                 example: johndoe
   *               acceptedAssets:
   *                 type: array
   *                 minItems: 1
   *                 items:
   *                   type: object
   *                   properties:
   *                     code:
   *                       type: string
   *                       example: XLM
   *                     issuer:
   *                       type: string
   *                       example: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJ2E37CEGOEZWDSP
   *                   required:
   *                     - code
   *             required:
   *               - username
   *               - displayName
   *               - walletAddress
   *               - acceptedAssets
   *     responses:
   *       201:
   *         description: Profile created
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: Created profile with acceptedAssets
   *       400:
   *         description: Invalid request body or validation failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Invalid request body"
   *       401:
   *         description: Missing or invalid JWT
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       403:
   *         description: Wallet address does not match authenticated user
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Forbidden: Wallet address does not match authenticated user"
   *       409:
   *         description: Email or username already taken
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             examples:
   *               usernameTaken:
   *                 value:
   *                   error: "Username already taken"
   *                   code: "USERNAME_TAKEN"
   *               emailTaken:
   *                 value:
   *                   error: "Email already taken"
   *                   code: "EMAIL_TAKEN"
   *       429:
   *         description: Rate limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Too many profiles created from this IP address. Please try again in an hour."
   *               code: "RATE_LIMIT_EXCEEDED"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  v1Router.post("/profiles", requireAuth, profileCreationLimiter, writeLimiter, async (req, res) => {
    const parsed = createProfileSchema.safeParse(req.body);

    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.flatten() }, "validation failed");
      return res.status(400).json({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        fields: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      username,
      displayName,
      bio,
      walletAddress,
      email,
      websiteUrl,
      twitterHandle,
      githubHandle,
      acceptedAssets,
    } = parsed.data;

    // Validate username against reserved words, profanity, and confusing patterns
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      req.log.warn({ username }, "username validation failed");
      return res.status(400).json({
        error: usernameValidation.error,
        suggestions: usernameValidation.suggestions,
      });
    }

    // Verify authenticated wallet matches the profile wallet address
    if (!req.auth || req.auth.walletAddress !== walletAddress) {
      return sendError(
        res,
        403,
        "Forbidden: Wallet address does not match authenticated user",
      );
    }

    try {
      // Resolve the User FK. Normal JWTs from /auth/verify always carry userId;
      // JWTs signed without userId (e.g. older tokens) fall back to finding or
      // creating a User by wallet address (mirroring what /auth/verify does).
      let ownerId = req.auth.userId;
      if (!ownerId) {
        const existing = await prisma.user.findFirst({ where: { email: walletAddress } });
        ownerId = existing
          ? existing.id
          : (await prisma.user.create({ data: { email: walletAddress } })).id;
      }

      const emailVerificationToken = email ? randomBytes(32).toString("hex") : undefined;
      const emailVerificationExpiry = email ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined;

      const profile = await prisma.profile.create({
        data: {
          username,
          displayName,
          bio,
          walletAddress,
          email,
          emailVerified: false,
          emailVerificationToken,
          emailVerificationExpiry,
          websiteUrl,
          twitterHandle,
          githubHandle,
          ownerId,
          acceptedAssets: { create: acceptedAssets },
        },
        include: { acceptedAssets: true },
      });

      if (email && emailVerificationToken) {
        sendVerificationEmail(email, username, emailVerificationToken).catch((err) =>
          req.log.warn({ err }, "Failed to send verification email"),
        );
      }

      req.log.info({ username: profile.username }, "profile created");
      return res.status(201).json(profile);
    } catch (e: unknown) {
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        const meta = (e as { meta?: { target?: string[] } }).meta;
        const field = meta?.target?.includes("email") ? "Email" : "Username";
        return sendError(
          res,
          409,
          `${field} already taken`,
          `${field.toUpperCase()}_TAKEN`,
        );
      }
      req.log.error({ err: e }, "database error creating profile");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Update profile ────────────────────────────────────────────────────

  const updateProfileSchema = z.object({
    displayName: z.string().min(1).max(64).optional(),
    bio: z.string().max(280).optional(),
    avatarUrl: z.string().url().optional().nullable(),
    email: z.string().email().optional().nullable(),
    websiteUrl: z.string().url().startsWith("https://").optional().nullable(),
    twitterHandle: z
      .string()
      .max(15)
      .regex(/^[a-zA-Z0-9_]+$/)
      .optional()
      .nullable(),
    githubHandle: z
      .string()
      .max(39)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,37}[a-zA-Z0-9]$/)
      .optional()
      .nullable(),
  });

  /**
   * @openapi
   * /profiles/{username}:
   *   patch:
   *     summary: Update profile
   *     description: |
   *       Update profile fields. Requires authentication — the JWT wallet address must match the profile owner.
   *       Changing email triggers a new verification email.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *           example: john_doe
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               displayName:
   *                 type: string
   *                 maxLength: 64
   *                 example: "John D."
   *               bio:
   *                 type: string
   *                 maxLength: 280
   *                 example: "Updated bio — Stellar builder"
   *               avatarUrl:
   *                 type: string
   *                 format: uri
   *               email:
   *                 type: string
   *                 format: email
   *                 example: "newemail@example.com"
   *               websiteUrl:
   *                 type: string
   *                 format: uri
   *                 example: "https://johndoe.com"
   *               twitterHandle:
   *                 type: string
   *                 example: "johndoe"
   *               githubHandle:
   *                 type: string
   *                 example: "johndoe"
   *     responses:
   *       200:
   *         description: Profile updated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: Updated profile object with acceptedAssets
   *       400:
   *         description: Invalid request body
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Invalid request body"
   *       401:
   *         description: Missing or invalid authentication token
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Unauthorized"
   *       403:
   *         description: Authenticated user does not own this profile
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Forbidden: You do not own this profile"
   *       404:
   *         description: Profile not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Profile not found"
   *       409:
   *         description: Email already in use
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Email already in use"
   *               code: "EMAIL_TAKEN"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  v1Router.patch(
    "/profiles/:username",
    requireAuth,
    writeLimiter,
    async (req, res) => {
      const parsed = updateProfileSchema.safeParse(req.body);

      if (!parsed.success) {
        req.log.warn({ issues: parsed.error.flatten() }, "validation failed");
        return res.status(400).json({
          error: "Validation failed",
          code: "VALIDATION_ERROR",
          fields: parsed.error.flatten().fieldErrors,
        });
      }

      const username = req.params.username as string;
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      try {
        const emailChanged =
          parsed.data.email !== undefined && parsed.data.email !== profile.email;
        const newEmail = parsed.data.email;
        const emailVerificationToken =
          emailChanged && newEmail ? randomBytes(32).toString("hex") : undefined;
        const emailVerificationExpiry =
          emailChanged && newEmail
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : undefined;

        const updated = await prisma.profile.update({
          where: { username },
          data: {
            ...parsed.data,
            ...(emailChanged
              ? {
                  emailVerified: false,
                  emailVerificationToken,
                  emailVerificationExpiry,
                }
              : {}),
          },
          include: { acceptedAssets: true },
        });

        if (emailChanged && newEmail && emailVerificationToken) {
          sendVerificationEmail(newEmail, username, emailVerificationToken).catch((err) =>
            req.log.warn({ err }, "Failed to send verification email on update"),
          );
        }

        return res.json(updated);
      } catch (e: unknown) {
        if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
          // Inspect meta.target to tell the caller which unique field is taken.
          // The creation endpoint uses the same pattern so clients receive a
          // consistent error shape across both operations (#603).
          const meta = (e as { meta?: { target?: string[] } }).meta;
          const field = meta?.target?.includes("email") ? "Email" : "Username";
          return sendError(res, 409, `${field} already taken`, `${field.toUpperCase()}_TAKEN`);
        }
        req.log.error({ err: e }, "database error updating profile");
        return sendError(res, 500, "Internal server error");
      }
    },
  );

  // ── GitHub profile import (#474) ──────────────────────────────────────

  /**
   * @openapi
   * /profiles/{username}/import/github:
   *   post:
   *     summary: Import profile data from GitHub
   *     description: |
   *       Fetches the authenticated user's public GitHub profile and applies
   *       displayName, bio, avatarUrl, websiteUrl, twitterHandle, and githubHandle
   *       to the specified NovaSupport profile. The caller must own the profile.
   *       Supply a personal access token in `githubToken` to avoid the 60 req/hr
   *       unauthenticated rate limit; alternatively set GITHUB_TOKEN server-side.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *         description: NovaSupport username of the profile to update
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - githubUsername
   *             properties:
   *               githubUsername:
   *                 type: string
   *                 description: GitHub username to import from
   *                 example: octocat
   *               githubToken:
   *                 type: string
   *                 description: Optional GitHub personal access token
   *     responses:
   *       200:
   *         description: Profile updated with GitHub data
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 profile:
   *                   type: object
   *                   description: Updated profile
   *                 imported:
   *                   type: object
   *                   description: Fields that were applied from GitHub
   *       400:
   *         description: Missing or invalid githubUsername
   *       401:
   *         description: Missing or invalid authentication
   *       403:
   *         description: Caller does not own this profile
   *       404:
   *         description: Profile or GitHub user not found
   *       429:
   *         description: GitHub API rate limit exceeded
   *       503:
   *         description: GitHub API unreachable
   */
  v1Router.post(
    "/profiles/:username/import/github",
    requireAuth,
    writeLimiter,
    async (req, res) => {
      const importSchema = z.object({
        githubUsername: z.string().min(2).max(39).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,37}[a-zA-Z0-9]$/),
        githubToken: z.string().optional(),
      });

      const parsed = importSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "githubUsername is required (2–39 chars: alphanumeric, hyphens, or dots; must start and end with alphanumeric)");
      }

      const { githubUsername, githubToken } = parsed.data;
      const username = req.params.username as string;

      const profile = await prisma.profile.findUnique({ where: { username } });
      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      let ghData;
      try {
        const { fetchGitHubProfile, mapGitHubToNovaSupport, GitHubUserNotFoundError, GitHubRateLimitError } =
          await import("./services/profile-importer.js");
        ghData = mapGitHubToNovaSupport(await fetchGitHubProfile(githubUsername, githubToken));

        // GitHub-sourced fields never pass through req.body, so the global
        // sanitizeBody middleware never runs on them — sanitize explicitly here
        // using the same helper to avoid a stored-XSS bypass.
        ghData.displayName = sanitizeString("displayName", ghData.displayName).result;
        ghData.bio = sanitizeString("bio", ghData.bio).result;
        if (ghData.websiteUrl) {
          ghData.websiteUrl = sanitizeString("websiteUrl", ghData.websiteUrl).result || null;
        }
        if (ghData.twitterHandle) {
          ghData.twitterHandle = sanitizeString("twitterHandle", ghData.twitterHandle).result || null;
        }
        if (ghData.avatarUrl) {
          ghData.avatarUrl = sanitizeString("avatarUrl", ghData.avatarUrl).result || null;
        }

        const updated = await prisma.profile.update({
          where: { username },
          data: {
            displayName: ghData.displayName,
            bio: ghData.bio,
            avatarUrl: ghData.avatarUrl,
            websiteUrl: ghData.websiteUrl ?? undefined,
            twitterHandle: ghData.twitterHandle ?? undefined,
            githubHandle: ghData.githubHandle,
          },
          include: { acceptedAssets: true },
        });

        req.log.info(
          { username, githubUsername },
          "GitHub profile import applied",
        );

        return res.json({ profile: updated, imported: ghData });
      } catch (e: unknown) {
        if (e && typeof e === "object" && "name" in e) {
          if ((e as { name: string }).name === "GitHubUserNotFoundError") {
            return sendError(res, 404, `GitHub user '${githubUsername}' not found`);
          }
          if ((e as { name: string }).name === "GitHubRateLimitError") {
            return sendError(res, 429, "GitHub API rate limit exceeded. Set GITHUB_TOKEN to increase limits.");
          }
          if ((e as { name: string }).name === "GitHubFetchError") {
            req.log.error({ err: e, githubUsername }, "GitHub API error during profile import");
            return sendError(res, 503, "Unable to reach GitHub API. Please try again later.");
          }
        }
        req.log.error({ err: e, username, githubUsername }, "unexpected error during GitHub profile import");
        return sendError(res, 500, "Internal server error");
      }
    },
  );

  // ── Email verification (#275) ─────────────────────────────────────────

  v1Router.post("/profiles/:username/verify-email", requireAuth, async (req, res) => {
    const { token } = req.body as { token?: unknown };

    if (!token || typeof token !== "string") {
      return sendError(res, 400, "Verification token is required");
    }

    try {
      const profile = await prisma.profile.findFirst({
        where: { username: req.params.username as string, emailVerificationToken: token },
      });

      if (!profile) {
        return sendError(res, 404, "Invalid or expired verification token", "TOKEN_INVALID");
      }

      // Ensure the authenticated user owns this profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      if (profile.emailVerificationExpiry && profile.emailVerificationExpiry < new Date()) {
        return sendError(res, 410, "Verification token has expired", "TOKEN_EXPIRED");
      }

      await prisma.profile.update({
        where: { id: profile.id },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationExpiry: null,
        },
      });

      return res.json({ ok: true, message: "Email verified successfully" });
    } catch (e: unknown) {
      req.log.error({ err: e }, "error during email verification");
      return sendError(res, 500, "Internal server error");
    }
  });

  v1Router.post(
    "/profiles/:username/resend-verification-email",
    requireAuth,
    resendLimiter,
    async (req, res) => {
      const username = req.params.username as string;
      try {
        const profile = await prisma.profile.findUnique({
          where: { username },
          include: { owner: true },
        });

        if (!profile) {
          return sendError(res, 404, "Profile not found");
        }

        if (!isProfileOwner(req.auth, profile)) {
          return sendError(res, 403, "Forbidden");
        }

        if (profile.emailVerified) {
          return sendError(res, 400, "Email already verified");
        }

        if (!profile.email) {
          return sendError(res, 400, "No email address associated with this profile");
        }

        const token = randomBytes(32).toString("hex");
        const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

        await prisma.profile.update({
          where: { id: profile.id },
          data: {
            emailVerificationToken: token,
            emailVerificationExpiry: expiry,
          },
        });

        await sendVerificationEmail(profile.email, profile.username, token);

        return res.json({ ok: true, message: "Verification email resent" });
      } catch (e: unknown) {
        req.log.error({ err: e }, "error resending verification email");
        return sendError(res, 500, "Internal server error");
      }
    },
  );

  // ── Notification preferences (#475) ──────────────────────────────────

  const notifPrefsSchema = z.object({
    notifyOnSupport: z.boolean().optional(),
    notifyOnMilestone: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
  });

  v1Router.get("/profiles/:username/notification-preferences", requireAuth, async (req, res) => {
    const username = req.params.username as string;

    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) return sendError(res, 404, "Profile not found");

    if (!isProfileOwner(req.auth, profile)) {
      return sendError(res, 403, "Forbidden: You do not own this profile");
    }

    const prefs = await prisma.notificationPreferences.findUnique({
      where: { profileId: profile.id },
    });

    // Return defaults when no preferences row exists yet
    return res.json(
      prefs ?? {
        notifyOnSupport: true,
        notifyOnMilestone: true,
        weeklyDigest: false,
      },
    );
  });

  v1Router.patch("/profiles/:username/notification-preferences", requireAuth, writeLimiter, async (req, res) => {
    const username = req.params.username as string;

    const parsed = notifPrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body");
    }

    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) return sendError(res, 404, "Profile not found");

    if (!isProfileOwner(req.auth, profile)) {
      return sendError(res, 403, "Forbidden: You do not own this profile");
    }

    const prefs = await prisma.notificationPreferences.upsert({
      where: { profileId: profile.id },
      update: parsed.data,
      create: {
        profileId: profile.id,
        notifyOnSupport: parsed.data.notifyOnSupport ?? true,
        notifyOnMilestone: parsed.data.notifyOnMilestone ?? true,
        weeklyDigest: parsed.data.weeklyDigest ?? false,
      },
    });

    return res.json(prefs);
  });

  // ── Update accepted assets ────────────────────────────────────────────

  const updateAssetsSchema = z.object({
    assets: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Z]{1,12}$/),
            issuer: z.string().optional(),
          })
          .refine(
            (asset) =>
              asset.code === "XLM" ||
              (typeof asset.issuer === "string" && asset.issuer.trim().length > 0),
            { message: "issuer is required for non-XLM assets" },
          ),
      )
      .min(1)
      .max(50),
  });

  /**
   * @openapi
   * /profiles/{username}/assets:
   *   patch:
   *     summary: Replace accepted assets for a profile
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               assets:
   *                 type: array
   *                 minItems: 1
   *                 items:
   *                   type: object
   *                   properties:
   *                     code:
   *                       type: string
   *                     issuer:
   *                       type: string
   *                   required:
   *                     - code
   *             required:
   *               - assets
   *     responses:
   *       200:
   *         description: Assets replaced, updated profile returned
   *       403:
   *         description: Authenticated user does not own this profile
   *       404:
   *         description: Profile not found
   *       422:
   *         description: Empty array or invalid asset code
   *       500:
   *         description: Internal server error
   */
  v1Router.patch(
    "/profiles/:username/assets",
    requireAuth,
    writeLimiter,
    async (req, res) => {
      const parsed = updateAssetsSchema.safeParse(req.body);

      if (!parsed.success) {
        req.log.warn({ issues: parsed.error.flatten() }, "validation failed");
        return sendError(res, 422, "Invalid assets");
      }

      const username = req.params.username as string;
      const profile = await prisma.profile.findUnique({ where: { username } });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      try {
        // Deduplicate assets by (code, issuer) before insert
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const asset of parsed.data.assets) {
          const key = `${asset.code}:${asset.issuer ?? ""}`;
          if (seen.has(key)) {
            duplicates.push(`${asset.code}${asset.issuer ? ` (issuer ${asset.issuer})` : ""}`);
          }
          seen.add(key);
        }
        if (duplicates.length > 0) {
          return sendError(res, 422, `Duplicate assets: ${duplicates.join(", ")}`);
        }

        await prisma.$transaction([
          prisma.acceptedAsset.deleteMany({ where: { profileId: profile.id } }),
          prisma.acceptedAsset.createMany({
            data: parsed.data.assets.map((a) => ({
              ...a,
              profileId: profile.id,
            })),
          }),
        ]);

        const updated = await prisma.profile.findUnique({
          where: { username },
          include: { acceptedAssets: true },
        });

        return res.json(updated);
      } catch (e: unknown) {
        req.log.error({ err: e }, "database error updating assets");
        return sendError(res, 500, "Internal server error");
      }
    },
  );

  // ── Support transactions ───────────────────────────────────────────────

  const supportPayloadSchema = z.object({
    txHash: z.string().min(3),
    amount: z.string()
      .regex(/^\d+(\.\d{1,7})?$/, "amount must be a positive decimal with up to 7 decimal places")
      .refine(v => parseFloat(v) > 0, "amount must be greater than zero"),
    assetCode: z.string().min(1),
    assetIssuer: z.string().optional().nullable(),
    status: z.enum(["pending", "SUCCESS", "failed"]).default("pending"),
    message: z.string().max(280).optional().nullable(),
    memo: z
      .string()
      .refine((value) => Buffer.byteLength(value, "utf8") <= 28, {
        message: "Text memo must be 28 bytes or fewer",
      })
      .optional()
      .nullable(),
    stellarNetwork: z.string().default(process.env.INDEXER_NETWORK ?? "TESTNET"),
    supporterAddress: z.string().optional().nullable(),
    recipientAddress: z.string().min(1),
    profileId: z.string().min(1),
    supporterId: z.string().optional().nullable(),
    recurringSupportExecutionId: z.string().optional().nullable(),
  });

  async function verifyTransaction(
    txHash: string,
    retries = 3,
    backoffMs = 1000,
    req?: express.Request,
    expected?: ExpectedTxDetails
  ): Promise<boolean | "error"> {
    try {
      return await horizonCircuitBreaker.execute(() =>
        verifyTransactionService(stellarServer, txHash, retries, backoffMs, expected)
      );
    } catch (e: any) {
      const log = req?.log ?? logger;
      if (e.message === "Circuit breaker is OPEN") {
        log.warn({ txHash }, "Horizon circuit breaker is OPEN, skipping verification");
      } else {
        log.error({ txHash, err: e }, "Horizon error verifying transaction");
      }
      return "error";
    }
  }

  /**
   * @openapi
   * /profiles/{username}/transactions:
   *   get:
   *     summary: Get profile support transactions
   *     description: Returns paginated support transactions for a profile, with optional filtering by network, status, and asset code, and sorting by date or amount.
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *           example: john_doe
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *         description: "Number of transactions to return (Min: 1, Max: 100)"
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *         description: "Number of transactions to skip (Min: 0)"
   *       - in: query
   *         name: network
   *         schema:
   *           type: string
   *           enum: [TESTNET, MAINNET]
   *         description: Filter by Stellar network
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [pending, SUCCESS, failed]
   *         description: Filter by transaction status
   *       - in: query
   *         name: assetCode
   *         schema:
   *           type: string
   *           example: XLM
   *         description: Filter by asset code
   *       - in: query
   *         name: sortBy
   *         schema:
   *           type: string
   *           enum: [date, amount]
   *           default: date
   *         description: Sort transactions by date (newest first) or amount (highest first)
   *       - in: query
   *         name: q
   *         schema:
   *           type: string
   *         description: Text search filter — returns only transactions whose message contains this string (case-insensitive, max 100 chars)
   *     responses:
   *       200:
   *         description: Paginated list of transactions
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 transactions:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       txHash:
   *                         type: string
   *                       amount:
   *                         type: string
   *                       assetCode:
   *                         type: string
   *                       assetIssuer:
   *                         type: string
   *                         nullable: true
   *                       status:
   *                         type: string
   *                       message:
   *                         type: string
   *                         nullable: true
   *                       supporterAddress:
   *                         type: string
   *                         nullable: true
   *                       createdAt:
   *                         type: string
   *                         format: date-time
   *                 total:
   *                   type: integer
   *                   description: Total number of matching transactions (ignores pagination)
   *                 limit:
   *                   type: integer
   *                 offset:
   *                   type: integer
   *                 sortBy:
   *                   type: string
   *                   enum: [date, amount]
   *             example:
   *               transactions:
   *                 - txHash: "abc123def456..."
   *                   amount: "10.0000000"
   *                   assetCode: "XLM"
   *                   assetIssuer: null
   *                   status: "SUCCESS"
   *                   message: "Keep up the great work!"
   *                   supporterAddress: "GBZXN7..."
   *                   createdAt: "2025-03-15T14:30:00.000Z"
   *               total: 42
   *               limit: 20
   *               offset: 0
   *               sortBy: "date"
   *       400:
   *         description: Invalid query parameters
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: Profile not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  v1Router.get("/profiles/:username/transactions", async (req, res) => {
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) {
      return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
    }
    const { limit, offset } = pagination.data;
    const { username } = req.params;
    const network = req.query.network as string | undefined;
    const status = req.query.status as string | undefined;
    const assetCode = req.query.assetCode as string | undefined;
    const rawQ = req.query.q as string | undefined;
    const q = rawQ?.trim().slice(0, 100) || undefined;

    // Validate sortBy — only "date" and "amount" are accepted
    const rawSortBy = req.query.sortBy as string | undefined;
    if (rawSortBy !== undefined && rawSortBy !== "date" && rawSortBy !== "amount") {
      return sendError(res, 400, "Invalid sortBy value. Must be 'date' or 'amount'.", "INVALID_SORT");
    }
    const sortBy: "date" | "amount" = rawSortBy === "amount" ? "amount" : "date";

    const profile = await prisma.profile.findUnique({
      where: { username },
    });

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    const where = {
      profileId: profile.id,
      ...(network ? { stellarNetwork: network } : {}),
      ...(status ? { status } : {}),
      ...(assetCode ? { assetCode } : {}),
      ...(q ? { message: { contains: q, mode: "insensitive" as const } } : {}),
    };

    // Sort by date (newest first) or amount (highest first)
    const orderBy =
      sortBy === "amount"
        ? { amount: "desc" as const }
        : { createdAt: "desc" as const };

    const [transactions, total] = await Promise.all([
      prisma.supportTransaction.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy,
      }),
      prisma.supportTransaction.count({ where }),
    ]);

    res.json({ transactions, total, limit, offset, sortBy, ...(q ? { q } : {}) });
  });

  // ── Export transactions for tax reporting ──────────────────────────────

  /**
   * @openapi
   * /profiles/{username}/transactions/export:
   *   get:
   *     summary: Export transactions for tax reporting (CSV)
   *     description: Download transactions as CSV with tax-relevant fields (date, amount, asset, USD value, supporter)
   *     tags:
   *       - Profiles
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: startDate
   *         schema:
   *           type: string
   *           format: date-time
   *         description: ISO 8601 date (e.g., 2025-01-01)
   *       - in: query
   *         name: endDate
   *         schema:
   *           type: string
   *           format: date-time
   *         description: ISO 8601 date (e.g., 2025-12-31)
   *       - in: query
   *         name: taxYear
   *         schema:
   *           type: integer
   *         description: Tax year (e.g., 2025) to auto-filter Jan 1 - Dec 31
   *     responses:
   *       200:
   *         description: CSV file with transactions
   *         content:
   *           text/csv:
   *             schema:
   *               type: string
   *       400:
   *         description: Invalid date range or tax year
   *       404:
   *         description: Profile not found
   *       500:
   *         description: Internal server error
   */
  v1Router.get(["/profiles/:username/transactions/export", "/profiles/:username/transactions/csv"], requireAuth, async (req, res) => {
    const username = req.params.username as string;
    const { startDate, endDate, taxYear } = req.query;

    try {
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify the authenticated user owns this profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      // Parse dates or use tax year
      let dateStart: Date | undefined;
      let dateEnd: Date | undefined;

      if (taxYear) {
        const year = parseInt(taxYear as string, 10);
        if (isNaN(year) || year < 2000 || year > 2100) {
          return sendError(res, 400, "Invalid tax year", "INVALID_TAX_YEAR");
        }
        dateStart = new Date(`${year}-01-01`);
        dateEnd = new Date(`${year}-12-31T23:59:59Z`);
      } else {
        if (startDate) {
          dateStart = new Date(startDate as string);
          if (isNaN(dateStart.getTime())) {
            return sendError(res, 400, "Invalid startDate format", "INVALID_START_DATE");
          }
        }
        if (endDate) {
          dateEnd = new Date(endDate as string);
          if (isNaN(dateEnd.getTime())) {
            return sendError(res, 400, "Invalid endDate format", "INVALID_END_DATE");
          }
        }
      }

      const MAX_EXPORT_ROWS = 10_000;

      // Fetch transactions with optional date filtering
      const transactions = await prisma.supportTransaction.findMany({
        where: {
          profileId: profile.id,
          ...(dateStart || dateEnd
            ? {
                createdAt: {
                  ...(dateStart ? { gte: dateStart } : {}),
                  ...(dateEnd ? { lte: dateEnd } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: "asc" },
        take: MAX_EXPORT_ROWS,
      });

      // Generate CSV
      const headers = [
        "Date",
        "Transaction Hash",
        "Supporter Address",
        "Asset Code",
        "Asset Issuer",
        "Amount",
        "Status",
      ];

      const rows = transactions.map((tx) => [
        new Date(tx.createdAt).toISOString().split("T")[0],
        tx.txHash,
        tx.supporterAddress ?? "",
        tx.assetCode,
        tx.assetIssuer ?? "native",
        tx.amount.toString(),
        tx.status,
      ]);

      // Create CSV content
      const csvContent = [
        headers.map((h) => `"${h}"`).join(","),
        ...rows.map((row) =>
          row.map((cell) => `"${(cell ?? "").toString().replace(/"/g, '""')}"`)
            .join(","),
        ),
      ].join("\n");

      // Set response headers
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="transactions-${username}-${new Date().toISOString().split("T")[0]}.csv"`,
      );
      res.setHeader("Content-Length", Buffer.byteLength(csvContent));

      req.log.info(
        { username, transactionCount: transactions.length },
        "transaction export generated",
      );
      res.send(csvContent);
    } catch (e: unknown) {
      req.log.error({ err: e, username }, "error exporting transactions");
      return sendError(res, 500, "Internal server error");
    }
  });

  // Issue #229 — 409 DUPLICATE_TX handled below in the full support-transactions handler

  // Issue #220 — Webhook CRUD endpoints
  const webhookCreateSchema = z.object({
    url: z.string().url().startsWith("https://"),
  });

  // Helper: resolve profile and verify owner
  async function resolveProfileOwner(
    username: string,
    auth: AuthContext | undefined,
    res: Response,
  ) {
    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) {
      sendError(res, 404, "Profile not found");
      return null;
    }
    if (!isProfileOwner(auth, profile)) {
      sendError(res, 403, "Forbidden");
      return null;
    }
    return profile;
  }

  v1Router.post("/profiles/:username/webhooks", requireAuth, async (req, res) => {
    try {
      const parsed = webhookCreateSchema.safeParse(req.body);
      if (!parsed.success) return sendError(res, 400, "Invalid URL — must be a valid HTTPS URL");

      const profile = await resolveProfileOwner(req.params.username as string, req.auth, res);
      if (!profile) return;

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const existingCount = await tx.webhook.count({
            where: { profileId: profile.id },
          });
          if (existingCount >= 10) {
            throw new Error("MAX_WEBHOOKS_EXCEEDED");
          }

          const secret = randomBytes(32).toString("hex");
          const secretHashValue = createHash("sha256").update(secret).digest("hex");
          const webhook = await tx.webhook.create({
            data: { url: parsed.data.url, secretHash: secretHashValue, signingKey: secret, profileId: profile.id },
          });
          return { webhook, secret };
        },
        { isolationLevel: "Serializable" },
      );

      return res.status(201).json({ id: result.webhook.id, url: result.webhook.url, secret: result.secret });
    } catch (err) {
      if (err instanceof Error && err.message === "MAX_WEBHOOKS_EXCEEDED") {
        return sendError(res, 422, "Maximum 10 webhooks per profile");
      }
      throw err;
    }
  });

  v1Router.get("/profiles/:username/webhooks", requireAuth, async (req, res) => {
    const profile = await resolveProfileOwner(req.params.username as string, req.auth, res);
    if (!profile) return;

    const webhooks = await prisma.webhook.findMany({
      where: { profileId: profile.id },
      select: { id: true, url: true, active: true, createdAt: true },
    });

    return res.json(webhooks);
  });

  v1Router.delete("/profiles/:username/webhooks/:id", requireAuth, async (req, res) => {
    const profile = await resolveProfileOwner(req.params.username as string, req.auth, res);
    if (!profile) return;

    const webhook = await prisma.webhook.findFirst({
      where: { id: req.params.id as string, profileId: profile.id },
    });
    if (!webhook) return sendError(res, 404, "Webhook not found");

    await prisma.webhook.delete({ where: { id: webhook.id } });
    return res.status(204).send();
  });

  v1Router.get("/profiles/:username/webhooks/:id/deliveries", requireAuth, async (req, res) => {
    const profile = await resolveProfileOwner(req.params.username as string, req.auth, res);
    if (!profile) return;

    const webhook = await prisma.webhook.findFirst({
      where: { id: req.params.id as string, profileId: profile.id },
    });
    if (!webhook) return sendError(res, 404, "Webhook not found");

    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) {
      return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
    }
    const { limit, offset } = pagination.data;

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where: { webhookId: webhook.id },
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
      }),
      prisma.webhookDelivery.count({ where: { webhookId: webhook.id } }),
    ]);

    return res.json({ deliveries, total, limit, offset });
  });

  v1Router.get("/profiles/:username/leaderboard", async (req, res) => {
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) {
      return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
    }
    const { limit, offset } = pagination.data;
    const { username } = req.params;
    const sort =
      req.query.sort === "transaction_count"
        ? "transaction_count"
        : ("total_amount" as LeaderboardSort);

    const profile = await prisma.profile.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    const cached = await getCachedLeaderboard(profile.id, limit, offset, sort);
    if (cached) {
      return res.json(cached);
    }

    const orderClause =
      sort === "transaction_count"
        ? 'ORDER BY transaction_count DESC, total_amount DESC'
        : 'ORDER BY total_amount DESC, transaction_count DESC';

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT "supporterAddress", "assetCode", SUM(amount) as total_amount, COUNT(*) as transaction_count
       FROM "SupportTransaction"
       WHERE "profileId" = $1 AND "status" != 'failed' AND "supporterAddress" IS NOT NULL
       GROUP BY "supporterAddress", "assetCode"
       ${orderClause}
       LIMIT $2 OFFSET $3`,
      profile.id,
      limit,
      offset
    );

    const totalResult: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as total FROM (
         SELECT 1
         FROM "SupportTransaction"
         WHERE "profileId" = $1 AND "status" != 'failed' AND "supporterAddress" IS NOT NULL
         GROUP BY "supporterAddress", "assetCode"
       ) sub`,
      profile.id
    );

    const total = Number(totalResult[0]?.total ?? 0);

    const leaderboard = rows.map((entry: any, index: number) => ({
      rank: offset + index + 1,
      supporterAddress: entry.supporterAddress as string,
      assetCode: entry.assetCode,
      totalAmount: (entry.total_amount ?? "0").toString(),
      transactionCount: Number(entry.transaction_count ?? 0),
    }));

    const payload = {
      leaderboard,
      total,
      limit,
      offset,
      sort,
    };

    await setCachedLeaderboard(profile.id, limit, offset, sort, payload);
    return res.json(payload);
  });

  v1Router.get("/indexer/status", async (_req, res) => {
    const contractId =
      process.env.SOROBAN_CONTRACT_ID ??
      process.env.CONTRACT_ID ??
      process.env.NEXT_PUBLIC_CONTRACT_ID ??
      "";
    const network = process.env.INDEXER_NETWORK ?? "TESTNET";

    if (!contractId) {
      return res.json({
        configured: false,
        network,
        contractId: null,
        cursor: null,
        lastLedger: null,
      });
    }

    const cursor = await prisma.indexerCursor.findUnique({
      where: {
        network_contractId: {
          network,
          contractId,
        },
      },
      select: {
        lastPagingToken: true,
        lastLedger: true,
      },
    });

    return res.json({
      configured: true,
      network,
      contractId,
      cursor: cursor?.lastPagingToken ?? null,
      lastLedger: cursor?.lastLedger ?? null,
    });
  });

  /**
   * @openapi
   * /support-transactions:
   *   post:
   *     summary: Record a support transaction
   *     description: |
   *       Record a Stellar support transaction after it has been submitted to the network.
   *       The API verifies the transaction hash against Horizon before recording.
   *       Triggers milestone checks, email notifications, and webhook deliveries.
   *       **Rate limits:** 20 requests per 15 minutes (write limiter).
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               txHash:
   *                 type: string
   *                 example: "abc123def456789..."
   *               amount:
   *                 type: string
   *                 example: "10.0000000"
   *               assetCode:
   *                 type: string
   *                 example: XLM
   *               assetIssuer:
   *                 type: string
   *                 nullable: true
   *                 example: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJ2E37CEGOEZWDSP
   *               status:
   *                 type: string
   *                 default: pending
   *                 example: SUCCESS
   *               message:
   *                 type: string
   *                 maxLength: 280
   *                 description: Sanitized support message
   *               memo:
   *                 type: string
   *                 description: Optional Stellar text memo, max 28 UTF-8 bytes
   *               stellarNetwork:
   *                 type: string
   *                 default: TESTNET
   *                 example: TESTNET
   *               supporterAddress:
   *                 type: string
   *                 example: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
   *               recipientAddress:
   *                 type: string
   *                 example: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJ2E37CEGOEZWDSP
   *               profileId:
   *                 type: string
   *                 example: clx1abc123
   *               supporterId:
   *                 type: string
   *                 nullable: true
   *             required:
   *               - txHash
   *               - amount
   *               - assetCode
   *               - recipientAddress
   *               - profileId
   *     responses:
   *       201:
   *         description: Support transaction recorded
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: Created support transaction record
   *       400:
   *         description: Invalid request body
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error:
   *                 formErrors: []
   *                 fieldErrors:
   *                   txHash: ["Required"]
   *       401:
   *         description: Missing or invalid JWT
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       409:
   *         description: Duplicate transaction hash
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Transaction already recorded"
   *               code: "DUPLICATE_TX"
   *               existingTxHash: "abc123def456789..."
   *       422:
   *         description: Transaction not found or rejected by Horizon
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Transaction hash not found or not successful on Horizon."
   *       429:
   *         description: Rate limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       503:
   *         description: Horizon is unavailable (circuit breaker open)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error: "Service unavailable: unable to verify transaction with Horizon."
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  v1Router.post(
    "/support-transactions",
    requireAuth,
    writeLimiter,
    async (req, res) => {
      const parsed = supportPayloadSchema.safeParse(req.body);

      if (!parsed.success) {
        const flat = parsed.error.flatten();
        req.log.warn({ issues: flat }, "validation failed");
        return res.status(400).json({ error: flat });
      }

      const expectedDetails: ExpectedTxDetails = {
        amount: parsed.data.amount,
        recipientAddress: parsed.data.recipientAddress,
        assetCode: parsed.data.assetCode,
        assetIssuer: parsed.data.assetIssuer,
      };

      // Verify the profile exists and that recipientAddress matches its wallet
      // before touching Horizon (#794). Without this check an attacker can
      // supply a real tx hash paying their own wallet while pointing profileId
      // at a victim — Horizon validation passes but the wrong profile is
      // credited. Fetching walletAddress here closes that fraud vector.
      const profileExists = await prisma.profile.findUnique({
        where: { id: parsed.data.profileId },
        select: { id: true, walletAddress: true },
      });
      if (!profileExists) {
        return sendError(res, 404, "Profile not found");
      }
      if (profileExists.walletAddress !== parsed.data.recipientAddress) {
        return sendError(res, 400, "recipientAddress does not match profile wallet", "ADDRESS_MISMATCH");
      }

      const skipHorizonValidation = process.env.SKIP_HORIZON_VALIDATION === "true";
      if (skipHorizonValidation) {
        req.log.warn(
          { txHash: parsed.data.txHash },
          "SKIP_HORIZON_VALIDATION is enabled — transaction verification bypassed",
        );
      }

      const verification = skipHorizonValidation
        ? true
        : await verifyTransaction(parsed.data.txHash, 3, 1000, req, expectedDetails);

      if (verification === false) {
        return res
          .status(422)
          .json({
            error:
              "Transaction not found, not successful, or payment details (amount/recipient/asset) do not match.",
          });
      }

      if (verification === "error") {
        return res
          .status(503)
          .json({
            error:
              "Service unavailable: unable to verify transaction with Horizon.",
          });
      }

      if (parsed.data.recurringSupportExecutionId) {
        const execution = await prisma.recurringSupportExecution.findUnique({
          where: { id: parsed.data.recurringSupportExecutionId },
          include: { recurringSupport: { include: { profile: true } } },
        });
        if (!execution) {
          return sendError(res, 404, "Recurring support execution not found");
        }
        if (execution.status !== "pending") {
          return sendError(res, 400, "Recurring support execution is not pending");
        }
        if (
          new Decimal(execution.recurringSupport.amount).toString() !== new Decimal(parsed.data.amount).toString() ||
          execution.recurringSupport.assetCode !== parsed.data.assetCode ||
          (execution.recurringSupport.assetIssuer ?? null) !== (parsed.data.assetIssuer ?? null) ||
          execution.recurringSupport.profile.walletAddress !== parsed.data.recipientAddress
        ) {
          return sendError(res, 400, "Transaction details do not match recurring support subscription");
        }
      }

      let supportRecord;
      try {
        supportRecord = await prisma.$transaction(async (tx: any) => {
          const record = await tx.supportTransaction.create({
            data: parsed.data,
          });

          if (parsed.data.recurringSupportExecutionId) {
            await tx.recurringSupportExecution.update({
              where: { id: parsed.data.recurringSupportExecutionId },
              data: { status: "success" },
            });
          }

          if (parsed.data.status === "SUCCESS") {
            const milestones = await tx.milestone.findMany({
              where: {
                profileId: parsed.data.profileId,
                assetCode: parsed.data.assetCode,
                assetIssuer: parsed.data.assetIssuer ?? null,
                status: "active",
              },
            });

            for (const milestone of milestones) {
              const updated = await tx.milestone.update({
                where: { id: milestone.id },
                data: {
                  currentAmount: { increment: new Decimal(parsed.data.amount) },
                },
              });

              if (Number(updated.currentAmount) >= Number(updated.targetAmount)) {
                await tx.milestone.update({
                  where: { id: milestone.id },
                  data: { status: "reached" },
                });
              }
            }
          }

          return record;
        });
        void invalidateProfileLeaderboardCache(supportRecord.profileId);
      } catch (error: any) {
        if (error?.code === "P2002") {
          // Inspect meta.target to determine which unique constraint was
          // actually violated. SupportTransaction has two independent unique
          // constraints — txHash and recurringSupportExecutionId — and
          // always looking up by txHash when the real conflict is on
          // recurringSupportExecutionId would return nothing, causing the 409
          // to report a txHash that was never stored.
          const target: string[] = error?.meta?.target ?? [];
          let existingTxHash: string | null = null;

          if (target.includes("recurringSupportExecutionId") && parsed.data.recurringSupportExecutionId) {
            const existing = await prisma.supportTransaction.findUnique({
              where: { recurringSupportExecutionId: parsed.data.recurringSupportExecutionId },
              select: { txHash: true },
            });
            existingTxHash = existing?.txHash ?? null;
          } else {
            // Default: conflict on txHash (or unknown target — fall back safely).
            const existing = await prisma.supportTransaction.findUnique({
              where: { txHash: parsed.data.txHash },
              select: { txHash: true },
            });
            existingTxHash = existing?.txHash ?? parsed.data.txHash;
          }

          return res.status(409).json({
            error: "Transaction already recorded",
            code: "DUPLICATE_TX",
            existingTxHash,
          });
        }
        // Handle other database errors gracefully instead of crashing the process
        req.log.error({ err: error, txHash: parsed.data.txHash }, "Database error recording support transaction");
        return sendError(res, 500, "Internal server error");
      }

      // Notify creator (async, best-effort) — respects NotificationPreferences
      (async () => {
        try {
          const recipientProfile = await prisma.profile.findUnique({
            where: { id: supportRecord.profileId },
            include: { owner: true, notificationPreferences: true },
          });

          const notifyOnSupport =
            recipientProfile?.notificationPreferences?.notifyOnSupport ?? true;

          // Only send email if profile has verified email (#417)
          if (
            recipientProfile?.email &&
            recipientProfile.emailVerified &&
            notifyOnSupport
          ) {
            sendSupportReceivedEmail({
              to: recipientProfile.email,
              fromAddress: supportRecord.supporterAddress ?? "Anonymous",
              amount: supportRecord.amount.toString(),
              assetCode: supportRecord.assetCode,
              message: supportRecord.message,
              txHash: supportRecord.txHash,
            }).catch((err) => {
              logger.error(
                { err, profileId: supportRecord.profileId },
                "Failed to send contribution received email",
              );
            });
          }
        } catch (err) {
          logger.error(
            { err, txHash: supportRecord.txHash },
            "Error in background email notification task",
          );
        }
      })();

      // Deliver webhooks (async, fire-and-forget)
      (async () => {
        try {
          const webhooks = await prisma.webhook.findMany({
            where: { profileId: supportRecord.profileId, active: true },
            include: { profile: { select: { username: true } } },
          });

          for (const webhook of webhooks) {
            const payload = {
              event: "support.received",
              id: supportRecord.id,
              txHash: supportRecord.txHash,
              amount: supportRecord.amount.toString(),
              assetCode: supportRecord.assetCode,
              assetIssuer: supportRecord.assetIssuer ?? null,
              status: supportRecord.status,
              message: supportRecord.message ?? null,
              memo: supportRecord.memo ?? null,
              supporterAddress: supportRecord.supporterAddress ?? null,
              recipientAddress: supportRecord.recipientAddress,
              profileId: supportRecord.profileId,
              profileUsername: webhook.profile.username,
              createdAt: supportRecord.createdAt.toISOString(),
            };

            // Persist for background delivery with exponential backoff (#webhook-persistence)
            const delivery = await prisma.webhookDelivery.create({
              data: {
                webhookId: webhook.id,
                eventType: "support.received",
                payload,
                status: "pending",
              },
            });

            // When Redis is available, enqueue in BullMQ for immediate processing
            if (getIsRedisAvailable()) {
              enqueueWebhookDelivery(delivery.id).catch((err) => {
                logger.warn({ deliveryId: delivery.id, err }, "Failed to enqueue webhook delivery");
              });
            }
          }

          // The DB-poll fallback is only for when BullMQ isn't available —
          // when it is, running this unconditionally would let every
          // support-transaction request independently claim and deliver up
          // to 50 pending rows outside the worker's rate limiter, defeating
          // the point of enqueueing above (#975).
          if (!getIsRedisAvailable()) {
            await processPendingWebhookDeliveries();
          }
        } catch (err) {
          logger.error(
            { err, txHash: supportRecord.txHash },
            "Error fetching webhooks for delivery",
          );
        }
      })();

      // Auto-award badges (fire-and-forget, never blocks the response) (#545)
      checkAndAwardBadges(supportRecord.profileId).catch((err) => {
        logger.error(
          { err, txHash: supportRecord.txHash },
          "Error in checkAndAwardBadges",
        );
      });

      req.log.info(
        { txHash: supportRecord.txHash },
        "support transaction recorded",
      );
      res.status(201).json(supportRecord);
    },
  );

  // ── Profile RSS feed (#478) ───────────────────────────────────────────

  v1Router.get("/profiles/:username/feed.xml", feedLimiter, async (req, res) => {
    const username = req.params.username as string;

    const profile = await prisma.profile.findUnique({
      where: { username },
      include: { milestones: { where: { status: "reached" }, orderBy: { updatedAt: "desc" }, take: 10 } },
    }) as (Awaited<ReturnType<typeof prisma.profile.findUnique>> & { milestones: any[] }) | null;

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    const transactions = await prisma.supportTransaction.findMany({
      where: { profileId: profile.id, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const baseUrl = process.env.FRONTEND_URL ?? "https://novasupport.xyz";
    const profileUrl = `${baseUrl}/profile/${username}`;
    const feedUrl = `${req.protocol}://${req.get("host")}/v1/profiles/${username}/feed.xml`;
    const now = new Date().toUTCString();

    const escapeXml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

    const txItems = transactions.map((tx) => {
      const truncated = tx.supporterAddress
        ? `${tx.supporterAddress.slice(0, 4)}…${tx.supporterAddress.slice(-4)}`
        : "Anonymous";
      const title = `${truncated} supported with ${tx.amount} ${tx.assetCode}`;
      const description = tx.message
        ? `${escapeXml(title)} — "${escapeXml(tx.message)}"`
        : escapeXml(title);
      return `
    <item>
      <title>${escapeXml(title)}</title>
      <description>${description}</description>
      <link>${profileUrl}</link>
      <guid isPermaLink="false">tx-${escapeXml(tx.txHash)}</guid>
      <pubDate>${new Date(tx.createdAt).toUTCString()}</pubDate>
      <category>Support</category>
    </item>`;
    });

    const milestoneItems = profile.milestones.map((m) => {
      const title = `Milestone reached: ${m.title}`;
      const description = m.description
        ? `${escapeXml(title)} — ${escapeXml(m.description)}`
        : escapeXml(title);
      return `
    <item>
      <title>${escapeXml(title)}</title>
      <description>${description}</description>
      <link>${profileUrl}</link>
      <guid isPermaLink="false">milestone-${escapeXml(m.id)}</guid>
      <pubDate>${new Date(m.updatedAt).toUTCString()}</pubDate>
      <category>Milestone</category>
    </item>`;
    });

    const allItemsWithTimestamp = [
      ...txItems.map((item, idx) => ({ 
        item, 
        timestamp: transactions[idx].createdAt 
      })),
      ...milestoneItems.map((item, idx) => ({ 
        item, 
        timestamp: profile.milestones[idx].updatedAt 
      }))
    ];

    const allItems = allItemsWithTimestamp
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .map(entry => entry.item)
      .join("\n");

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(profile.displayName)} on NovaSupport</title>
    <link>${profileUrl}</link>
    <description>Recent support activity for ${escapeXml(profile.displayName)} on NovaSupport — Stellar-native creator support.</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />
    <generator>NovaSupport RSS</generator>
    ${allItems}
  </channel>
</rss>`;

    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(feed);
  });

  // ── Analytics ──────────────────────────────────────────────────────────

  /**
   * @openapi
   * /analytics/{username}:
   *   get:
   *     summary: Get profile analytics
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *         description: "Number of recent transactions to return (Min: 1, Max: 100)"
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *         description: "Number of recent transactions to skip (Min: 0)"
   *       - in: query
   *         name: format
   *         schema:
   *           type: string
   *           enum: [json, csv]
   *         description: Use csv to download transaction-level analytics data
   *       - in: query
   *         name: startDate
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Include transactions created on or after this date
   *       - in: query
   *         name: endDate
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Include transactions created on or before this date
   *     responses:
   *       200:
   *         description: Analytics data or CSV export
   *       404:
   *         description: Analytics not found
   */
  v1Router.get("/analytics/:username", async (req, res) => {
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) {
      return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
    }
    const { username } = req.params;
    const format = getQueryString(req.query.format);
    const startDate = getQueryString(req.query.startDate) ?? getQueryString(req.query.from);
    const endDate = getQueryString(req.query.endDate) ?? getQueryString(req.query.to);

    // Attempt to find a profile by username
    const profile = await prisma.profile.findUnique({
      where: { username },
      include: { acceptedAssets: true },
    });

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    try {
      const { getAnalytics } = await import("./analytics.js");
      
      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;
      
      if ((startDate && isNaN(start!.getTime())) || (endDate && isNaN(end!.getTime()))) {
        return sendError(res, 400, "Invalid date format");
      }

      if (start && end && start > end) {
        return sendError(res, 400, "startDate must be before endDate");
      }

      if (format === "csv") {
        const MAX_EXPORT_ROWS = 10_000;
        const transactions = await prisma.supportTransaction.findMany({
          where: {
            profileId: profile.id,
            ...(start || end
              ? { createdAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } }
              : {}),
          },
          orderBy: { createdAt: "desc" },
          take: MAX_EXPORT_ROWS,
        });
        const filenameSafeUsername = username.replace(/[^a-zA-Z0-9_-]/g, "-");

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="analytics-${filenameSafeUsername}-${new Date().toISOString().split("T")[0]}.csv"`,
        );
        return res.send(createAnalyticsCsv(transactions));
      }

      const [analytics, recentTransactions] = await Promise.all([
        getAnalytics(profile.id, start, end, "json"),
        prisma.supportTransaction.findMany({
          where: { profileId: profile.id },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            txHash: true,
            amount: true,
            assetCode: true,
            supporterAddress: true,
            createdAt: true,
            status: true,
            message: true,
          },
        }),
      ]);

      res.json({
        profile: { username: profile.username, displayName: profile.displayName },
        ...analytics,
        recentTransactions,
      });
    } catch (err) {
      req.log.error({ err }, "failed to fetch analytics");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Avatar upload ──────────────────────────────────────────────────────

  /**
   * @openapi
   * /profiles/{username}/avatar:
   *   post:
   *     summary: Update profile avatar
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             properties:
   *               avatar:
   *                 type: string
   *                 format: binary
   *     responses:
   *       200:
   *         description: Avatar updated
   *       404:
   *         description: Profile not found
   *       413:
   *         description: File too large
   *       422:
   *         description: Invalid file
   *       502:
   *         description: Avatar storage upload failed
   *       503:
   *         description: Avatar upload service unavailable
   */
  v1Router.post(
    "/profiles/:username/avatar",
    requireAuth,
    writeLimiter,
    upload.single("avatar"),
    async (req, res) => {
      if (!supabaseClient) {
        return sendError(res, 503, "Avatar upload service unavailable");
      }

      const bucket = process.env.SUPABASE_AVATAR_BUCKET;
      if (!bucket) {
        return sendError(res, 503, "Avatar upload service unavailable");
      }

      const username = req.params.username as string;

      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      if (!req.file) {
        return sendError(res, 400, "No file attached — include an 'avatar' field in the multipart body");
      }

      // Delete old avatar to prevent orphaned files
      const listResult = await supabaseClient.storage.from(bucket).list(`avatars/${username}`);
      if (listResult.data) {
        const oldPaths = listResult.data.map((f) => `avatars/${username}/${f.name}`);
        if (oldPaths.length > 0) {
          await supabaseClient.storage.from(bucket).remove(oldPaths);
        }
      }

      const version = Date.now();
      const path = `avatars/${username}/${version}`;
      const { error: uploadError } = await supabaseClient.storage
        .from(bucket)
        .upload(path, req.file.buffer, { upsert: true });

      if (uploadError) {
        req.log.error({ err: uploadError }, "supabase storage upload failed");
        return sendError(res, 502, "Avatar storage upload failed");
      }

      const {
        data: { publicUrl },
      } = supabaseClient.storage.from(bucket).getPublicUrl(path);

      try {
        const updated = await prisma.profile.update({
          where: { username },
          data: { avatarUrl: publicUrl },
          include: { acceptedAssets: true },
        });
        return res.json(updated);
      } catch (e: unknown) {
        req.log.error({ err: e }, "database error updating avatarUrl");
        return sendError(res, 500, "Internal server error");
      }
    },
  );

  // ── Badge system (#460) ────────────────────────────────────────────────

  /**
   * @openapi
   * /badges:
   *   get:
   *     summary: List all available badges
   *     responses:
   *       200:
   *         description: Array of badges
   *       500:
   *         description: Internal server error
   */
  v1Router.get("/badges", async (req, res) => {
    try {
      const badges = await prisma.badge.findMany({
        orderBy: { createdAt: "asc" },
      });
      return res.json({ badges });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error listing badges");
      return sendError(res, 500, "Internal server error");
    }
  });

  /**
   * @openapi
   * /profiles/{username}/badges:
   *   post:
   *     summary: Assign a badge to a profile (admin only)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               badgeId:
   *                 type: string
   *             required:
   *               - badgeId
   *     responses:
   *       201:
   *         description: Badge assigned
   *       400:
   *         description: Invalid request
   *       403:
   *         description: Admin access required
   *       404:
   *         description: Profile or badge not found
   *       409:
   *         description: Badge already assigned
   *       500:
   *         description: Internal server error
   */
  const assignBadgeSchema = z.object({
    badgeId: z.string().min(1),
  });

  const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS ?? "";

  v1Router.post("/profiles/:username/badges", requireAuth, async (req, res) => {
    // Admin-only: only the configured admin wallet may assign badges
    if (!ADMIN_WALLET) {
      return sendError(res, 503, "Admin endpoint not configured");
    }
    if (!req.auth || req.auth.walletAddress !== ADMIN_WALLET) {
      return sendError(res, 403, "Forbidden: Admin access required");
    }

    const parsed = assignBadgeSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body");
    }

    try {
      const [profile, badge] = await Promise.all([
        prisma.profile.findUnique({ where: { username: req.params.username as string } }),
        prisma.badge.findUnique({ where: { id: parsed.data.badgeId } }),
      ]);

      if (!profile) return sendError(res, 404, "Profile not found");
      if (!badge) return sendError(res, 404, "Badge not found");

      const profileBadge = await prisma.profileBadge.create({
        data: { profileId: profile.id, badgeId: badge.id },
        include: { badge: true },
      });

      req.log.info({ username: profile.username, badge: badge.name }, "badge assigned");
      return res.status(201).json(profileBadge);
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
        return sendError(res, 409, "Badge already assigned to this profile", "BADGE_ALREADY_ASSIGNED");
      }
      req.log.error({ err: e }, "database error assigning badge");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Webhooks Admin ─────────────────────────────────────────────────────

  /**
   * @openapi
   * /admin/webhooks/requeue:
   *   post:
   *     summary: Requeue permanently failed webhook deliveries (admin only)
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Number of webhooks requeued
   *       403:
   *         description: Admin access required
   *       500:
   *         description: Internal server error
   */
  v1Router.post("/admin/webhooks/requeue", requireAuth, async (req, res) => {
    if (!ADMIN_WALLET) {
      return sendError(res, 503, "Admin endpoint not configured");
    }
    if (!req.auth || req.auth.walletAddress !== ADMIN_WALLET) {
      return sendError(res, 403, "Forbidden: Admin access required");
    }

    try {
      const failed = await prisma.webhookDelivery.findMany({
        where: { status: "failed" },
        select: { id: true },
      });

      const result = await prisma.webhookDelivery.updateMany({
        where: { id: { in: failed.map((d) => d.id) } },
        data: {
          status: "pending",
          attemptCount: 0,
          nextRetryAt: new Date(),
        },
      });

      for (const delivery of failed) {
        enqueueWebhookDelivery(delivery.id).catch((err) => {
          req.log.warn({ deliveryId: delivery.id, err }, "Failed to enqueue requeued webhook");
        });
      }

      req.log.info({ count: result.count }, "requeued failed webhooks");
      return res.json({ count: result.count });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error requeuing webhooks");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Profile Badges ─────────────────────────────────────────────────────

  v1Router.get("/profiles/:username/badges", async (req, res) => {
    try {
      const profile = await prisma.profile.findUnique({
        where: { username: req.params.username },
        select: { id: true },
      });

      if (!profile) return sendError(res, 404, "Profile not found");

      const profileBadges = await prisma.profileBadge.findMany({
        where: { profileId: profile.id },
        include: { badge: true },
        orderBy: { awardedAt: "asc" },
      });

      return res.json({ badges: profileBadges.map((pb) => ({ ...pb.badge, awardedAt: pb.awardedAt })) });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error fetching profile badges");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Multer error handler ───────────────────────────────────────────────

  v1Router.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE")
          return sendError(res, 413, "File too large");
        return sendError(res, 422, "Invalid file");
      }
      next(err);
    },
  );


  // ── Milestones ─────────────────────────────────────────────────────────

  const createMilestoneSchema = z.object({
    title: z.string().trim().min(1).max(100),
    description: z.string().max(500).optional().nullable(),
    targetAmount: z
      .string()
      .regex(/^\d+(\.\d{1,7})?$/, "Must be a positive decimal with up to 7 places")
      .refine((v) => parseFloat(v) > 0, "Must be greater than zero"),
    assetCode: z.string().default("XLM"),
    assetIssuer: z.string().optional().nullable(),
  });

  v1Router.post("/profiles/:username/milestones", requireAuth, writeLimiter, async (req, res) => {
    try {
      const username = req.params.username as string;
      const profile = await prisma.profile.findUnique({
        where: { username },
        include: { acceptedAssets: true },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      const parsed = createMilestoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "Invalid request body");
      }

      const { assetCode, assetIssuer } = parsed.data;
      const acceptedCodes = profile.acceptedAssets.map((a: { code: string }) => a.code);
      if (acceptedCodes.length > 0 && !isAcceptedAssetPair(profile.acceptedAssets, assetCode, assetIssuer ?? null)) {
        return sendError(
          res,
          400,
          `Asset '${assetCode}'${assetIssuer ? ` (issuer ${assetIssuer})` : ""} is not accepted by this profile. Accepted: ${acceptedCodes.join(", ")}`,
        );
      }

      const milestone = await prisma.$transaction(
        async (tx) => {
          const activeCount = await tx.milestone.count({
            where: { profileId: profile.id, status: { not: "reached" } },
          });
          if (activeCount >= 20) {
            throw new Error("MAX_MILESTONES_EXCEEDED");
          }

          const created = await tx.milestone.create({
            data: {
              title: parsed.data.title,
              description: parsed.data.description,
              targetAmount: parsed.data.targetAmount,
              assetCode: parsed.data.assetCode,
              assetIssuer: parsed.data.assetIssuer ?? null,
              profileId: profile.id,
            },
          });
          return created;
        },
        { isolationLevel: "Serializable" },
      );

      res.status(201).json(milestone);
    } catch (err) {
      if (err instanceof Error && err.message === "MAX_MILESTONES_EXCEEDED") {
        return sendError(res, 422, "Maximum 20 active milestones per profile");
      }
      return sendError(res, 500, "Internal server error");
    }
  });

  v1Router.get("/profiles/:username/milestones", async (req, res) => {
    try {
      const profile = await prisma.profile.findUnique({
        where: { username: req.params.username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      const milestones = await prisma.milestone.findMany({
        where: { profileId: profile.id },
        orderBy: { createdAt: "desc" },
      });

      res.json({ milestones });
    } catch {
      return sendError(res, 500, "Internal server error");
    }
  });

  v1Router.patch("/profiles/:username/milestones/:milestoneId", requireAuth, writeLimiter, async (req, res) => {
    try {
      const username = req.params.username as string;
      const milestoneId = req.params.milestoneId as string;
      
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      const milestone = await prisma.milestone.findUnique({
        where: { id: milestoneId },
      });

      if (!milestone || milestone.profileId !== profile.id) {
        return sendError(res, 404, "Milestone not found");
      }

      const parsed = createMilestoneSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "Invalid request body");
      }

      if (milestone.status === "reached" && parsed.data.targetAmount !== undefined) {
        return sendError(res, 400, "Cannot change targetAmount of a reached milestone");
      }

      // If the asset identity is changing, reset progress so amounts aren't
      // silently misrepresented in the new currency.
      const assetChanging =
        (parsed.data.assetCode !== undefined && parsed.data.assetCode !== milestone.assetCode) ||
        (parsed.data.assetIssuer !== undefined && parsed.data.assetIssuer !== milestone.assetIssuer);

      const data: typeof parsed.data & { currentAmount?: number; status?: string } = { ...parsed.data };

      if (assetChanging) {
        data.currentAmount = 0;
        data.status = "active";
      } else if (
        parsed.data.targetAmount !== undefined &&
        Number(milestone.currentAmount) >= Number(parsed.data.targetAmount)
      ) {
        data.status = "reached";
      }

      const updated = await prisma.milestone.update({
        where: { id: milestoneId },
        data,
      });

      res.json(updated);
    } catch {
      return sendError(res, 500, "Internal server error");
    }
  });

  v1Router.delete("/profiles/:username/milestones/:milestoneId", requireAuth, writeLimiter, async (req, res) => {
    try {
      const username = req.params.username as string;
      const milestoneId = req.params.milestoneId as string;
      
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      const milestone = await prisma.milestone.findUnique({
        where: { id: milestoneId },
      });

      if (!milestone || milestone.profileId !== profile.id) {
        return sendError(res, 404, "Milestone not found");
      }

      await prisma.milestone.delete({
        where: { id: milestoneId },
      });

      res.status(204).send();
    } catch {
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Profile Reports (#771) ─────────────────────────────────────────────

  // Rate limiter: 1 report per IP per profile per hour
  const reportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 1,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    keyGenerator: (req) => `${req.ip}-${req.params.username}`,
    message: {
      error: "You have already reported this profile. Please wait an hour before submitting another report.",
      code: "REPORT_RATE_LIMIT_EXCEEDED",
    },
  });

  const reportSchema = z.object({
    reason: z.enum(["spam", "impersonation", "inappropriate", "scam"]),
    details: z.string().max(500).optional(),
  });

  v1Router.post("/profiles/:username/report", reportLimiter, async (req, res) => {
    try {
      const { username } = req.params as { username: string };
      const profile = await prisma.profile.findUnique({
        where: { username },
        select: { id: true, username: true },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "Invalid request body: reason must be one of spam, impersonation, inappropriate, scam");
      }

      const reporterIp = req.ip ?? "unknown";
      // Reports are used transiently for abuse detection; the reporter IP is
      // purged after 90 days to comply with the privacy policy (#870).
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      await (prisma as any).profileReport.create({
        data: {
          profileId: profile.id,
          reason: parsed.data.reason,
          details: parsed.data.details ?? null,
          reporterIp,
          expiresAt,
        },
      });

      // Check if this profile has accumulated 3+ reports and alert admin
      const reportCount = await (prisma as any).profileReport.count({
        where: { profileId: profile.id },
      });

      const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
      if (reportCount >= 3 && ADMIN_EMAIL) {
        try {
          const { sendEmail } = await import("./mailer.js");
          await sendEmail({
            to: ADMIN_EMAIL,
            subject: `[NovaSupport] Profile @${username} has ${reportCount} report(s)`,
            html: `
              <p>Profile <strong>@${username}</strong> has accumulated <strong>${reportCount}</strong> report(s).</p>
              <p>Latest report reason: <strong>${escapeHtml(parsed.data.reason)}</strong></p>
              ${parsed.data.details ? `<p>Details: ${escapeHtml(parsed.data.details)}</p>` : ""}
              <p>Please review this profile in the admin panel.</p>
            `,
          });
        } catch (emailErr) {
          // Don't fail the request if email fails — just log it
          logger.warn({ err: emailErr, username }, "failed to send admin alert email for profile report");
        }
      }

      return res.status(201).json({ message: "Report submitted successfully." });
    } catch (e: unknown) {
      logger.error({ err: e }, "failed to submit profile report");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Supporters ─────────────────────────────────────────────────────────
  v1Router.get("/supporters/:address", async (req, res) => {
    try {
      const { address } = req.params;

      if (!StrKey.isValidEd25519PublicKey(address)) {
        return sendError(res, 400, "Invalid Stellar address");
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const whereClause = { supporterAddress: address };

      const [transactions, totalCount, assetAggregates, profileAggregates] = await Promise.all([
        prisma.supportTransaction.findMany({
          where: whereClause,
          include: { profile: { select: { username: true, displayName: true } } },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.supportTransaction.count({
          where: whereClause,
        }),
        // Aggregate totals per asset across ALL matching transactions (not just this page)
        prisma.supportTransaction.groupBy({
          by: ["assetCode"],
          where: whereClause,
          _sum: { amount: true },
        }),
        // Count distinct profiles across ALL matching transactions
        prisma.supportTransaction.groupBy({
          by: ["profileId"],
          where: whereClause,
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
        }),
      ]);

      const profilesSupported = profileAggregates.length;

      const totalByAsset = assetAggregates.map((row: any) => ({
        assetCode: row.assetCode as string,
        total: (row._sum.amount ?? 0).toFixed(7),
      }));

      // Fetch display names for all profiles that appear in the aggregate
      const profileIds = profileAggregates.map((r: any) => r.profileId as string);
      const profileRows = await prisma.profile.findMany({
        where: { id: { in: profileIds } },
        select: { id: true, username: true, displayName: true },
      });
      const profileById = new Map(profileRows.map((p: any) => [p.id, p]));

      const supportedProfiles = profileAggregates.map((row: any) => {
        const p = profileById.get(row.profileId as string);
        return {
          username: p?.username ?? "",
          displayName: p?.displayName ?? "",
          totalTransactions: row._count.id as number,
        };
      });

      const history = transactions.map((tx: any) => ({
        id: tx.id,
        profileUsername: tx.profile.username,
        profileDisplayName: tx.profile.displayName,
        amount: tx.amount.toString(),
        assetCode: tx.assetCode,
        assetIssuer: tx.assetIssuer,
        createdAt: tx.createdAt,
        txHash: tx.txHash,
        message: tx.message,
      }));

      return res.json({
        address,
        totalTransactions: totalCount,
        profilesSupported,
        totalByAsset,
        supportedProfiles,
        recentTransactions: history,
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount,
        },
      });
    } catch (err) {
      req.log.error({ err }, "failed to fetch supporter history");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Recurring Support ───────────────────────────────────────────────────

  // Checks that (assetCode, assetIssuer) matches one of the profile's
  // accepted (code, issuer) pairs, not just the asset code in isolation.
  // `issuer` is nullable (e.g. native XLM has no issuer), so null/undefined
  // are treated as equivalent "no issuer".
  function isAcceptedAssetPair(
    acceptedAssets: { code: string; issuer: string | null }[],
    assetCode: string,
    assetIssuer: string | null | undefined,
  ): boolean {
    const normalizedIssuer = assetIssuer ?? null;
    return acceptedAssets.some(
      (a) => a.code === assetCode && (a.issuer ?? null) === normalizedIssuer,
    );
  }

  const recurringSchema = z.object({
    profileId:   z.string().min(1),
    amount:      z.string().regex(/^\d+(\.\d{1,7})?$/, "amount must be a positive decimal with up to 7 decimal places").refine(v => parseFloat(v) > 0, "amount must be greater than zero"),
    assetCode:   z.string().min(1).max(12).optional().default("XLM"),
    assetIssuer: z.string().optional().nullable(),
    frequency:   z.enum(["weekly", "monthly"]),
  });

  v1Router.post("/recurring-support", requireAuth, writeLimiter, async (req, res) => {
    const parsed = recurringSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, parsed.error.issues.map(i => i.message).join("; "));
    }
    const { profileId, amount, assetCode, assetIssuer, frequency } = parsed.data;

    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      include: { acceptedAssets: true },
    });
    if (!profile) return sendError(res, 404, "Profile not found");

    const acceptedCodes = profile.acceptedAssets.map((a: { code: string }) => a.code);
    if (acceptedCodes.length > 0 && !isAcceptedAssetPair(profile.acceptedAssets, assetCode, assetIssuer)) {
      return sendError(res, 400, `Asset '${assetCode}'${assetIssuer ? ` (issuer ${assetIssuer})` : ""} is not accepted by this profile. Accepted: ${acceptedCodes.join(", ")}`);
    }

    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    let nextRunAt: Date;
    if (frequency === "weekly") {
      nextRunAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } else {
      nextRunAt = addMonths(new Date(), 1);
    }

    await prisma.recurringSupport.create({
      data: {
        supporterId: user.id,
        supporterAddress: req.auth!.walletAddress,
        profileId,
        amount,
        assetCode,
        assetIssuer: assetIssuer ?? null,
        frequency,
        nextRunAt,
      },
    });

    return res.status(201).json({ message: "Recurring support created" });
  });

  v1Router.get("/recurring-support", requireAuth, async (req, res) => {
    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const { profileId } = req.query as { profileId?: string };

    if (profileId) {
      // Creator view — return drips for this profile if caller owns it
      const profile = await prisma.profile.findUnique({ where: { id: profileId } });
      if (!profile) return sendError(res, 404, "Profile not found");
      if (!isProfileOwner(req.auth, profile)) return sendError(res, 403, "Forbidden");

      const subscriptions = await prisma.recurringSupport.findMany({
        where: { profileId, status: { not: "cancelled" } },
        include: { supporter: { select: { email: true } } },
        orderBy: { createdAt: "desc" },
      });

      return res.json(subscriptions.map((s) => ({
        id: s.id,
        supporterAddress: s.supporter?.email ?? null,
        amount: s.amount.toString(),
        assetCode: s.assetCode,
        assetIssuer: s.assetIssuer,
        frequency: s.frequency,
        nextRunAt: s.nextRunAt,
        status: s.status,
        cancelledAt: s.cancelledAt,
        createdAt: s.createdAt,
      })));
    }

    // Supporter view — return the authenticated user's own drip subscriptions
    const subscriptions = await prisma.recurringSupport.findMany({
      where: { supporterId: user.id, status: { not: "cancelled" } },
      include: { profile: { select: { username: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
    });

    return res.json(subscriptions.map((s) => ({
      id: s.id,
      profileId: s.profileId,
      profileUsername: s.profile.username,
      profileDisplayName: s.profile.displayName,
      profileAvatarUrl: s.profile.avatarUrl,
      amount: s.amount.toString(),
      assetCode: s.assetCode,
      assetIssuer: s.assetIssuer,
      frequency: s.frequency,
      nextRunAt: s.nextRunAt,
      status: s.status,
      createdAt: s.createdAt,
    })));
  });

  const patchRecurringSupportSchema = z.object({
    status: z.enum(["active", "paused", "cancelled"]).optional(),
    frequency: z.enum(["weekly", "monthly"]).optional(),
    amount: z.string().regex(/^\d+(\.\d{1,7})?$/).refine(v => parseFloat(v) > 0).optional(),
    assetIssuer: z.string().optional().nullable(),
  }).refine((data) => data.status || data.frequency || data.amount || data.assetIssuer !== undefined, {
    message: "At least one field to update is required",
  });

  v1Router.patch("/recurring-support/:id", requireAuth, writeLimiter, async (req, res) => {
    const { id } = req.params;

    const parsed = patchRecurringSupportSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, parsed.error.errors[0]?.message ?? "Invalid request body");
    }

    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const subscription = await prisma.recurringSupport.findUnique({ where: { id: id as string } });
    if (!subscription) return sendError(res, 404, "Recurring support not found");
    if (subscription.supporterId !== user.id) return sendError(res, 403, "Forbidden");

    const { status, frequency, amount, assetIssuer } = parsed.data;

    if (assetIssuer !== undefined) {
      const profile = await prisma.profile.findUnique({
        where: { id: subscription.profileId },
        include: { acceptedAssets: true },
      });
      if (!profile) return sendError(res, 404, "Profile not found");

      if (
        profile.acceptedAssets.length > 0 &&
        !isAcceptedAssetPair(profile.acceptedAssets, subscription.assetCode, assetIssuer)
      ) {
        return sendError(
          res,
          400,
          `Asset '${subscription.assetCode}'${assetIssuer ? ` (issuer ${assetIssuer})` : ""} is not accepted by this profile`,
        );
      }
    }

    // Recalculate nextRunAt when frequency changes
    let nextRunAt: Date | undefined;
    if (frequency) {
      if (frequency === "weekly") {
        nextRunAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      } else {
        nextRunAt = addMonths(new Date(), 1);
      }
    }

    const updated = await prisma.recurringSupport.update({
      where: { id: id as string },
      data: {
        ...(status ? { status } : {}),
        ...(frequency ? { frequency } : {}),
        ...(amount ? { amount } : {}),
        ...(assetIssuer !== undefined ? { assetIssuer } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
      },
    });

    return res.json(updated);
  });

  v1Router.get("/recurring-support/:id", requireAuth, async (req, res) => {
    const { id } = req.params;

    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const subscription = await prisma.recurringSupport.findUnique({
      where: { id: id as string },
      include: { profile: { select: { username: true, displayName: true } } },
    });

    if (!subscription) return sendError(res, 404, "Recurring support not found");
    if (subscription.supporterId !== user.id) return sendError(res, 403, "Forbidden");

    return res.json(subscription);
  });

  v1Router.delete("/recurring-support/:id", requireAuth, async (req, res) => {
    const { id } = req.params;

    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const subscription = await prisma.recurringSupport.findUnique({ where: { id: id as string } });
    if (!subscription) return sendError(res, 404, "Recurring support not found");
    if (subscription.supporterId !== user.id) return sendError(res, 403, "Forbidden");

    await prisma.recurringSupport.update({
      where: { id: id as string },
      data: { status: "cancelled", cancelledAt: new Date() },
    });

    return res.status(200).json({ ok: true });
  });

  /**
   * @openapi
   * /profiles/{username}:
   *   delete:
   *     summary: Delete a profile
   *     description: |
   *       Permanently delete a profile and all related data (transactions, milestones, webhooks, etc.).
   *       Requires authentication and ownership verification.
   *       Cascading deletes are handled by Prisma schema.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *         description: Username of the profile to delete
   *     responses:
   *       204:
   *         description: Profile deleted successfully
   *       401:
   *         description: Unauthorized - authentication required
   *       403:
   *         description: Forbidden - not the profile owner
   *       404:
   *         description: Profile not found
   */
  v1Router.delete("/profiles/:username", requireAuth, writeLimiter, async (req, res) => {
    try {
      const username = req.params.username as string;

      const user = await prisma.user.findFirst({
        where: { email: req.auth!.walletAddress },
      });

      if (!user) {
        return sendError(res, 401, "User not found");
      }

      const profile = await prisma.profile.findUnique({
        where: { username },
        include: {
          _count: {
            select: {
              supportTransactions: true,
              recurringSupports: true,
              milestones: true,
              webhooks: true,
            },
          },
        },
      }) as any;

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      if (!isProfileOwner(req.auth, profile)) {
        return sendError(res, 403, "You can only delete your own profile");
      }

      // Log deletion for audit trail
      req.log.info({
        username,
        profileId: profile.id,
        userId: user.id,
        relatedRecords: {
          transactions: profile._count.supportTransactions,
          recurring: profile._count.recurringSupports,
          milestones: profile._count.milestones,
          webhooks: profile._count.webhooks,
        },
      }, "Profile deletion initiated");

      // Delete profile (cascading deletes handled by Prisma schema)
      await prisma.profile.delete({
        where: { id: profile.id },
      });

      // Invalidate leaderboard cache
      void invalidateProfileLeaderboardCache(profile.id);

      req.log.info({ username, profileId: profile.id }, "Profile deleted successfully");

      return res.status(204).send();
    } catch (error) {
      req.log.error({ err: error }, "Error deleting profile");
      return sendError(res, 500, "Failed to delete profile");
    }
  });

  v1Router.get("/profiles/:username/analytics/timeseries", async (req, res) => {
    const { username } = req.params;
    const period = (req.query.period as string) || "daily";
    const assetCode = req.query.assetCode as string | undefined;

    const VALID_PERIODS = ["daily", "weekly", "monthly"] as const;
    if (!VALID_PERIODS.includes(period as any)) {
      return res.status(400).json({ error: "period must be daily, weekly, or monthly" });
    }

    const to = new Date(req.query.to as string || new Date().toISOString());
    const from = new Date(
      req.query.from as string ||
        new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );

    if (isNaN(to.getTime()) || isNaN(from.getTime())) {
      return res.status(400).json({ error: "Invalid from or to date" });
    }

    const profile = await prisma.profile.findUnique({
      where: { username },
    });

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    let results;
    try {
      if (period === "monthly") {
        results = await prisma.$queryRaw`
          SELECT
            DATE_TRUNC('month', "createdAt") as date,
            SUM(amount) as total,
            COUNT(*) as "txCount"
          FROM "SupportTransaction"
          WHERE "profileId" = ${profile.id}
            AND "status" != 'failed'
            AND "createdAt" >= ${from}
            AND "createdAt" <= ${to}
            ${assetCode ? Prisma.sql`AND "assetCode" = ${assetCode}` : Prisma.empty}
          GROUP BY DATE_TRUNC('month', "createdAt")
          ORDER BY date ASC
        `;
      } else if (period === "weekly") {
        results = await prisma.$queryRaw`
          SELECT
            DATE_TRUNC('week', "createdAt") as date,
            SUM(amount) as total,
            COUNT(*) as "txCount"
          FROM "SupportTransaction"
          WHERE "profileId" = ${profile.id}
            AND "status" != 'failed'
            AND "createdAt" >= ${from}
            AND "createdAt" <= ${to}
            ${assetCode ? Prisma.sql`AND "assetCode" = ${assetCode}` : Prisma.empty}
          GROUP BY DATE_TRUNC('week', "createdAt")
          ORDER BY date ASC
        `;
      } else {
        results = await prisma.$queryRaw`
          SELECT
            DATE_TRUNC('day', "createdAt") as date,
            SUM(amount) as total,
            COUNT(*) as "txCount"
          FROM "SupportTransaction"
          WHERE "profileId" = ${profile.id}
            AND "status" != 'failed'
            AND "createdAt" >= ${from}
            AND "createdAt" <= ${to}
            ${assetCode ? Prisma.sql`AND "assetCode" = ${assetCode}` : Prisma.empty}
          GROUP BY DATE_TRUNC('day', "createdAt")
          ORDER BY date ASC
        `;
      }
    } catch (err) {
      req.log.error({ err }, "Failed to fetch analytics");
      return res.status(500).json({ error: "Internal server error" });
    }

    const { fillGaps } = await import("./analytics.js");
    const formatted = fillGaps(results as any[], period, from, to);

    return res.json(formatted);
  });

  v1Router.get("/profiles/:username/analytics/assets", async (req, res) => {
    const { username } = req.params;

    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) return sendError(res, 404, "Profile not found");

    const rows = await prisma.supportTransaction.groupBy({
      by: ["assetCode"],
      where: { profileId: profile.id, status: "SUCCESS" },
      _sum: { amount: true },
    });

    const breakdown = rows.map((row) => ({
      assetCode: row.assetCode,
      amount: Number(Number(row._sum.amount ?? 0).toFixed(7)),
      percentage: 0,
    }));

    const total = breakdown.reduce((sum, b) => sum + b.amount, 0);
    for (const b of breakdown) {
      b.percentage = total > 0 ? Number(((b.amount / total) * 100).toFixed(2)) : 0;
    }

    return res.json({ breakdown, total: Number(total.toFixed(7)) });
  });

  // ── Stellar Federation endpoint ───────────────────────────────────────
  // Required by the Stellar federation protocol so wallets can resolve
  // <username>*novasupport.xyz into a Stellar account ID.
  // Spec: https://developers.stellar.org/docs/learn/encyclopedia/network-configuration/federation
  /**
   * @openapi
   * /federation:
   *   get:
   *     summary: Stellar federation address resolution
   *     description: |
   *       Resolves a Stellar federation address (e.g. alice*novasupport.xyz) to a
   *       Stellar account ID. Called by wallets and the Stellar network.
   *       Access-Control-Allow-Origin is set to * as required by the Stellar spec.
   *     parameters:
   *       - in: query
   *         name: q
   *         required: true
   *         schema:
   *           type: string
   *           example: alice*novasupport.xyz
   *         description: The federation address to resolve
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *           example: name
   *         description: Lookup type — always "name" for forward lookups
   *     responses:
   *       200:
   *         description: Resolved federation address
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 stellar_address:
   *                   type: string
   *                   example: alice*novasupport.xyz
   *                 account_id:
   *                   type: string
   *                   example: GABC...XYZ
   *       400:
   *         description: Missing or invalid federation address
   *       404:
   *         description: No profile found for that username
   */
  app.get("/federation", federationLimiter, async (req, res) => {
    // Stellar spec requires CORS open to all origins on this endpoint
    res.setHeader("Access-Control-Allow-Origin", "*");

    const q = getQueryString(req.query.q);

    if (!q) {
      return sendError(res, 400, "Missing required parameter: q", "MISSING_PARAMETER");
    }

    // Only handle forward lookups for this domain
    const FEDERATION_DOMAIN = process.env.FEDERATION_DOMAIN ?? "novasupport.xyz";
    const suffix = `*${FEDERATION_DOMAIN}`;

    if (!q.endsWith(suffix)) {
      return sendError(
        res,
        400,
        `Federation address must end with ${suffix}`,
        "INVALID_FEDERATION_ADDRESS",
      );
    }

    const username = q.slice(0, q.length - suffix.length);

    if (!username) {
      return sendError(res, 400, "Invalid federation address: missing username", "INVALID_FEDERATION_ADDRESS");
    }

    try {
      const profile = await prisma.profile.findUnique({
        where: { username },
        select: { walletAddress: true },
      });

      if (!profile) {
        return res.status(404).json({
          code: "not_found",
          message: "No profile found for that username",
        });
      }

      return res.json({
        stellar_address: q,
        account_id: profile.walletAddress,
      });
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error in federation lookup");
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Mount v1 router ───────────────────────────────────────────────────
  // Primary versioned endpoint: /v1/...
  app.use("/v1", v1Router);

  // ── Deprecated unversioned aliases ────────────────────────────────────
  // Keep old routes working but signal deprecation via headers.
  // Clients should migrate to /v1/... endpoints.
  const deprecationDate = "Sat, 01 Jan 2027 00:00:00 GMT";
  const deprecationLink = '</v1>; rel="successor-version"';

  app.use((req, res, next) => {
    res.setHeader("Deprecation", deprecationDate);
    res.setHeader("Link", deprecationLink);
    res.setHeader("Sunset", deprecationDate);
    next();
  }, v1Router);

  // ── Sentry global error handler ───────────────────────────────────────
  // Must be registered after all routes and before any other error handlers
  if (process.env.SENTRY_DSN) {
    app.use(Sentry.expressErrorHandler({
      shouldHandleError(_error: Error) {
        // Capture 4xx client errors as well as 5xx server errors
        return true;
      },
    }));
  }

  // Generic error fallback (logs + returns JSON)
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, path: req.path, method: req.method, requestId: req.requestId }, "Unhandled application error");
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        extra: { path: req.path, method: req.method, requestId: req.requestId },
      });
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", requestId: req.requestId });
    }
  });

  return app;
}

export const app = createApp();
