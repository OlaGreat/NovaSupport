import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../logger.js";

const BACKOFF_SCHEDULE_SECONDS = [1, 10, 100];
const DELIVERY_TIMEOUT_MS = 10_000;

export type WebhookPayload = Record<string, unknown>;

export type DeliveryResult =
  | { status: "success"; statusCode: number }
  | { status: "failed"; error: string; willRetry: boolean; nextRetryDelayMs?: number };

export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map(canonicalJsonStringify).join(",") + "]";
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const parts = keys.map((key) => {
    const value = (val as Record<string, unknown>)[key];
    return JSON.stringify(key) + ":" + canonicalJsonStringify(value);
  });
  return "{" + parts.join(",") + "}";
}

export function generateSignature(secret: string, payload: WebhookPayload): string {
  const payloadString = canonicalJsonStringify(payload);
  return createHmac("sha256", secret).update(payloadString).digest("hex");
}

export function verifySignature(
  secret: string,
  payload: WebhookPayload,
  signature: string,
): boolean {
  try {
    const expected = generateSignature(secret, payload);
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function deliverWebhook(
  url: string,
  secret: string,
  payload: WebhookPayload,
  signal?: AbortSignal,
): Promise<DeliveryResult> {
  const signature = generateSignature(secret, payload);
  const payloadString = canonicalJsonStringify(payload);

  const timeoutSignal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
  const mergedSignal = signal
    ? combineSignals(signal, timeoutSignal)
    : timeoutSignal;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NovaSupport-Signature": signature,
        "X-NovaSupport-Event": (payload.event as string) ?? "unknown",
      },
      body: payloadString,
      redirect: "manual",
      signal: mergedSignal,
    });

    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      return {
        status: "failed",
        error: "HTTP 3xx redirects are not allowed",
        willRetry: false,
      };
    }

    if (response.ok) {
      return { status: "success", statusCode: response.status };
    }
    return {
      status: "failed",
      error: `HTTP ${response.status}`,
      willRetry:
        response.status >= 500 ||
        response.status === 429 ||
        response.status === 408,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes("timeout") || message.includes("aborted");
    const isNetwork =
      message.includes("ENOTFOUND") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ECONNRESET") ||
      message.includes("network") ||
      message.includes("fetch failed");

    return {
      status: "failed",
      error: message,
      willRetry: isTimeout || isNetwork,
    };
  }
}

export function getNextRetryDelay(attemptCount: number): number | null {
  if (attemptCount >= BACKOFF_SCHEDULE_SECONDS.length) return null;
  const baseMs = BACKOFF_SCHEDULE_SECONDS[attemptCount] * 1000;
  const jitterPercent = (Math.random() * 40 - 20) / 100;
  return Math.round(baseMs * (1 + jitterPercent));
}

export function shouldRetry(attemptCount: number): boolean {
  return attemptCount < BACKOFF_SCHEDULE_SECONDS.length;
}

function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const controller = new AbortController();

  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }

  return controller.signal;
}

export { BACKOFF_SCHEDULE_SECONDS as BACKOFF_SCHEDULE };
