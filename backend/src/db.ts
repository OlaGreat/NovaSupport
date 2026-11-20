import { PrismaClient } from "@prisma/client";

declare global {
  var __prisma__: PrismaClient | undefined;
}

function buildDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const connectionLimit = process.env.DATABASE_POOL_SIZE ?? "10";
    const poolTimeout = process.env.DATABASE_POOL_TIMEOUT ?? "10";

    parsed.searchParams.set("connection_limit", connectionLimit);
    parsed.searchParams.set("pool_timeout", poolTimeout);

    return parsed.toString();
  } catch {
    return url;
  }
}

const databaseUrl = buildDatabaseUrl();

export const prisma =
  global.__prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma__ = prisma;
}
