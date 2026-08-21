import type { ChainClient } from "../blockchain/clients.js";
import { createChainClient } from "../blockchain/clients.js";
import { getTrackingChains } from "../blockchain/chains.js";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import type { MarketplaceWatchedWallet } from "../database/repositories/walletSubscriptions.js";
import type { CollectionSaleWatchedCollection } from "../database/repositories/collectionSaleSubscriptions.js";
import type { ChainConfig } from "../types/index.js";
import type { WatchedWallet } from "../database/repositories/wallets.js";
import { withRetry } from "../utils/retry.js";
import { NotificationService } from "./notifications.js";
import { processBlock, type ProcessableBlock } from "./processBlock.js";
import { MARKETPLACE_LOG_RANGE_BLOCKS, processCollectionSaleRange, processMarketplaceRange } from "./marketplace.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function minBlock(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function selectWatcherResumeBlock(
  lastProcessed: bigint,
  safeHead: bigint,
  maxBacklog: bigint,
  lookback: bigint,
): bigint {
  if (lastProcessed > safeHead) return safeHead;
  if (safeHead - lastProcessed <= maxBacklog) return lastProcessed;
  return safeHead > lookback ? safeHead - lookback : 0n;
}

export function selectWatcherScanBatchSize(configuredBatchSize: bigint, hasMarketplaceTargets: boolean): bigint {
  if (!hasMarketplaceTargets) return configuredBatchSize;
  return minBlock(configuredBatchSize, MARKETPLACE_LOG_RANGE_BLOCKS);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function blockNumbers(fromBlock: bigint, toBlock: bigint): bigint[] {
  const numbers: bigint[] = [];
  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) numbers.push(blockNumber);
  return numbers;
}

export async function processWatchedRange(
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint,
  watched: WatchedWallet[],
  marketplaceWatched: MarketplaceWatchedWallet[],
  collectionSaleWatched: CollectionSaleWatchedCollection[],
  client: ChainClient,
  repositories: Repositories,
  notifications: NotificationService,
  blockFetchConcurrency: number,
  marketplaceLogQueryIntervalMs = 0,
): Promise<void> {
  const timestamps = new Map<bigint, bigint>();

  if (watched.length) {
    const blocks = await mapWithConcurrency(
      blockNumbers(fromBlock, toBlock),
      blockFetchConcurrency,
      (blockNumber) => withRetry(
        () => client.getBlock({ blockNumber, includeTransactions: true }),
        {
          attempts: 4,
          onRetry: (error, attempt) => logger.warn(
            { err: error, attempt, chainId, blockNumber: blockNumber.toString() },
            "retrying block fetch",
          ),
        },
      ),
    );
    for (const block of blocks) {
      timestamps.set(block.number!, block.timestamp);
      await processBlock(
        chainId,
        block as unknown as ProcessableBlock,
        watched,
        repositories,
        notifications,
        client,
      );
    }
  }

  if (marketplaceWatched.length) {
    await processMarketplaceRange(
      chainId,
      fromBlock,
      toBlock,
      marketplaceWatched,
      client,
      repositories,
      notifications,
      async (blockNumber) => {
        const cached = timestamps.get(blockNumber);
        if (cached !== undefined) return cached;
        const block = await withRetry(() => client.getBlock({ blockNumber }), { attempts: 4 });
        return block.timestamp;
      },
      marketplaceLogQueryIntervalMs,
    );
  }

  if (collectionSaleWatched.length) {
    await processCollectionSaleRange(
      chainId,
      fromBlock,
      toBlock,
      collectionSaleWatched,
      client,
      repositories,
      notifications,
      async (blockNumber) => {
        const cached = timestamps.get(blockNumber);
        if (cached !== undefined) return cached;
        const block = await withRetry(() => client.getBlock({ blockNumber }), { attempts: 4 });
        return block.timestamp;
      },
      marketplaceLogQueryIntervalMs,
    );
  }
}

export async function expandCollectionWallets(
  chainId: number,
  sourceWallets: WatchedWallet[],
  expandedLinks: Set<string>,
  repositories: Repositories,
): Promise<WatchedWallet[]> {
  const targets = new Map<string, WatchedWallet>();
  for (const wallet of sourceWallets.filter((candidate) => candidate.chain_id === chainId)) {
    const key = wallet.address.toLowerCase();
    const existing = targets.get(key);
    if (existing) existing.collectionIds.push(...wallet.collectionIds.filter((id) => !existing.collectionIds.includes(id)));
    else targets.set(key, { ...wallet, collectionIds: [...wallet.collectionIds] });
  }

  for (const source of sourceWallets) {
    const addressKey = source.address.toLowerCase();
    for (const collectionId of source.collectionIds) {
      const linkKey = `${chainId}:${addressKey}:${collectionId}`;
      if (expandedLinks.has(linkKey)) continue;
      let target = targets.get(addressKey);
      if (target?.collectionIds.includes(collectionId)) {
        expandedLinks.add(linkKey);
        continue;
      }
      const stored = await repositories.wallets.upsert(chainId, source.address);
      await repositories.wallets.linkCollection(collectionId, stored.id, "cross_chain_dev", 100, []);
      if (!target) {
        target = { ...stored, collectionIds: [] };
        targets.set(addressKey, target);
      }
      target.collectionIds.push(collectionId);
      expandedLinks.add(linkKey);
    }
  }
  return [...targets.values()];
}

export class WalletWatcher {
  private readonly notifications: NotificationService;

  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
  ) {
    this.notifications = new NotificationService(env, repositories.telegramOutbox);
  }

  async run(signal: AbortSignal): Promise<void> {
    const chains = getTrackingChains(this.env);
    logger.info({ chains: chains.map((chain) => chain.chainId) }, "watcher starting");
    await Promise.all(chains.map((chain) => this.runChain(chain, createChainClient(chain), signal)));
  }

  private async runChain(chain: ChainConfig, client: ChainClient, signal: AbortSignal): Promise<void> {
    let failureDelayMs = 1_000;
    const expandedLinks = new Set<string>();
    while (!signal.aborted) {
      try {
        const [head, allWatched, marketplaceWatched, collectionSaleWatched] = await Promise.all([
          withRetry(() => client.getBlockNumber(), { attempts: 3 }),
          this.repositories.wallets.listActiveWatched(),
          this.repositories.walletSubscriptions.listActiveWatched(chain.chainId),
          this.repositories.collectionSaleSubscriptions.listActiveWatched(chain.chainId),
        ]);
        const confirmations = BigInt(this.env.WATCHER_CONFIRMATIONS);
        const safeHead = head > confirmations ? head - confirmations : 0n;
        const watched = await expandCollectionWallets(chain.chainId, allWatched, expandedLinks, this.repositories);
        let lastProcessed = await this.repositories.transactions.getLastProcessedBlock(chain.chainId);

        if (lastProcessed === null) {
          const lookback = watched.length || marketplaceWatched.length || collectionSaleWatched.length
            ? BigInt(this.env.WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS)
            : 0n;
          lastProcessed = safeHead > lookback ? safeHead - lookback : 0n;
          await this.repositories.transactions.setLastProcessedBlock(chain.chainId, lastProcessed);
        }

        const resumeBlock = selectWatcherResumeBlock(
          lastProcessed,
          safeHead,
          BigInt(this.env.WATCHER_MAX_BACKLOG_BLOCKS),
          BigInt(this.env.WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS),
        );
        if (resumeBlock !== lastProcessed) {
          logger.warn(
            {
              chainId: chain.chainId,
              previousBlock: lastProcessed.toString(),
              resumeBlock: resumeBlock.toString(),
              safeHead: safeHead.toString(),
            },
            "fast-forwarding stale watcher cursor to restore real-time monitoring",
          );
          lastProcessed = resumeBlock;
          await this.repositories.transactions.setLastProcessedBlock(chain.chainId, lastProcessed);
        }

        // Persist the cursor after each provider-compatible marketplace range. If a
        // transient RPC failure happens, only this small range is retried instead
        // of replaying a full high-throughput-chain batch indefinitely.
        const batchSize = selectWatcherScanBatchSize(
          BigInt(this.env.WATCHER_SCAN_BATCH_SIZE),
          marketplaceWatched.length > 0 || collectionSaleWatched.length > 0,
        );
        for (let fromBlock = lastProcessed + 1n; fromBlock <= safeHead; fromBlock += batchSize) {
          if (signal.aborted) return;
          const toBlock = minBlock(fromBlock + batchSize - 1n, safeHead);
          await processWatchedRange(
            chain.chainId,
            fromBlock,
            toBlock,
            watched,
            marketplaceWatched,
            collectionSaleWatched,
            client,
            this.repositories,
            this.notifications,
            this.env.WATCHER_BLOCK_FETCH_CONCURRENCY,
            this.env.WATCHER_MARKETPLACE_LOG_QUERY_INTERVAL_MS,
          );

          await this.repositories.transactions.setLastProcessedBlock(chain.chainId, toBlock);
        }
        failureDelayMs = 1_000;
        await delay(this.env.WATCHER_POLL_INTERVAL_MS, signal);
      } catch (error) {
        logger.error({ err: error, chainId: chain.chainId, retryInMs: failureDelayMs }, "watcher chain loop failed");
        await delay(failureDelayMs, signal);
        failureDelayMs = Math.min(failureDelayMs * 2, 60_000);
      }
    }
    logger.info({ chainId: chain.chainId }, "watcher stopped");
  }
}
