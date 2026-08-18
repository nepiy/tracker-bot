import type { ChainClient } from "../blockchain/clients.js";
import { createChainClient } from "../blockchain/clients.js";
import { getTrackingChains } from "../blockchain/chains.js";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import type { ChainConfig } from "../types/index.js";
import { withRetry } from "../utils/retry.js";
import { NotificationService } from "./notifications.js";
import { BlockscoutMarketplaceReconciler } from "./blockscoutMarketplace.js";
import { processMarketplaceRange } from "./marketplace.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface LiveScanRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export function marketplaceWatchFingerprint(
  wallets: Awaited<ReturnType<Repositories["walletSubscriptions"]["listActiveWatched"]>>,
): string {
  return wallets
    .flatMap((wallet) => wallet.recipients.map((recipient) => (
      `${wallet.id}:${wallet.address.toLowerCase()}:${recipient.subscriptionId}:${recipient.telegramId}`
    )))
    .sort()
    .join("|");
}

export function selectLiveScanRange(
  lastProcessed: bigint | null,
  safeHead: bigint,
  lookbackBlocks: bigint,
): LiveScanRange | null {
  const earliest = safeHead + 1n > lookbackBlocks
    ? safeHead - lookbackBlocks + 1n
    : 0n;
  if (lastProcessed !== null && lastProcessed >= safeHead) return null;
  const next = lastProcessed === null ? earliest : lastProcessed + 1n;
  return { fromBlock: next < earliest ? earliest : next, toBlock: safeHead };
}

/**
 * Scans the newest confirmed blocks independently from the durable historical
 * cursor. Database uniqueness claims make overlap with the backfill watcher
 * safe while ensuring a slow backlog cannot delay current alerts.
 */
export class LivePriorityWatcher {
  private readonly notifications: NotificationService;
  private readonly blockscoutReconciler: BlockscoutMarketplaceReconciler;
  private readonly lastProcessed = new Map<number, bigint>();
  private readonly marketplaceFingerprints = new Map<number, string>();
  private readonly lastReconciledAt = new Map<number, number>();

  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
  ) {
    this.notifications = new NotificationService(env, repositories.telegramOutbox);
    this.blockscoutReconciler = new BlockscoutMarketplaceReconciler(
      repositories,
      this.notifications,
      env.BLOCKSCOUT_API_KEY,
    );
  }

  async pollChainOnce(chain: ChainConfig, client: ChainClient): Promise<LiveScanRange | null> {
    const [head, marketplaceWatched] = await Promise.all([
      withRetry(() => client.getBlockNumber(), { attempts: 3 }),
      this.repositories.walletSubscriptions.listActiveWatched(chain.chainId),
    ]);
    const confirmations = BigInt(this.env.WATCHER_CONFIRMATIONS);
    const safeHead = head > confirmations ? head - confirmations : 0n;
    const fingerprint = marketplaceWatchFingerprint(marketplaceWatched);
    const previousFingerprint = this.marketplaceFingerprints.get(chain.chainId);
    const subscriptionsChanged = previousFingerprint !== undefined && previousFingerprint !== fingerprint;
    const now = Date.now();
    const previousReconciliation = this.lastReconciledAt.get(chain.chainId);
    const reconciliationDue = previousReconciliation !== undefined
      && now - previousReconciliation >= this.env.WATCHER_RECONCILE_INTERVAL_MS;
    const replayRecentWindow = subscriptionsChanged || reconciliationDue;
    const range = selectLiveScanRange(
      replayRecentWindow ? null : this.lastProcessed.get(chain.chainId) ?? null,
      safeHead,
      BigInt(subscriptionsChanged
        ? this.env.WATCHER_SUBSCRIPTION_REPLAY_BLOCKS
        : this.env.WATCHER_LIVE_LOOKBACK_BLOCKS),
    );
    if (!range) {
      this.marketplaceFingerprints.set(chain.chainId, fingerprint);
      if (previousReconciliation === undefined || reconciliationDue) {
        this.lastReconciledAt.set(chain.chainId, now);
      }
      return null;
    }

    if (marketplaceWatched.length) {
      await processMarketplaceRange(
        chain.chainId,
        range.fromBlock,
        range.toBlock,
        marketplaceWatched,
        client,
        this.repositories,
        this.notifications,
        async (blockNumber) => {
          const block = await withRetry(() => client.getBlock({ blockNumber }), { attempts: 4 });
          return block.timestamp;
        },
        this.env.WATCHER_MARKETPLACE_LOG_QUERY_INTERVAL_MS,
      );
    }
    this.lastProcessed.set(chain.chainId, range.toBlock);
    this.marketplaceFingerprints.set(chain.chainId, fingerprint);
    if (previousReconciliation === undefined || reconciliationDue) {
      this.lastReconciledAt.set(chain.chainId, now);
    }
    logger.debug(
      {
        chainId: chain.chainId,
        fromBlock: range.fromBlock.toString(),
        toBlock: range.toBlock.toString(),
        subscriptionsChanged,
        reconciliationDue,
      },
      "live-priority watcher range processed",
    );
    return range;
  }

  async run(signal: AbortSignal): Promise<void> {
    const chains = getTrackingChains(this.env);
    logger.info(
      {
        chains: chains.map((chain) => chain.chainId),
        pollIntervalMs: this.env.WATCHER_LIVE_POLL_INTERVAL_MS,
        lookbackBlocks: this.env.WATCHER_LIVE_LOOKBACK_BLOCKS,
        subscriptionReplayBlocks: this.env.WATCHER_SUBSCRIPTION_REPLAY_BLOCKS,
        reconcileIntervalMs: this.env.WATCHER_RECONCILE_INTERVAL_MS,
        indexedReconciliation: true,
      },
      "live-priority watcher starting",
    );
    await Promise.all(chains.flatMap((chain) => [
      this.runChain(chain, createChainClient(chain), signal),
      this.runExplorerChain(chain, signal),
    ]));
  }

  private async runExplorerChain(chain: ChainConfig, signal: AbortSignal): Promise<void> {
    let failureDelayMs = 5_000;
    while (!signal.aborted) {
      try {
        const watchedWallets = await this.repositories.walletSubscriptions.listActiveWatched(chain.chainId);
        await this.blockscoutReconciler.reconcile(chain, watchedWallets);
        failureDelayMs = 5_000;
        await delay(this.env.WATCHER_RECONCILE_INTERVAL_MS, signal);
      } catch (error) {
        logger.error(
          { err: error, chainId: chain.chainId, retryInMs: failureDelayMs },
          "indexed marketplace reconciliation loop failed",
        );
        await delay(failureDelayMs, signal);
        failureDelayMs = Math.min(failureDelayMs * 2, 30_000);
      }
    }
    logger.info({ chainId: chain.chainId }, "indexed marketplace reconciliation stopped");
  }

  private async runChain(chain: ChainConfig, client: ChainClient, signal: AbortSignal): Promise<void> {
    let failureDelayMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.pollChainOnce(chain, client);
        failureDelayMs = 1_000;
        await delay(this.env.WATCHER_LIVE_POLL_INTERVAL_MS, signal);
      } catch (error) {
        logger.error(
          { err: error, chainId: chain.chainId, retryInMs: failureDelayMs },
          "live-priority watcher chain loop failed",
        );
        await delay(failureDelayMs, signal);
        failureDelayMs = Math.min(failureDelayMs * 2, 30_000);
      }
    }
    logger.info({ chainId: chain.chainId }, "live-priority watcher stopped");
  }
}
