import pino, { Logger } from "pino";

function resolveTransport(): pino.TransportSingleOptions | undefined {
  if (process.env.NODE_ENV !== "production") {
    return { target: "pino-pretty", options: { colorize: true } };
  }
  return undefined;
}

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: resolveTransport(),
});

export function childLogger(requestId: string): Logger {
  return logger.child({ requestId });
}
