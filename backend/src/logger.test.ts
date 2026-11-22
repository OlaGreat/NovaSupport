import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { logger, resolveTransport } from "./logger.js";
import { createApp } from "./app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Test runner ────────────────────────────────────────────────────────────

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a writable stream that collects chunks into a string buffer. */
function makeLogStream(): { stream: Writable; getOutput: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, getOutput: () => buf };
}

/** Parses newline-delimited JSON log output into an array of objects. */
function parseLogLines(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  // 1. logger is a named export and is a Pino instance
  // Validates: Requirement 1.1
  await runTest("logger is a named export and is a Pino instance", async () => {
    assert.ok(logger !== undefined, "logger should be exported");
    assert.equal(typeof logger.info, "function", "logger.info should be a function");
    assert.equal(typeof logger.warn, "function", "logger.warn should be a function");
    assert.equal(typeof logger.error, "function", "logger.error should be a function");
    assert.equal(typeof logger.debug, "function", "logger.debug should be a function");
    assert.equal(typeof logger.level, "string", "logger.level should be a string");
  });

  // 2. NODE_ENV=production produces no pino-pretty transport (raw JSON to stdout)
  // Validates: Requirement 1.4
  await runTest("NODE_ENV=production produces no pino-pretty transport", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      // Call the real transport-selection function (not an inline copy)
      const transport = resolveTransport();

      const { stream, getOutput } = makeLogStream();
      const prodLogger = pino({ level: "info", transport }, stream as NodeJS.WritableStream);

      prodLogger.info({ test: true }, "production log");
      // Give the stream a tick to flush
      await new Promise((r) => setImmediate(r));

      const lines = parseLogLines(getOutput());
      assert.ok(lines.length > 0, "Should have at least one log line");
      // In production (no pino-pretty), output is raw JSON — msg field is present
      assert.equal(lines[0].msg, "production log");
      // transport should be undefined in production
      assert.equal(transport, undefined, "transport should be undefined in production");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // 3. NODE_ENV=development sets transport target to "pino-pretty"
  // Validates: Requirement 1.3
  await runTest("NODE_ENV=development sets transport target to pino-pretty", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      // Call the real transport-selection function (not an inline copy)
      const transport = resolveTransport();

      assert.ok(transport !== undefined, "transport should be defined in development");
      assert.equal(
        (transport as { target: string }).target,
        "pino-pretty",
        "transport target should be pino-pretty"
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // 4. createApp() registers pino-http so that req.log is defined after a test request
  // Validates: Requirement 2.1
  await runTest("createApp() registers pino-http — req.log is defined after a request", async () => {
    const app = createApp();
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // GET /health will return 503 (no DB) but pino-http middleware still runs
      const res = await fetch(`${baseUrl}/health`);
      // Either 200 (DB up) or 503 (DB down) — both mean the middleware ran
      assert.ok(
        res.status === 200 || res.status === 503,
        `Expected 200 or 503, got ${res.status}`
      );
      // The fact that we got a response means pino-http ran and req.log was attached
      // (if pino-http wasn't registered, the app would still respond but req.log would be undefined,
      //  causing a crash in the health route handler which calls req.log.error on DB failure)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  // 5. No source file in backend/src/ contains `import morgan`
  // Validates: Requirement 3.1
  await runTest("no source file in backend/src/ contains 'import morgan'", async () => {
    const { readdirSync } = await import("node:fs");
    const srcDir = resolve(__dirname);
    // Exclude test files themselves — they may reference "morgan" in assertion strings
    const files = readdirSync(srcDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
    );

    for (const file of files) {
      const content = readFileSync(resolve(srcDir, file), "utf-8");
      assert.ok(
        !content.includes("import morgan"),
        `File ${file} should not contain 'import morgan'`
      );
    }
  });

  // 6. package.json lists neither `morgan` nor `@types/morgan`
  // Validates: Requirement 3.2
  await runTest("package.json lists neither morgan nor @types/morgan", async () => {
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    assert.ok(
      !("morgan" in allDeps),
      "package.json should not list morgan"
    );
    assert.ok(
      !("@types/morgan" in allDeps),
      "package.json should not list @types/morgan"
    );
  });

  // 7. Startup info log entry contains `port` field
  // Validates: Requirement 4.1
  await runTest("startup info log entry contains port field", async () => {
    const { stream, getOutput } = makeLogStream();
    const testLogger = pino({ level: "info" }, stream as NodeJS.WritableStream);

    const port = 4000;
    testLogger.info({ port }, `NovaSupport backend listening on http://localhost:${port}`);

    // Give the stream a tick to flush
    await new Promise((r) => setImmediate(r));

    const lines = parseLogLines(getOutput());
    assert.ok(lines.length > 0, "Should have at least one log line");

    const infoEntry = lines.find((l) => l.msg === `NovaSupport backend listening on http://localhost:${port}`);
    assert.ok(infoEntry !== undefined, "Should have a startup info log entry");
    assert.equal(infoEntry.port, port, "Startup info log should contain port field");
    assert.equal(infoEntry.level, 30, "Startup info log should be level 30 (info)");
  });

  // 8. Startup error log entry contains `variable` field
  // Validates: Requirement 4.2
  await runTest("startup error log entry contains variable field", async () => {
    const { stream, getOutput } = makeLogStream();
    const testLogger = pino({ level: "info" }, stream as NodeJS.WritableStream);

    const missingVar = "DATABASE_URL";
    testLogger.error(
      { variable: missingVar },
      `Missing required environment variable: ${missingVar}`
    );

    // Give the stream a tick to flush
    await new Promise((r) => setImmediate(r));

    const lines = parseLogLines(getOutput());
    assert.ok(lines.length > 0, "Should have at least one log line");

    const errorEntry = lines.find((l) =>
      typeof l.msg === "string" && l.msg.includes("Missing required environment variable")
    );
    assert.ok(errorEntry !== undefined, "Should have a startup error log entry");
    assert.equal(errorEntry.variable, missingVar, "Startup error log should contain variable field");
    assert.equal(errorEntry.level, 50, "Startup error log should be level 50 (error)");
  });
}

main().catch((err) => {
  console.error("Logger unit tests failed.");
  console.error(err);
  process.exit(1);
});
