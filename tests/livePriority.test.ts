import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { ChainClient } from "../src/blockchain/clients.js";
import type { AppEnv } from "../src/config/env.js";
import type { Repositories } from "../src/database/repositories/index.js";
import type { ChainConfig } from "../src/types/index.js";
import { LivePriorityWatcher, selectLiveScanRange } from "../src/watcher/livePriority.js";

const chain: ChainConfig = {
  key: "robinhood",
  name: "Robinhood Chain",
  chainId: 4663,
  openSeaIdentifiers: ["robinhood"],
  rpcUrl: "https://robinhood.example",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  explorerApiUrl: "https://robinhoodchain.blockscout.com",
  explorerType: "blockscout",
  nativeSymbol: "ETH",
};

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  OPENSEA_API_KEY: "test-key",
  WATCHER_CONFIRMATIONS: 1,
  WATCHER_LIVE_LOOKBACK_BLOCKS: 5,
  WATCHER_SUBSCRIPTION_REPLAY_BLOCKS: 8,
  WATCHER_RECONCILE_INTERVAL_MS: 10_000,
  WATCHER_BLOCK_FETCH_CONCURRENCY: 4,
} as AppEnv;

describe("live-priority scan range", () => {
  it("starts inside a bounded newest-block window", () => {
    expect(selectLiveScanRange(null, 104n, 5n)).toEqual({ fromBlock: 100n, toBlock: 104n });
  });

  it("continues from the in-memory live cursor without rescanning completed blocks", () => {
    expect(selectLiveScanRange(104n, 107n, 5n)).toEqual({ fromBlock: 105n, toBlock: 107n });
    expect(selectLiveScanRange(107n, 107n, 5n)).toBeNull();
  });

  it("drops an excessive live gap while the durable watcher keeps backfilling it", () => {
    expect(selectLiveScanRange(50n, 107n, 5n)).toEqual({ fromBlock: 103n, toBlock: 107n });
  });
});

describe("live-priority watcher", () => {
  it("polls the newest confirmed range independently from the durable chain cursor", async () => {
    const heads = [105n, 108n];
    const getBlockNumber = vi.fn(async () => heads.shift()!);
    const getLogs = vi.fn(async () => []);
    const client = { getBlockNumber, getLogs } as unknown as ChainClient;
    const repositories = {
      wallets: { listActiveWatched: vi.fn(async () => []) },
      walletSubscriptions: {
        listActiveWatched: vi.fn(async () => [{
          id: "wallet-id",
          chain_id: 4663,
          address: "0x0000000000000000000000000000000000000001" as Address,
          recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
        }]),
      },
      telegramOutbox: {},
    } as unknown as Repositories;
    const watcher = new LivePriorityWatcher(env, repositories);

    await expect(watcher.pollChainOnce(chain, client)).resolves.toEqual({ fromBlock: 100n, toBlock: 104n });
    await expect(watcher.pollChainOnce(chain, client)).resolves.toEqual({ fromBlock: 105n, toBlock: 107n });

    const requests = getLogs.mock.calls.map(([request]) => request);
    expect(requests.slice(0, 4)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromBlock: 100n, toBlock: 104n }),
    ]));
    expect(requests.slice(4)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromBlock: 105n, toBlock: 107n }),
    ]));
  });

  it("replays the recent window when a wallet subscription is added between scans", async () => {
    const heads = [105n, 108n];
    const getLogs = vi.fn(async () => []);
    const client = {
      getBlockNumber: vi.fn(async () => heads.shift()!),
      getLogs,
    } as unknown as ChainClient;
    const subscriptions = [
      [],
      [{
        id: "wallet-id",
        chain_id: 4663,
        address: "0x0000000000000000000000000000000000000001" as Address,
        recipients: [{ telegramId: 123, subscriptionId: "new-subscription-id" }],
      }],
    ];
    const repositories = {
      wallets: { listActiveWatched: vi.fn(async () => []) },
      walletSubscriptions: {
        listActiveWatched: vi.fn(async () => subscriptions.shift()!),
      },
      telegramOutbox: {},
    } as unknown as Repositories;
    const watcher = new LivePriorityWatcher(env, repositories);

    await expect(watcher.pollChainOnce(chain, client)).resolves.toEqual({ fromBlock: 100n, toBlock: 104n });
    await expect(watcher.pollChainOnce(chain, client)).resolves.toEqual({ fromBlock: 100n, toBlock: 107n });

    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 100n, toBlock: 107n }));
  });

  it("periodically reconciles the recent live window with deduplicated processing", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(12_000);
    const heads = [105n, 108n];
    const getLogs = vi.fn(async () => []);
    const client = {
      getBlockNumber: vi.fn(async () => heads.shift()!),
      getLogs,
    } as unknown as ChainClient;
    const repositories = {
      wallets: { listActiveWatched: vi.fn(async () => []) },
      walletSubscriptions: {
        listActiveWatched: vi.fn(async () => [{
          id: "wallet-id",
          chain_id: 4663,
          address: "0x0000000000000000000000000000000000000001" as Address,
          recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
        }]),
      },
      telegramOutbox: {},
    } as unknown as Repositories;
    const watcher = new LivePriorityWatcher(env, repositories);

    await expect(watcher.pollChainOnce(chain, client)).resolves.toEqual({ fromBlock: 100n, toBlock: 104n });
    await expect(watcher.pollChainOnce(chain, client)).resolves.toEqual({ fromBlock: 103n, toBlock: 107n });

    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 103n, toBlock: 107n }));
    now.mockRestore();
  });
});
