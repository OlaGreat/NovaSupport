import cors from "cors";
import express from "express";
import { z } from "zod";
import { prisma } from "./db.js";

// Helper function for consistent error responses
function sendError(res: express.Response, status: number, message: string, code?: string) {
  const body: { error: string; code?: string } = { error: message };
  if (code) body.code = code;
  res.status(status).json(body);
}

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "NovaSupport backend",
      network: "Stellar Testnet"
    });
  });

  // Zod schema for creating a profile
  const CreateProfileSchema = z.object({
    username: z.string().min(3).max(32).regex(/^[a-z0-9-]+$/, "Username must be lowercase alphanumeric with hyphens only"),
    displayName: z.string().min(1).max(64),
    bio: z.string().max(280).optional(),
    walletAddress: z.string().startsWith("G").length(56, "Stellar address must be 56 characters starting with G"),
    acceptedAssets: z.array(z.object({
      code: z.string().min(1).max(12),
      issuer: z.string().optional(),
    })).min(1, "At least one accepted asset is required"),
    ownerId: z.string().min(1),
  });

  // POST /profiles - Create a new creator profile
  app.post("/profiles", async (req, res) => {
    const result = CreateProfileSchema.safeParse(req.body);
    if (!result.success) {
      return sendError(res, 400, "Invalid request body");
    }

    const { username, displayName, bio, walletAddress, acceptedAssets, ownerId } = result.data;

    try {
      const profile = await prisma.$transaction(async (tx) => {
        return tx.profile.create({
          data: { 
            username, 
            displayName, 
            bio: bio ?? "", 
            walletAddress,
            ownerId,
            acceptedAssets: { create: acceptedAssets },
          },
          include: { acceptedAssets: true },
        });
      });
      return res.status(201).json(profile);
    } catch (e: any) {
      if (e.code === "P2002") {
        return sendError(res, 409, "Username already taken", "USERNAME_TAKEN");
      }
      return sendError(res, 500, "Internal server error");
    }
  });

  app.get("/profiles/:username", async (req, res) => {
    const profile = await prisma.profile.findUnique({
      where: { username: req.params.username },
      include: {
        acceptedAssets: true
      }
    });

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    res.json(profile);
  });

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
    supporterId: z.string().optional().nullable()
  });

  app.post("/support-transactions", async (req, res) => {
    const parsed = supportPayloadSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const supportRecord = await prisma.supportTransaction.create({
      data: parsed.data
    });

    res.status(201).json(supportRecord);
  });

  return app;
}

export const app = createApp();
