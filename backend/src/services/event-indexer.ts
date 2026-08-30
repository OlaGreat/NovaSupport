// #281 / #423: Contract event indexing service.

//
// Polls Soroban RPC for `SupportEvent`s emitted by the configured contract
// and persists them as `SupportTransaction` rows so the backend stays in
// sync with on-chain state without trusting the client to report
// completions. Cursor state lives in the `indexer_cursors` table; idempotency
// is enforced by the unique constraint on `SupportTransaction.txHash`.
//
// The service is intentionally storage-only inside the worker loop — fetch
// + parse logic is split into pure functions so unit tests can drive it
// without a real RPC endpoint.
//
// Orphan resolution: after each poll, orphaned transactions (profileId =
// "__orphan__") are resolved by matching recipientAddress to a Profile's
// walletAddress. This keeps the indexer eventually consistent with the
// profile registry without blocking the hot path.

import type { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "../logger.js";
import { Metrics } from "../metrics.js";

export interface SupportEventRecord {
  /** Stellar tx hash of the transaction that emitted the event. */
  txHash: string;
  ledger: number;
  pagingToken: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  recipientAddress: string;
  supporterAddress: string | null;
  message: string | null;
  emittedAt: Date;
}

export interface RpcEventPage {
  events: SupportEventRecord[];
  /**
   * The cursor to pass back into the next call. When `null`, the page was
   * the last one available.
   */
  nextPagingToken: string | null;
}

/**
 * Abstract RPC client. Production wires this up to `@stellar/stellar-sdk`'s
 * SorobanRpc.Server.getEvents; tests pass a fake to drive the indexer
 * deterministically.
 */
export interface EventIndexerRpcClient {
  fetchEvents(args: {
    contractId: string;
    cursor: string;
    /** Ledger to start from when no cursor exists yet (backfill). */
    startLedger?: number;
  }): Promise<RpcEventPage>;
}

export interface EventIndexerOptions {
  prisma: PrismaClient;
  rpcClient: EventIndexerRpcClient;
  network: string;
  contractId: string;
  /** Milliseconds between polls. Defaults to 10s. */
  pollIntervalMs?: number;
  /**
   * Ledger to start backfilling from when no cursor exists yet.
   * Defaults to the latest ledger (no historical backfill).
   */
  startLedger?: number;
  /**
   * Maximum pages to consume in a single tick. Prevents the indexer
   * from blocking on a massive backlog. Defaults to 500.
   */
  maxPagesPerTick?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_PAGES_PER_TICK = 500;

/**
 * Long-running event indexer. Construct it, call `.start()` from the worker
 * boot path, and call `.stop()` on shutdown. `pollOnce()` is exposed for
 * testing and for manual reconciliation operators may run from a CLI.
 */
export class EventIndexer {
  private readonly prisma: PrismaClient;
  private readonly rpcClient: EventIndexerRpcClient;
  private readonly network: string;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private readonly startLedger: number | undefined;
  private readonly maxPagesPerTick: number;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private currentTick: Promise<void> | null = null;
  /** Pages consumed since the last time the drain loop paused. Reset once the burst ends. */
  private pagesConsumedInBurst = 0;

  constructor(options: EventIndexerOptions) {
    this.prisma = options.prisma;
    this.rpcClient = options.rpcClient;
    this.network = options.network;
    this.contractId = options.contractId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startLedger = options.startLedger;
    this.maxPagesPerTick = options.maxPagesPerTick ?? DEFAULT_MAX_PAGES_PER_TICK;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.currentTick) {
      await this.currentTick;
    }
  }

  /**
   * Process a single page of events. Returns the number of events ingested
   * so callers (and tests) can assert progress.
   *
   * When called with no stored cursor, the RPC client uses `startLedger`
   * (if configured) to backfill historical events; otherwise it starts
   * from the latest ledger.
   */
  async pollOnce(): Promise<{ ingested: number; nextCursor: string | null }> {
    const cursor = await this.readCursor();
    const page = await this.rpcClient.fetchEvents({
      contractId: this.contractId,
      cursor,
      startLedger: cursor ? undefined : this.startLedger,
    });

    if (page.events.length === 0) {
      // Idle tick — nothing to persist; advance the cursor only if RPC
      // reported one (some RPC providers return a cursor on empty pages so
      // we don't re-scan the same range every tick).
      if (page.nextPagingToken) {
        await this.writeCursor(page.nextPagingToken, cursor);
      }
      return { ingested: 0, nextCursor: page.nextPagingToken };
    }

    const lastEvent = page.events[page.events.length - 1]!;
    const nextCursor = page.nextPagingToken ?? lastEvent.pagingToken;

    // Resolve recipient addresses to profile IDs so we can link
    // on-chain events to the correct NovaSupport profiles.
    const recipientAddresses = [
      ...new Set(page.events.map((e) => e.recipientAddress)),
    ];
    const profiles = await this.prisma.profile.findMany({
      where: { walletAddress: { in: recipientAddresses } },
      select: { id: true, walletAddress: true },
    });
    const profileByAddress = new Map(
      profiles.map((p) => [p.walletAddress, p.id]),
    );

    let ingested = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const event of page.events) {
        const profileId =
          profileByAddress.get(event.recipientAddress) ?? "__orphan__";

        // Use the contract event's tx hash as the natural idempotency key.
        // SupportTransaction.txHash has a unique index so a duplicate insert
        // (e.g. from re-processing the same range during recovery) is a no-op.
        const result = await tx.supportTransaction.upsert({
          where: { txHash: event.txHash },
          update: {
            status: "SUCCESS",
            assetCode: event.assetCode,
            assetIssuer: event.assetIssuer,
            recipientAddress: event.recipientAddress,
            supporterAddress: event.supporterAddress,
            profileId,
            updatedAt: new Date(),
          },
          create: {
            txHash: event.txHash,
            amount: event.amount,
            assetCode: event.assetCode,
            assetIssuer: event.assetIssuer,
            supporterAddress: event.supporterAddress,
            recipientAddress: event.recipientAddress,
            stellarNetwork: this.network,
            message: event.message,
            profileId,
            status: "SUCCESS",
            // Use the on-chain event timestamp so that backfilled transactions
            // are stamped with when they actually occurred, not when the indexer
            // ingested them. Without this, historical backfills corrupt
            // date-range queries, the weekly digest, and tax-year CSV exports.
            createdAt: event.emittedAt,
          },
        });
        // Heuristic: assume createdAt == updatedAt means this was an INSERT.
        // On fast systems (ms-resolution timestamps), a duplicate event can land
        // in the same millisecond as the insert, miscounting as an update.
        // TODO: Use Postgres INSERT ... ON CONFLICT DO UPDATE RETURNING xmax,
        // where xmax = 0 means INSERT and non-zero means UPDATE, for exact detection.
        if (result.createdAt.getTime() === result.updatedAt.getTime()) {
          ingested += 1;
        }
      }

      await this.writeCursorWithinTx(tx, nextCursor, lastEvent.ledger);
    });

    return { ingested, nextCursor };
  }

  /**
   * Resolve orphaned transactions by matching recipientAddress to a Profile's
   * walletAddress. Called after each successful poll to keep the database
   * eventually consistent with the profile registry.
   *
   * Returns the number of transactions resolved.
   */
  async resolveOrphans(): Promise<number> {
    const orphans = await this.prisma.supportTransaction.findMany({
      where: { profileId: "__orphan__" },
      select: { id: true, recipientAddress: true },
      take: 100,
    });

    if (orphans.length === 0) return 0;

    // Collect unique recipient addresses to look up in one query
    const addresses = [...new Set(orphans.map((o) => o.recipientAddress))];
    const profiles = await this.prisma.profile.findMany({
      where: { walletAddress: { in: addresses } },
      select: { id: true, walletAddress: true },
    });

    const addressToProfileId = new Map(
      profiles.map((p) => [p.walletAddress, p.id]),
    );

    let resolved = 0;
    for (const [address, profileId] of addressToProfileId) {
      const count = await this.prisma.supportTransaction.updateMany({
        where: { profileId: "__orphan__", recipientAddress: address },
        data: { profileId },
      });
      resolved += count.count;
    }

    if (resolved > 0) {
      logger.info({ resolved }, "resolved orphaned transactions to profiles");
    }

    // Use the true backlog count (unbounded) for the metric so alerting
    // reflects the real severity, not just the processing page size.
    const trueBacklog = await this.prisma.supportTransaction.count({
      where: { profileId: "__orphan__" },
    });
    Metrics.orphanCount(trueBacklog);
    return resolved;
  }

  private async readCursor(): Promise<string> {
    const row = await this.prisma.indexerCursor.findUnique({
      where: {
        network_contractId: {
          network: this.network,
          contractId: this.contractId,
        },
      },
    });
    return row?.lastPagingToken ?? "";
  }

  private async writeCursor(token: string, _previous: string): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: {
        network_contractId: {
          network: this.network,
          contractId: this.contractId,
        },
      },
      create: {
        network: this.network,
        contractId: this.contractId,
        lastPagingToken: token,
        lastLedger: 0,
      },
      update: { lastPagingToken: token },
    });
  }

  private async writeCursorWithinTx(
    tx: Prisma.TransactionClient,
    token: string,
    ledger: number,
  ): Promise<void> {
    await tx.indexerCursor.upsert({
      where: {
        network_contractId: {
          network: this.network,
          contractId: this.contractId,
        },
      },
      create: {
        network: this.network,
        contractId: this.contractId,
        lastPagingToken: token,
        lastLedger: ledger,
      },
      update: { lastPagingToken: token, lastLedger: ledger },
    });
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.currentTick = this.tick()
        .catch((err) => {
          logger.error({ err }, "event indexer tick failed");
        })
        .finally(() => {
          this.currentTick = null;
        });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // Process exactly one page per tick so the event loop is never blocked by a
    // massive backfill. When more pages are available we reschedule with a 0 ms
    // delay (fast drain) rather than holding all pages in memory simultaneously.
    // `maxPagesPerTick` caps how many pages we drain back-to-back before
    // yielding for a full `pollIntervalMs`, so a huge backlog can't starve the
    // rest of the process.
    let delay = this.pollIntervalMs;
    try {
      const { ingested, nextCursor } = await this.pollOnce();
      this.pagesConsumedInBurst += 1;
      if (ingested > 0) {
        Metrics.eventsIngested(ingested);
        Metrics.eventIndexerLastSuccess(Date.now());
        logger.info(
          { ingested, contractId: this.contractId },
          "indexed events",
        );
      }
      // More pages available — re-enter immediately but yield to the event loop,
      // unless we've hit the per-tick page cap; in that case defer the rest of
      // the backlog to a future tick.
      if (nextCursor !== null && this.pagesConsumedInBurst < this.maxPagesPerTick) {
        delay = 0;
      } else {
        if (nextCursor !== null) {
          logger.info(
            { maxPagesPerTick: this.maxPagesPerTick, contractId: this.contractId },
            "event indexer hit maxPagesPerTick; deferring remaining backlog",
          );
        }
        this.pagesConsumedInBurst = 0;
      }

      await this.resolveOrphans().catch((err) => {
        Metrics.eventIndexerErrors();
        logger.error({ err }, "orphan resolution failed — operator intervention required");
      });
    } catch (err) {
      Metrics.eventIndexerErrors();
      logger.error({ err }, "event indexer tick failed");
    } finally {
      this.scheduleNextTick(delay);
    }
  }
}
