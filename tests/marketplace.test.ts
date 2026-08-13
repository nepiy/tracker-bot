import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  pad,
  parseAbiParameters,
  toEventSelector,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import type { ChainClient } from "../src/blockchain/clients.js";
import type { Repositories } from "../src/database/repositories/index.js";
import type { MarketplaceWatchedWallet } from "../src/database/repositories/walletSubscriptions.js";
import {
  decodeNftTransfers,
  ERC721_TRANSFER_EVENT,
  processMarketplaceBlock,
  processMarketplaceRange,
  SEAPORT_ADDRESSES,
} from "../src/watcher/marketplace.js";
import type { NotificationService } from "../src/watcher/notifications.js";

const wallet = "0x0000000000000000000000000000000000000001" as Address;
const seller = "0x0000000000000000000000000000000000000002" as Address;
const collection = "0x0000000000000000000000000000000000000003" as Address;
const hash = `0x${"4".repeat(64)}` as Hash;
const orderFulfilledTopic = toEventSelector(
  "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])",
);

function addressTopic(address: Address): Hex {
  return pad(address, { size: 32 });
}

function erc721TransferLog(transactionHash: Hash = hash, blockNumber = 100n) {
  return {
    address: collection,
    data: "0x" as Hex,
    topics: [
      toEventSelector("Transfer(address,address,uint256)"),
      addressTopic(seller),
      addressTopic(wallet),
      pad("0x2a", { size: 32 }),
    ],
    logIndex: 9,
    transactionHash,
    blockNumber,
  };
}

function seaportSettlementLog() {
  return {
    address: SEAPORT_ADDRESSES[0],
    data: "0x" as Hex,
    topics: [orderFulfilledTopic],
    logIndex: 8,
  };
}

describe("marketplace NFT activity", () => {
  it("decodes ERC-721 and ERC-1155 batch transfer logs", () => {
    const erc721 = {
      address: collection,
      data: "0x" as Hex,
      topics: [
        toEventSelector("Transfer(address,address,uint256)"),
        addressTopic(seller),
        addressTopic(wallet),
        pad("0x2a", { size: 32 }),
      ],
      logIndex: 7,
    };
    const batch = {
      address: collection,
      data: encodeAbiParameters(parseAbiParameters("uint256[], uint256[]"), [[5n, 6n], [2n, 3n]]),
      topics: [
        toEventSelector("TransferBatch(address,address,address,uint256[],uint256[])"),
        addressTopic(seller),
        addressTopic(seller),
        addressTopic(wallet),
      ],
      logIndex: 8,
    };

    const transfers = decodeNftTransfers([erc721, batch]);
    expect(transfers).toHaveLength(3);
    expect(transfers[0]).toMatchObject({ from: seller, to: wallet, tokenId: 42n, quantity: 1n });
    expect(transfers[2]).toMatchObject({ tokenId: 6n, quantity: 3n, itemIndex: 1 });
  });

  it("stores and notifies a Seaport buy only once", async () => {
    const claimed = new Set<string>();
    const claim = vi.fn(async (activity: { txHash: Hash; logIndex: number; itemIndex: number; type: string }) => {
      const key = `${activity.txHash}:${activity.logIndex}:${activity.itemIndex}:${activity.type}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
    const sendMarketplace = vi.fn(async () => undefined);
    const transferLog = erc721TransferLog();
    const getLogs = vi.fn(async (request: { event?: { name: string }; args?: { to?: Address[] } }) => (
      request.event === ERC721_TRANSFER_EVENT && request.args?.to ? [transferLog] : []
    ));
    const client = {
      getLogs,
      getTransactionReceipt: async () => ({
        status: "success",
        logs: [seaportSettlementLog(), transferLog],
      }),
    } as unknown as ChainClient;
    const repositories = { marketplaceActivity: { claim } } as unknown as Repositories;
    const notifications = { sendMarketplace } as unknown as NotificationService;
    const watched: MarketplaceWatchedWallet[] = [{
      id: "wallet-id",
      chain_id: 1,
      address: wallet,
      recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
    }];

    await processMarketplaceBlock(1, 100n, 1_700_000_000n, watched, client, repositories, notifications);
    await processMarketplaceBlock(1, 100n, 1_700_000_000n, watched, client, repositories, notifications);

    expect(claim).toHaveBeenCalledTimes(2);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({
      event: ERC721_TRANSFER_EVENT,
      args: { to: [wallet] },
    }));
    expect(sendMarketplace).toHaveBeenCalledTimes(1);
    expect(sendMarketplace.mock.calls[0]![1]).toMatchObject({
      type: "nft_buy",
      marketplace: "Seaport",
      nftContract: collection,
      tokenId: 42n,
    });
  });

  it("releases marketplace deduplication when notification enqueueing fails", async () => {
    const release = vi.fn(async () => undefined);
    const transferLog = erc721TransferLog();
    const client = {
      getLogs: async (request: { event?: { name: string }; args?: { to?: Address[] } }) => (
        request.event === ERC721_TRANSFER_EVENT && request.args?.to ? [transferLog] : []
      ),
      getTransactionReceipt: async () => ({
        status: "success",
        logs: [seaportSettlementLog(), transferLog],
      }),
    } as unknown as ChainClient;
    const repositories = {
      marketplaceActivity: { claim: async () => true, release },
    } as unknown as Repositories;
    const watched: MarketplaceWatchedWallet[] = [{
      id: "wallet-id",
      chain_id: 1,
      address: wallet,
      recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
    }];

    await expect(processMarketplaceBlock(
      1,
      100n,
      1_700_000_000n,
      watched,
      client,
      repositories,
      { sendMarketplace: vi.fn(async () => { throw new Error("outbox unavailable"); }) } as unknown as NotificationService,
    )).rejects.toThrow("outbox unavailable");

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toMatchObject({ type: "nft_buy", txHash: hash });
  });

  it("splits marketplace log scans into provider-compatible ten-block ranges", async () => {
    const getLogs = vi.fn(async () => []);
    const client = { getLogs } as unknown as ChainClient;

    await processMarketplaceRange(
      4663,
      100n,
      124n,
      [{
        id: "wallet-id",
        chain_id: 4663,
        address: wallet,
        recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
      }],
      client,
      {} as Repositories,
      {} as NotificationService,
      async () => 1_700_000_000n,
    );

    const ranges = [...new Set(getLogs.mock.calls.map(([request]) => (
      `${request.fromBlock.toString()}:${request.toBlock.toString()}`
    )))];
    expect(ranges).toEqual([
      "100:109",
      "110:119",
      "120:124",
    ]);
    expect(getLogs.mock.calls.map(([request]) => [request.fromBlock, request.toBlock])).toEqual(expect.arrayContaining([
      [100n, 109n],
      [110n, 119n],
      [120n, 124n],
    ]));
  });

  it("fetches independent Seaport receipts concurrently for live-scan throughput", async () => {
    const secondHash = `0x${"5".repeat(64)}` as Hash;
    let activeReceipts = 0;
    let maxActiveReceipts = 0;
    const client = {
      getLogs: async (request: { event?: { name: string }; args?: { to?: Address[] } }) => (
        request.event === ERC721_TRANSFER_EVENT && request.args?.to
          ? [erc721TransferLog(hash), erc721TransferLog(secondHash)]
          : []
      ),
      getTransactionReceipt: async () => {
        activeReceipts += 1;
        maxActiveReceipts = Math.max(maxActiveReceipts, activeReceipts);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReceipts -= 1;
        return { status: "success", logs: [seaportSettlementLog()] };
      },
    } as unknown as ChainClient;

    await processMarketplaceBlock(
      1,
      100n,
      1_700_000_000n,
      [{
        id: "wallet-id",
        chain_id: 1,
        address: wallet,
        recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
      }],
      client,
      {} as Repositories,
      {} as NotificationService,
    );

    expect(maxActiveReceipts).toBe(2);
  });

  it("stores a tracked-wallet mint once without mislabeling a Seaport mint as a buy", async () => {
    const claimed = new Set<string>();
    const claim = vi.fn(async (activity: { txHash: Hash; logIndex: number; itemIndex: number; type: string }) => {
      const key = `${activity.txHash}:${activity.logIndex}:${activity.itemIndex}:${activity.type}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
    const sendMarketplace = vi.fn(async () => undefined);
    const mintLog = {
      address: collection,
      data: "0x" as Hex,
      topics: [
        toEventSelector("Transfer(address,address,uint256)"),
        addressTopic("0x0000000000000000000000000000000000000000"),
        addressTopic(wallet),
        pad("0x2a", { size: 32 }),
      ],
      logIndex: 9,
      transactionHash: hash,
      blockNumber: 100n,
    };
    const getLogs = vi.fn(async (request: { event?: { name: string }; args?: { to?: Address[] } }) => {
      return request.event === ERC721_TRANSFER_EVENT && request.args?.to ? [mintLog] : [];
    });
    const client = {
      getLogs,
      getTransactionReceipt: async () => ({ status: "success", logs: [mintLog] }),
    } as unknown as ChainClient;
    const repositories = { marketplaceActivity: { claim } } as unknown as Repositories;
    const notifications = { sendMarketplace } as unknown as NotificationService;
    const watched: MarketplaceWatchedWallet[] = [{
      id: "wallet-id",
      chain_id: 1,
      address: wallet,
      recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
    }];

    await processMarketplaceBlock(1, 100n, 1_700_000_000n, watched, client, repositories, notifications);
    await processMarketplaceBlock(1, 100n, 1_700_000_000n, watched, client, repositories, notifications);

    expect(claim).toHaveBeenCalledTimes(2);
    expect(sendMarketplace).toHaveBeenCalledTimes(1);
    expect(sendMarketplace.mock.calls[0]![1]).toMatchObject({
      type: "nft_mint",
      marketplace: "On-chain mint",
      nftContract: collection,
      tokenId: 42n,
      counterparty: null,
    });
  });
});
