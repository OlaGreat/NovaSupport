import cors from "cors";
import express, { Response } from "express";
import { randomBytes } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import { z } from "zod";
import { StrKey, Horizon } from "@stellar/stellar-sdk";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import * as Sentry from "@sentry/node";
import compression from "compression";
import { prisma } from "./db.js";
import { Prisma } from "@prisma/client";
import { logger } from "./logger.js";
import {
  generateChallenge,
  verifySignature,
  signJWT,
  requireAuth,
  isValidStellarAddress,
  type AuthContext,
} from "./auth.js";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { sendSupportReceivedEmail } from "./services/email.js";
import { sendVerificationEmail } from "./emails/verify-email.js";
import {
  getCachedLeaderboard,
  invalidateProfileLeaderboardCache,
  setCachedLeaderboard,
  type LeaderboardSort,
} from "./services/profile-leaderboard-cache.js";
import { createHmac } from "crypto";
import { sanitizeBody, sanitizeQuery } from "./middleware/sanitize.js";
import { CircuitBreaker } from "./services/circuit-breaker.js";
import {
  validateUsername,
  validateUsernameWithTakenCheck,
} from "./utils/username-validator.js";

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
const horizonCircuitBreaker = new CircuitBreaker(5, 30000); // 5 failures, 30s reset

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
    message: {
      error: "Too many requests, please try again later.",
      code: "RATE_LIMIT_EXCEEDED",
    },
  });

  // Stricter limiter for profile creation: 3 per hour per IP (#276)
  const profileCreationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? "unknown",
    message: { error: "Too many profiles created from this IP address. Please try again in an hour.", code: "RATE_LIMIT_EXCEEDED" },
  });

  const resendLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 1,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Verification email already sent. Please wait 5 minutes before trying again.",
      code: "RATE_LIMIT_EXCEEDED",
    },
    keyGenerator: (req: any) => `${req.ip}-${req.params.username}`,
  });

  return { globalLimiter, writeLimiter, profileCreationLimiter, resendLimiter };
}

// ── API versioning constants ───────────────────────────────────────────
const CURRENT_API_VERSION = "1";
const SUPPORTED_API_VERSIONS = ["1"];

// ── Shared pagination schema (used across multiple routes) ────────────
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

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

export function createApp(customLogger?: Logger) {
  const app = express();
  const { globalLimiter, writeLimiter, profileCreationLimiter, resendLimiter } = createRateLimiters();

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
      servers: [{ url: "http://localhost:4000" }],
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
  app.get("/docs.json", (req, res) => res.json(swaggerSpec));

  // In-memory challenge store (stateless with signed timestamp)
  const challenges = new Map<
    string,
    { challenge: string; timestamp: number }
  >();
  const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  function cleanupExpiredChallenges() {
    const now = Date.now();
    for (const [key, value] of challenges.entries()) {
      if (now - value.timestamp > CHALLENGE_EXPIRY_MS) {
        challenges.delete(key);
      }
    }
  }

  // Cleanup expired challenges every minute
  setInterval(cleanupExpiredChallenges, 60000);

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? "http://localhost:3000"
  )
    .split(",")
    .map((o) => o.trim());

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
    }),
  );
  app.use(express.json());
  app.use(compression({ threshold: 1024 }));
  app.use(sanitizeBody);
  app.use(sanitizeQuery);

  // ── Request ID middleware (#452) ──────────────────────────────────────
  app.use((req, res, next) => {
    const requestId =
      (req.headers["x-request-id"] as string) || randomBytes(16).toString("hex");
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
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        ok: true,
        service: "NovaSupport backend",
        network: "Stellar Testnet",
        database: "connected",
      });
    } catch (e: unknown) {
      req.log.error({ err: e }, "health check database error");
      res.status(503).json({
        ok: false,
        service: "NovaSupport backend",
        database: "unreachable",
      });
    }
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
  v1Router.post("/auth/challenge", (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress || !isValidStellarAddress(walletAddress)) {
      return sendError(res, 400, "Invalid wallet address");
    }

    const challenge = generateChallenge(walletAddress);
    challenges.set(walletAddress, { challenge, timestamp: Date.now() });

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
  v1Router.post("/auth/verify", async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body");
    }

    const { walletAddress, signature } = parsed.data;

    if (!isValidStellarAddress(walletAddress)) {
      return sendError(res, 400, "Invalid wallet address");
    }

    const challengeData = challenges.get(walletAddress);
    if (!challengeData) {
      return sendError(res, 400, "No challenge found for this wallet");
    }

    // Check if challenge expired
    if (Date.now() - challengeData.timestamp > CHALLENGE_EXPIRY_MS) {
      challenges.delete(walletAddress);
      return sendError(res, 400, "Challenge expired");
    }

    // Verify the signature
    const isValid = verifySignature(
      walletAddress,
      challengeData.challenge,
      signature,
    );
    if (!isValid) {
      return sendError(res, 401, "Invalid signature");
    }

    // Clear the used challenge
    challenges.delete(walletAddress);

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

    res.json({ token, walletAddress, userId: user.id });
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
   *         description: Number of profiles to return (Min: 1, Max: 100)
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
        // For sorting by support metrics, we'll fetch all and sort in memory
        // This is a simplified approach; for production, consider aggregation
        const profiles = await prisma.profile.findMany({
          where,
          include: {
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

      // Default sorting by newest
      const [profiles, total] = await Promise.all([
        prisma.profile.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy,
          include: { acceptedAssets: true },
        }),
        prisma.profile.count({ where }),
      ]);

      const filtered = asset
        ? profiles.filter((p: any) =>
            p.acceptedAssets.some(
              (a: any) =>
                a.code === asset &&
                (assetIssuer === "" || a.issuer === assetIssuer),
            ),
          )
        : profiles;

      res.json({
        profiles: filtered,
        total: asset ? filtered.length : total,
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
      // Ensure pg_trgm extension is available
      await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");

      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

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
  v1Router.get("/profiles/:username", async (req, res) => {
    try {
      const profile = await prisma.profile.findUnique({
        where: { username: req.params.username },
        include: {
          acceptedAssets: true,
        },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      res.json(profile);
    } catch (e: unknown) {
      req.log.error({ err: e }, "database error fetching profile");
      return sendError(res, 500, "Internal server error");
    }
  });

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

      const totalByAsset = assetGroups.map((g: any) => ({
        assetCode: g.assetCode,
        assetIssuer: g.assetIssuer,
        total: g._sum.amount ? g._sum.amount.toFixed(7) : "0.0000000",
      }));

      res.json({
        totalTransactions,
        uniqueSupporters: uniqueSupportersList.length,
        totalByAsset,
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
      .regex(/^[a-zA-Z0-9-]+$/)
      .optional()
      .nullable(),
    // ownerId removed - now derived from JWT
    acceptedAssets: z
      .array(
        z.object({
          code: z.string().min(1).max(12),
          issuer: z.string().optional(),
        }),
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
      return sendError(res, 400, "Invalid request body");
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
          ownerId: req.auth.userId || req.auth.walletAddress,
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
    notifyOnSupport: z.boolean().optional(),
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
      .regex(/^[a-zA-Z0-9-]+$/)
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
        return sendError(res, 400, "Invalid request body");
      }

      const username = req.params.username as string;
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
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
          return sendError(res, 409, "Email already in use", "EMAIL_TAKEN");
        }
        req.log.error({ err: e }, "database error updating profile");
        return sendError(res, 500, "Internal server error");
      }
    },
  );

  // ── Email verification (#275) ─────────────────────────────────────────

  v1Router.post("/profiles/:username/verify-email", async (req, res) => {
    const { token } = req.body as { token?: unknown };

    if (!token || typeof token !== "string") {
      return sendError(res, 400, "Verification token is required");
    }

    try {
      const profile = await prisma.profile.findFirst({
        where: { username: req.params.username, emailVerificationToken: token },
      });

      if (!profile) {
        return sendError(res, 404, "Invalid or expired verification token", "TOKEN_INVALID");
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
      const { username } = req.params;
      const userId = (req.auth!.userId || req.auth!.walletAddress) as string;

      try {
        const profile = await prisma.profile.findUnique({
          where: { username },
          include: { owner: true },
        });

        if (!profile) {
          return sendError(res, 404, "Profile not found");
        }

        if (profile.ownerId !== userId) {
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
    const { username } = req.params;

    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) return sendError(res, 404, "Profile not found");

    if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
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
    const { username } = req.params;

    const parsed = notifPrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "Invalid request body");
    }

    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) return sendError(res, 404, "Profile not found");

    if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
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
        z.object({
          code: z.string().regex(/^[A-Z]{1,12}$/),
          issuer: z.string().optional(),
        }),
      )
      .min(1),
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

      if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      try {
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
    amount: z.string().min(1),
    assetCode: z.string().min(1),
    assetIssuer: z.string().optional().nullable(),
    status: z.string().default("pending"),
    message: z.string().max(280).optional().nullable(),
    stellarNetwork: z.string().default("TESTNET"),
    supporterAddress: z.string().optional().nullable(),
    recipientAddress: z.string().min(1),
    profileId: z.string().min(1),
    supporterId: z.string().optional().nullable(),
  });

  const verificationCache = new Map<string, { result: boolean; timestamp: number }>();
  const VERIFICATION_CACHE_TTL = 60 * 60 * 1000;

  async function verifyTransaction(
    txHash: string,
    retries = 3,
    backoffMs = 1000,
    req?: express.Request
  ): Promise<boolean | "error"> {
    const cached = verificationCache.get(txHash);
    if (cached && Date.now() - cached.timestamp < VERIFICATION_CACHE_TTL) {
      return cached.result;
    }

    const verify = async () => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const tx = await stellarServer.transactions().transaction(txHash).call();
          const result = tx.successful === true;
          
          if (result) {
            verificationCache.set(txHash, { result, timestamp: Date.now() });
          }
          
          return result;
        } catch (e: unknown) {
          if (
            e &&
            typeof e === "object" &&
            "response" in e &&
            e.response &&
            typeof e.response === "object" &&
            "status" in e.response &&
            e.response.status === 404
          ) {
            return false;
          }

          if (attempt < retries) {
            const delay = backoffMs * Math.pow(2, attempt - 1);
            const log = req?.log ?? logger;
            log.warn(
              { txHash, attempt, delay, err: e },
              "Horizon verification failed, retrying"
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            throw e;
          }
        }
      }
      return "error" as const;
    };

    try {
      return await horizonCircuitBreaker.execute(verify);
    } catch (e: any) {
      const log = req?.log ?? logger;
      if (e.message === "Circuit breaker is OPEN") {
        log.warn({ txHash }, "Horizon circuit breaker is OPEN, skipping call");
      } else {
        log.error({ txHash, err: e }, "Horizon error verifying transaction after retries");
      }
      return "error";
    }
  }

  /**
   * @openapi
   * /profiles/{username}/transactions:
   *   get:
   *     summary: Get profile support transactions
   *     description: Returns paginated support transactions for a profile, with optional filtering by network, status, and asset code.
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
   *         description: Number of transactions to return (Min: 1, Max: 100)
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *         description: Number of transactions to skip (Min: 0)
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
   *                 limit:
   *                   type: integer
   *                 offset:
   *                   type: integer
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

    const profile = await prisma.profile.findUnique({
      where: { username },
    });

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    const where = {
      recipientAddress: profile.walletAddress,
      ...(network ? { stellarNetwork: network } : {}),
      ...(status ? { status } : {}),
      ...(assetCode ? { assetCode } : {}),
    };

    const [transactions, total] = await Promise.all([
      prisma.supportTransaction.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
      }),
      prisma.supportTransaction.count({ where }),
    ]);

    res.json({ transactions, total, limit, offset });
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
  v1Router.get("/profiles/:username/transactions/export", async (req, res) => {
    const { username } = req.params;
    const { startDate, endDate, taxYear } = req.query;

    try {
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
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

      // Fetch transactions with optional date filtering
      const transactions = await prisma.supportTransaction.findMany({
        where: {
          recipientAddress: profile.walletAddress,
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
    ownerId: string,
    res: Response,
  ) {
    const profile = await prisma.profile.findUnique({ where: { username } });
    if (!profile) {
      sendError(res, 404, "Profile not found");
      return null;
    }
    if (profile.ownerId !== ownerId) {
      sendError(res, 403, "Forbidden");
      return null;
    }
    return profile;
  }

  v1Router.post("/profiles/:username/webhooks", requireAuth, async (req, res) => {
    const parsed = webhookCreateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "Invalid URL — must be a valid HTTPS URL");

    const profile = await resolveProfileOwner(req.params.username as string, (req.auth!.userId || req.auth!.walletAddress) as string, res);
    if (!profile) return;

    const secret = randomBytes(32).toString("hex");
    const webhook = await prisma.webhook.create({
      data: { url: parsed.data.url, secret, profileId: profile.id },
    });

    return res.status(201).json({ id: webhook.id, url: webhook.url, secret });
  });

  v1Router.get("/profiles/:username/webhooks", requireAuth, async (req, res) => {
    const profile = await resolveProfileOwner(req.params.username as string, (req.auth!.userId || req.auth!.walletAddress) as string, res);
    if (!profile) return;

    const webhooks = await prisma.webhook.findMany({
      where: { profileId: profile.id },
      select: { id: true, url: true, active: true, createdAt: true },
    });

    return res.json(webhooks);
  });

  v1Router.delete("/profiles/:username/webhooks/:id", requireAuth, async (req, res) => {
    const profile = await resolveProfileOwner(req.params.username as string, (req.auth!.userId || req.auth!.walletAddress) as string, res);
    if (!profile) return;

    const webhook = await prisma.webhook.findFirst({
      where: { id: req.params.id as string, profileId: profile.id },
    });
    if (!webhook) return sendError(res, 404, "Webhook not found");

    await prisma.webhook.delete({ where: { id: webhook.id } });
    return res.status(204).send();
  });

  v1Router.get("/profiles/:username/webhooks/:id/deliveries", requireAuth, async (req, res) => {
    const profile = await resolveProfileOwner(req.params.username as string, (req.auth!.userId || req.auth!.walletAddress) as string, res);
    if (!profile) return;

    const webhook = await prisma.webhook.findFirst({
      where: { id: req.params.id as string, profileId: profile.id },
    });
    if (!webhook) return sendError(res, 404, "Webhook not found");

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

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

    const cached = getCachedLeaderboard(profile.id, limit, offset, sort);
    if (cached) {
      return res.json(cached);
    }

    const orderBy =
      sort === "transaction_count"
        ? [{ _count: { _all: "desc" as const } }, { _sum: { amount: "desc" as const } }]
        : [{ _sum: { amount: "desc" as const } }, { _count: { _all: "desc" as const } }];

    const [grouped, total] = await Promise.all([
      prisma.supportTransaction.groupBy({
        by: ["supporterAddress", "assetCode"],
        where: {
          profileId: profile.id,
          status: { not: "failed" },
          supporterAddress: { not: null },
        },
        _sum: { amount: true },
        _count: { _all: true },
        orderBy,
        take: limit,
        skip: offset,
      }),
      prisma.supportTransaction.groupBy({
        by: ["supporterAddress", "assetCode"],
        where: {
          profileId: profile.id,
          status: { not: "failed" },
          supporterAddress: { not: null },
        },
        _count: { _all: true },
      }),
    ]);

    const leaderboard = grouped.map((entry: any, index: number) => ({
      rank: offset + index + 1,
      supporterAddress: entry.supporterAddress as string,
      assetCode: entry.assetCode,
      totalAmount: entry._sum.amount?.toString() ?? "0",
      transactionCount: entry._count._all ?? 0,
    }));

    const payload = {
      leaderboard,
      total: total.length,
      limit,
      offset,
      sort,
    };

    setCachedLeaderboard(profile.id, limit, offset, sort, payload);
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
   *                 example: "Keep up the great work!"
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

      const verification = await verifyTransaction(parsed.data.txHash, 3, 1000, req);

      if (verification === false) {
        return res
          .status(422)
          .json({
            error: "Transaction hash not found or not successful on Horizon.",
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

      let supportRecord;
      try {
        supportRecord = await prisma.$transaction(async (tx: any) => {
          const record = await tx.supportTransaction.create({
            data: parsed.data,
          });

          const milestones = await tx.milestone.findMany({
            where: {
              profileId: parsed.data.profileId,
              assetCode: parsed.data.assetCode,
              status: "active",
            },
          });

          for (const milestone of milestones) {
            const updated = await tx.milestone.update({
              where: { id: milestone.id },
              data: {
                currentAmount: { increment: parsed.data.amount },
              },
            });

            if (Number(updated.currentAmount) >= Number(updated.targetAmount)) {
              await tx.milestone.update({
                where: { id: milestone.id },
                data: { status: "reached" },
              });
            }
          }

          return record;
        });
        invalidateProfileLeaderboardCache(supportRecord.profileId);
      } catch (error: any) {
        if (error?.code === "P2002") {
          const existing = await prisma.supportTransaction.findUnique({
            where: { txHash: parsed.data.txHash },
            select: { txHash: true },
          });

          return res.status(409).json({
            error: "Transaction already recorded",
            code: "DUPLICATE_TX",
            existingTxHash: existing?.txHash ?? parsed.data.txHash,
          });
        }
        throw error;
      }

      // Notify creator (async, best-effort) — respects NotificationPreferences
      (async () => {
        try {
          const recipientProfile = await prisma.profile.findUnique({
            where: { id: supportRecord.profileId },
            include: { owner: true, notificationPreferences: true },
          });

          const notifyOnSupport =
            recipientProfile?.notificationPreferences?.notifyOnSupport ??
            recipientProfile?.notifyOnSupport ??
            true;

          if (recipientProfile?.owner?.email && notifyOnSupport) {
            sendSupportReceivedEmail({
              to: recipientProfile.owner.email,
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
            const payload = JSON.stringify({
              event: "support.received",
              txHash: supportRecord.txHash,
              amount: supportRecord.amount.toString(),
              assetCode: supportRecord.assetCode,
              message: supportRecord.message ?? null,
              profileUsername: webhook.profile.username,
              createdAt: supportRecord.createdAt.toISOString(),
            });

            const signature = createHmac("sha256", webhook.secret)
              .update(payload)
              .digest("hex");

            // Persist for background delivery with exponential backoff (#webhook-persistence)
            await prisma.webhookDelivery.create({
              data: {
                webhookId: webhook.id,
                eventType: "support.received",
                payload: JSON.parse(payload),
                status: "pending",
              },
            });
          }
        } catch (err) {
          logger.error(
            { err, txHash: supportRecord.txHash },
            "Error fetching webhooks for delivery",
          );
        }
      })();

      req.log.info(
        { txHash: supportRecord.txHash },
        "support transaction recorded",
      );
      res.status(201).json(supportRecord);
    },
  );

  // ── Profile RSS feed (#478) ───────────────────────────────────────────

  v1Router.get("/profiles/:username/feed.xml", async (req, res) => {
    const { username } = req.params;

    const profile = await prisma.profile.findUnique({
      where: { username },
      include: { milestones: { where: { status: "reached" }, orderBy: { updatedAt: "desc" }, take: 10 } },
    });

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

    const allItems = [...txItems, ...milestoneItems]
      .sort(() => 0)  // already ordered by recency from their respective queries
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
   * /analytics/{campaignId}:
   *   get:
   *     summary: Get profile analytics
   *     parameters:
   *       - in: path
   *         name: campaignId
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
   *         description: Number of recent transactions to return (Min: 1, Max: 100)
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *         description: Number of recent transactions to skip (Min: 0)
   *     responses:
   *       200:
   *         description: Analytics data
   *       404:
   *         description: Analytics not found
   */
  v1Router.get("/analytics/:campaignId", async (req, res) => {
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) {
      return sendError(res, 400, "Invalid pagination parameters", "INVALID_PAGINATION");
    }
    const { limit, offset } = pagination.data;
    const { campaignId } = req.params;
    const { startDate, endDate, format } = req.query;

    // Attempt to find a profile by username (campaignId maps to username)
    const profile = await prisma.profile.findUnique({
      where: { username: campaignId },
      include: { acceptedAssets: true },
    });

    if (!profile) {
      return sendError(res, 404, "Profile not found");
    }

    try {
      const { getAnalytics } = await import("./analytics.js");
      
      const start = startDate ? new Date(startDate as string) : undefined;
      const end = endDate ? new Date(endDate as string) : undefined;
      
      if ((startDate && isNaN(start!.getTime())) || (endDate && isNaN(end!.getTime()))) {
        return sendError(res, 400, "Invalid date format");
      }

      const analytics = await getAnalytics(
        profile.id, 
        start, 
        end, 
        format as "json" | "csv"
      );

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=analytics-${campaignId}.csv`);
        return res.send(analytics);
      }

      res.json({
        profile: { username: profile.username, displayName: profile.displayName },
        ...analytics,
        recentTransactions: analytics.dailyContributions, // For backward compatibility or adjustment
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
      if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      const path = `avatars/${username}`;
      const { error: uploadError } = await supabaseClient.storage
        .from(bucket)
        .upload(path, req.file!.buffer, { upsert: true });

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
    title: z.string().min(1).max(100),
    description: z.string().max(500).optional().nullable(),
    targetAmount: z.string().min(1),
    assetCode: z.string().default("XLM"),
  });

  v1Router.post("/profiles/:username/milestones", requireAuth, writeLimiter, async (req, res) => {
    try {
      const username = req.params.username as string;
      const profile = await prisma.profile.findUnique({
        where: { username },
      });

      if (!profile) {
        return sendError(res, 404, "Profile not found");
      }

      // Verify authenticated wallet owns the profile
      if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
        return sendError(res, 403, "Forbidden: You do not own this profile");
      }

      const parsed = createMilestoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "Invalid request body");
      }

      const milestone = await prisma.milestone.create({
        data: {
          title: parsed.data.title,
          description: parsed.data.description,
          targetAmount: parsed.data.targetAmount,
          assetCode: parsed.data.assetCode,
          profileId: profile.id,
        },
      });

      res.status(201).json(milestone);
    } catch {
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
      if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
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

      const updated = await prisma.milestone.update({
        where: { id: milestoneId },
        data: parsed.data,
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
      if (!req.auth || req.auth.walletAddress !== profile.walletAddress) {
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

  // ── Supporters ─────────────────────────────────────────────────────────

  v1Router.get("/supporters/:address", async (req, res) => {
    try {
      const { address } = req.params;

      if (!StrKey.isValidEd25519PublicKey(address)) {
        return sendError(res, 400, "Invalid Stellar address");
      }

      const transactions = await prisma.supportTransaction.findMany({
        where: { supporterAddress: address },
        include: { profile: { select: { username: true, displayName: true } } },
        orderBy: { createdAt: "desc" },
      });

      const profilesSupported = new Set(transactions.map((tx: any) => tx.profileId)).size;
      const assetMap = new Map<string, number>();
      for (const tx of transactions) {
        const key = tx.assetCode as string;
        assetMap.set(key, (assetMap.get(key) ?? 0) + parseFloat(tx.amount.toString()));
      }
      const totalByAsset = Array.from(assetMap.entries()).map(([assetCode, total]) => ({
        assetCode,
        total: total.toFixed(7),
      }));

      const recentTransactions = transactions.slice(0, 10).map((tx: any) => ({
        profileUsername: tx.profile.username,
        profileDisplayName: tx.profile.displayName,
        amount: tx.amount.toString(),
        assetCode: tx.assetCode,
        createdAt: tx.createdAt,
        txHash: tx.txHash,
      }));

      return res.json({
        address,
        totalTransactions: transactions.length,
        profilesSupported,
        totalByAsset,
        recentTransactions,
      });
    } catch {
      return sendError(res, 500, "Internal server error");
    }
  });

  // ── Recurring Support ───────────────────────────────────────────────────

  v1Router.post("/recurring-support", requireAuth, writeLimiter, async (req, res) => {
    const { profileId, amount, assetCode, frequency } = req.body;

    if (!profileId || !amount || !frequency) {
      return sendError(res, 400, "profileId, amount, and frequency are required");
    }
    if (frequency !== "weekly" && frequency !== "monthly") {
      return sendError(res, 400, "frequency must be 'weekly' or 'monthly'");
    }

    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return sendError(res, 404, "Profile not found");

    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const nextRunAt = new Date();
    if (frequency === "weekly") {
      nextRunAt.setDate(nextRunAt.getDate() + 7);
    } else {
      nextRunAt.setDate(nextRunAt.getDate() + 30);
    }

    await prisma.recurringSupport.create({
      data: {
        supporterId: user.id,
        profileId,
        amount,
        assetCode: assetCode ?? "XLM",
        frequency,
        nextRunAt,
      },
    });

    return res.status(201).json({ message: "Recurring support created" });
  });

  v1Router.get("/recurring-support", requireAuth, async (req, res) => {
    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const subscriptions = await prisma.recurringSupport.findMany({
      where: { supporterId: user.id, status: { not: "cancelled" } },
      include: { profile: { select: { username: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
    });

    return res.json(subscriptions);
  });

  v1Router.patch("/recurring-support/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || (status !== "paused" && status !== "cancelled")) {
      return sendError(res, 400, "status must be 'paused' or 'cancelled'");
    }

    const user = await prisma.user.findFirst({ where: { email: req.auth!.walletAddress } });
    if (!user) return sendError(res, 401, "User not found");

    const subscription = await prisma.recurringSupport.findUnique({ where: { id: id as string } });
    if (!subscription) return sendError(res, 404, "Recurring support not found");
    if (subscription.supporterId !== user.id) return sendError(res, 403, "Forbidden");

    const updated = await prisma.recurringSupport.update({ where: { id: id as string }, data: { status } });

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

    await prisma.recurringSupport.delete({ where: { id: id as string } });

    return res.status(204).send();
  });

  v1Router.get("/profiles/:username/analytics/timeseries", async (req, res) => {
    const { username } = req.params;
    const period = (req.query.period as string) || "daily";
    const assetCode = req.query.assetCode as string | undefined;

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
            ${assetCode ? (Prisma as any).sql`AND "assetCode" = ${assetCode}` : (Prisma as any).empty}
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
            ${assetCode ? (Prisma as any).sql`AND "assetCode" = ${assetCode}` : (Prisma as any).empty}
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
            ${assetCode ? (Prisma as any).sql`AND "assetCode" = ${assetCode}` : (Prisma as any).empty}
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

    const transactions = await prisma.supportTransaction.findMany({
      where: { profileId: profile.id, status: "SUCCESS" },
      select: { assetCode: true, amount: true },
    });

    const assetMap = new Map<string, number>();
    for (const tx of transactions) {
      assetMap.set(tx.assetCode, (assetMap.get(tx.assetCode) ?? 0) + Number(tx.amount));
    }

    const total = Array.from(assetMap.values()).reduce((sum, v) => sum + v, 0);

    const breakdown = Array.from(assetMap.entries()).map(([assetCode, amount]) => ({
      assetCode,
      amount: Number(amount.toFixed(7)),
      percentage: total > 0 ? Number(((amount / total) * 100).toFixed(2)) : 0,
    }));

    return res.json({ breakdown, total: Number(total.toFixed(7)) });
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
      shouldHandleError(error) {
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
