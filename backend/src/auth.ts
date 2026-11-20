import "dotenv/config";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { logger } from "./logger.js";
import { prisma } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = "1h";

if (!JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET environment variable is required but not set. Application cannot start.");
}

const JWT_SECRET_VALIDATED: string = JWT_SECRET;

export type AuthContext = {
  walletAddress: string;
  userId?: string;
  jti?: string;
  exp?: number;
};

declare module "express" {
  interface Request {
    auth?: AuthContext;
  }
}

export function generateChallenge(walletAddress: string): string {
  const timestamp = Date.now();
  const randomHex = randomBytes(16).toString("hex");
  return `novasupport:${walletAddress}:${timestamp}:${randomHex}`;
}

export function verifySignature(
  walletAddress: string,
  challenge: string,
  signature: string
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(walletAddress);
    const messageBuffer = Buffer.from(challenge, 'utf8');
    const sigBuffer = Buffer.from(signature, 'base64');
    return keypair.verify(messageBuffer, sigBuffer);
  } catch (error) {
    logger.error({ error }, "Signature verification error");
    return false;
  }
}

export function signJWT(walletAddress: string, userId?: string): string {
  return jwt.sign(
    { walletAddress, userId },
    JWT_SECRET_VALIDATED,
    { expiresIn: JWT_EXPIRY, jwtid: randomBytes(16).toString("hex") }
  );
}

export function verifyJWT(token: string): AuthContext | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET_VALIDATED) as AuthContext;
    return decoded;
  } catch {
    return null;
  }
}

// Accepts token from Authorization: Bearer header (API consumers)
// OR from the httpOnly auth_token cookie set by POST /auth/verify (#759)
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Try Authorization header first (API clients, mobile)
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else if ((req as any).cookies?.auth_token) {
    // 2. Fall back to httpOnly cookie (browser sessions)
    token = (req as any).cookies.auth_token as string;
  }

  if (!token) {
    res.status(401).json({ error: "Unauthorized: Missing or invalid token" });
    return;
  }

  const auth = verifyJWT(token);

  if (!auth) {
    res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    return;
  }

  if (auth.jti) {
    try {
      const revoked = await prisma.revokedToken.findUnique({
        where: { jti: auth.jti },
      });
      if (revoked) {
        res.status(401).json({ error: "Unauthorized: Token has been revoked" });
        return;
      }
    } catch (error) {
      logger.error({ error }, "Failed to check token revocation status");
      res.status(500).json({ error: "Internal server error" });
      return;
    }
  }

  req.auth = auth;
  next();
}

// Optionally attaches auth context; does NOT reject unauthenticated requests
// Accepts token from Authorization: Bearer header OR httpOnly cookie (#759)
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else if ((req as any).cookies?.auth_token) {
    token = (req as any).cookies.auth_token as string;
  }

  if (token) {
    const auth = verifyJWT(token);
    if (auth) {
      if (auth.jti) {
        try {
          const revoked = await prisma.revokedToken.findUnique({
            where: { jti: auth.jti },
          });
          if (revoked) {
            next();
            return;
          }
        } catch (error) {
          logger.error({ error }, "Failed to check token revocation status");
          next();
          return;
        }
      }
      req.auth = auth;
    }
  }

  next();
}

export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}
