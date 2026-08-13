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
  processMarketplaceBlock,
  processMarketplaceRange,
  SEAPORT_ADDRESSES,
} from "../src/watcher/marketplace.js";
import type { NotificationService } from "../src/watcher/notifications.js";

const wallet = "0x0000000000000000000000000000000000000001" as Address;
const seller = "0x0000000000000000000000000000000000000002" as Address;
const collection = "0x0000000000000000000000000000000000000003" as Address;
const hash = `0x${"4".repeat(64)}` as Hash;

function addressTopic(address: Address): Hex {
  return pad(address, { size: 32 });
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
    const getLogs = vi.fn(async () => [{ transactionHash: hash }]);
    const client = {
      getLogs,
      getTransactionReceipt: async () => ({
        status: "success",
        logs: [{
          address: collection,
          data: "0x",
          topics: [
            toEventSelector("Transfer(address,address,uint256)"),
            addressTopic(seller),
            addressTopic(wallet),
            pad("0x2a", { size: 32 }),
          ],
          logIndex: 9,
        }],
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
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: [...SEAPORT_ADDRESSES] }));
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
    const client = {
      getLogs: async () => [{ transactionHash: hash }],
      getTransactionReceipt: async () => ({
        status: "success",
        logs: [{
          address: collection,
          data: "0x",
          topics: [
            toEventSelector("Transfer(address,address,uint256)"),
            addressTopic(seller),
            addressTopic(wallet),
            pad("0x2a", { size: 32 }),
          ],
          logIndex: 9,
        }],
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

    expect(getLogs.mock.calls.map(([request]) => [request.fromBlock, request.toBlock])).toEqual([
      [100n, 109n],
      [110n, 119n],
      [120n, 124n],
    ]);
  });
});
