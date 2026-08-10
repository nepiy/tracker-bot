import type { ChainClient } from "../blockchain/clients.js";
import { createChainClient } from "../blockchain/clients.js";
import { getChains } from "../blockchain/chains.js";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import type { ChainConfig } from "../types/index.js";
import { withRetry } from "../utils/retry.js";
import { NotificationService } from "./notifications.js";
import { processBlock, type ProcessableBlock } from "./processBlock.js";
import { processMarketplaceBlock } from "./marketplace.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class WalletWatcher {
  private readonly notifications: NotificationService;

  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
  ) {
    this.notifications = new NotificationService(env);
  }

  async run(signal: AbortSignal): Promise<void> {
    const chains = Object.values(getChains(this.env));
    logger.info({ chains: chains.map((chain) => chain.chainId) }, "watcher starting");
    await Promise.all(chains.map((chain) => this.runChain(chain, createChainClient(chain), signal)));
  }

  private async runChain(chain: ChainConfig, client: ChainClient, signal: AbortSignal): Promise<void> {
    let failureDelayMs = 1_000;
    while (!signal.aborted) {
      try {
        const [head, allWatched, marketplaceWatched] = await Promise.all([
          withRetry(() => client.getBlockNumber(), { attempts: 3 }),
          this.repositories.wallets.listActiveWatched(),
          this.repositories.walletSubscriptions.listActiveWatched(chain.chainId),
        ]);
        const confirmations = BigInt(this.env.WATCHER_CONFIRMATIONS);
        const safeHead = head > confirmations ? head - confirmations : 0n;
        const watched = allWatched.filter((wallet) => wallet.chain_id === chain.chainId);
        let lastProcessed = await this.repositories.transactions.getLastProcessedBlock(chain.chainId);

        if (lastProcessed === null) {
          const lookback = watched.length || marketplaceWatched.length
            ? BigInt(this.env.WATCHER_BOOTSTRAP_LOOKBACK_BLOCKS)
            : 0n;
          lastProcessed = safeHead > lookback ? safeHead - lookback : 0n;
          await this.repositories.transactions.setLastProcessedBlock(chain.chainId, lastProcessed);
        }

        for (let blockNumber = lastProcessed + 1n; blockNumber <= safeHead; blockNumber += 1n) {
          if (signal.aborted) return;
          if (watched.length || marketplaceWatched.length) {
            const block = await withRetry(
              () => client.getBlock({ blockNumber, includeTransactions: true }),
              {
                attempts: 4,
                onRetry: (error, attempt) =>
                  logger.warn({ err: error, attempt, chainId: chain.chainId, blockNumber: blockNumber.toString() }, "retrying block fetch"),
              },
            );
            if (watched.length) {
              await processBlock(
                chain.chainId,
                block as unknown as ProcessableBlock,
                watched,
                this.repositories,
                this.notifications,
              );
            }
            if (marketplaceWatched.length) {
              await processMarketplaceBlock(
                chain.chainId,
                blockNumber,
                block.timestamp,
                marketplaceWatched,
                client,
                this.repositories,
                this.notifications,
              );
            }
          }
          await this.repositories.transactions.setLastProcessedBlock(chain.chainId, blockNumber);
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
