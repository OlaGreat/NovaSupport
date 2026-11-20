import { describe, it, expect, vi } from "vitest";
import {
  calculateDestinationMinimum,
  classifyStellarError,
  withStellarRetry,
} from "./stellar";

describe("classifyStellarError (#274)", () => {
  it("classifies 404 as not_found and non-retryable", () => {
    const c = classifyStellarError({ status: 404 });
    expect(c.kind).toBe("not_found");
    expect(c.retryable).toBe(false);
    expect(c.status).toBe(404);
  });

  it("classifies 429 as rate_limited and retryable", () => {
    const c = classifyStellarError({ response: { status: 429 } });
    expect(c.kind).toBe("rate_limited");
    expect(c.retryable).toBe(true);
  });

  it("classifies 500 / 502 / 503 as server_error and retryable", () => {
    for (const status of [500, 502, 503, 504]) {
      const c = classifyStellarError({ status });
      expect(c.kind).toBe("server_error");
      expect(c.retryable).toBe(true);
    }
  });

  it("classifies 4xx (other than 429) as client_error and non-retryable", () => {
    const c = classifyStellarError({ status: 400 });
    expect(c.kind).toBe("client_error");
    expect(c.retryable).toBe(false);
  });

  it("classifies network/timeout messages as retryable", () => {
    for (const msg of [
      "Request timeout",
      "fetch failed",
      "ECONNREFUSED",
      "network error",
      "ETIMEDOUT",
    ]) {
      const c = classifyStellarError(new Error(msg));
      expect(c.kind).toBe("network");
      expect(c.retryable).toBe(true);
    }
  });

  it("does not retry cancelled requests", () => {
    for (const error of [
      new Error("operation aborted"),
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
    ]) {
      const c = classifyStellarError(error);
      expect(c.kind).toBe("unknown");
      expect(c.retryable).toBe(false);
    }
  });

  it("classifies unknown errors as non-retryable", () => {
    const c = classifyStellarError(new Error("contract reverted"));
    expect(c.kind).toBe("unknown");
    expect(c.retryable).toBe(false);
  });

  it("user-facing messages never expose raw error strings", () => {
    const c = classifyStellarError(new Error("internal stack 0xDEADBEEF"));
    expect(c.userMessage).not.toContain("0xDEADBEEF");
  });
});

describe("calculateDestinationMinimum", () => {
  it("calculates large amounts without floating-point loss", () => {
    expect(
      calculateDestinationMinimum("9007199254740991.1234567", 0.02),
    ).toBe("8827055269646171.3009876");
  });

  it("rounds the exact decimal result to seven places", () => {
    expect(calculateDestinationMinimum("12.3456789", 0.02)).toBe("12.0987653");
  });
});

describe("withStellarRetry (#274)", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withStellarRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with exponential backoff", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err: Error & { status?: number } = new Error("upstream blew up");
        err.status = 502;
        throw err;
      }
      return "ok";
    });
    const onRetry = vi.fn();
    const result = await withStellarRetry(fn, {
      baseDelayMs: 1,
      maxDelayMs: 5,
      onRetry,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]!.attempt).toBe(1);
    expect(onRetry.mock.calls[1]![0]!.attempt).toBe(2);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn(async () => {
      const err: Error & { status?: number } = new Error("bad request");
      err.status = 400;
      throw err;
    });
    await expect(
      withStellarRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 }),
    ).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      withStellarRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 }),
    ).rejects.toThrow("network down");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
