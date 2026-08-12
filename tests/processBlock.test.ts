import { describe, expect, it, vi } from "vitest";
import type { Address, Hash } from "viem";
import { isOutgoingTransaction, processBlock, type ProcessableBlock } from "../src/watcher/processBlock.js";
import type { Repositories } from "../src/database/repositories/index.js";
import type { NotificationService } from "../src/watcher/notifications.js";

const watched = "0x0000000000000000000000000000000000000001" as Address;
const other = "0x0000000000000000000000000000000000000002" as Address;

describe("outgoing transaction filtering", () => {
  it("accepts outgoing transactions", () => {
    expect(isOutgoingTransaction({ from: watched }, new Set([watched]))).toBe(true);
  });

  it("ignores incoming transactions", () => {
    expect(isOutgoingTransaction({ from: other }, new Set([watched]))).toBe(false);
  });

  it("claims a transaction once and prevents duplicate storage/notifications", async () => {
    const claims = new Set<string>();
    const storeActivity = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const repositories = {
      transactions: {
        claim: async (chainId: number, hash: Hash) => {
          const key = `${chainId}:${hash}`;
          if (claims.has(key)) return false;
          claims.add(key);
          return true;
        },
        storeActivity,
      },
      subscriptions: { recipientsForWallet: async () => [] },
      groupSubscriptions: { recipientsForWallet: async () => [] },
    } as unknown as Repositories;
    const notifications = { send } as unknown as NotificationService;
    const block: ProcessableBlock = {
      number: 10n,
      timestamp: 1_700_000_000n,
      transactions: [{
        hash: `0x${"4".repeat(64)}` as Hash,
        from: watched,
        to: other,
        value: 1n,
        input: "0x",
      }],
    };
    const wallets = [{ id: "wallet", chain_id: 1, address: watched, collectionIds: ["collection"] }];
    await processBlock(1, block, wallets, repositories, notifications);
    await processBlock(1, block, wallets, repositories, notifications);
    expect(storeActivity).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads the wallet balance from the block before an outgoing value transfer", async () => {
    const getBalance = vi.fn(async () => 100n);
    const send = vi.fn(async () => undefined);
    const repositories = {
      transactions: { claim: async () => true, storeActivity: async () => undefined },
      subscriptions: { recipientsForWallet: async () => [] },
      groupSubscriptions: { recipientsForWallet: async () => [] },
    } as unknown as Repositories;
    const block: ProcessableBlock = {
      number: 10n,
      timestamp: 1_700_000_000n,
      transactions: [{
        hash: `0x${"5".repeat(64)}` as Hash,
        from: watched,
        to: other,
        value: 91n,
        input: "0x",
      }],
    };
    await processBlock(
      1,
      block,
      [{ id: "wallet", chain_id: 1, address: watched, collectionIds: ["collection"] }],
      repositories,
      { send } as unknown as NotificationService,
      { getBalance },
    );
    expect(getBalance).toHaveBeenCalledWith({ address: watched, blockNumber: 9n });
    expect(send.mock.calls[0]![1]).toMatchObject({ balanceBefore: 100n });
  });

  it("fans a collection alert out to a subscribed group", async () => {
    const send = vi.fn(async () => undefined);
    const repositories = {
      transactions: { claim: async () => true, storeActivity: async () => undefined },
      subscriptions: { recipientsForWallet: async () => [] },
      groupSubscriptions: {
        recipientsForWallet: async () => [{ telegramId: -100123, collectionId: "collection", collectionName: "FishBroker" }],
      },
    } as unknown as Repositories;
    const block: ProcessableBlock = {
      number: 10n,
      timestamp: 1_700_000_000n,
      transactions: [{
        hash: `0x${"6".repeat(64)}` as Hash,
        from: watched,
        to: other,
        value: 0n,
        input: "0x12345678",
      }],
    };
    await processBlock(
      1,
      block,
      [{ id: "wallet", chain_id: 1, address: watched, collectionIds: ["collection"] }],
      repositories,
      { send } as unknown as NotificationService,
    );
    expect(send).toHaveBeenCalledWith(
      [{ telegramId: -100123, collectionId: "collection", collectionName: "FishBroker" }],
      expect.any(Object),
    );
  });

  it("releases the transaction claim when notification enqueueing fails", async () => {
    const releaseClaim = vi.fn(async () => undefined);
    const transactionHash = `0x${"7".repeat(64)}` as Hash;
    const repositories = {
      transactions: {
        claim: async () => true,
        releaseClaim,
        storeActivity: async () => undefined,
      },
      subscriptions: { recipientsForWallet: async () => [] },
      groupSubscriptions: { recipientsForWallet: async () => [] },
    } as unknown as Repositories;
    const block: ProcessableBlock = {
      number: 10n,
      timestamp: 1_700_000_000n,
      transactions: [{
        hash: transactionHash,
        from: watched,
        to: other,
        value: 1n,
        input: "0x",
      }],
    };

    await expect(processBlock(
      1,
      block,
      [{ id: "wallet", chain_id: 1, address: watched, collectionIds: ["collection"] }],
      repositories,
      { send: vi.fn(async () => { throw new Error("outbox unavailable"); }) } as unknown as NotificationService,
    )).rejects.toThrow("outbox unavailable");

    expect(releaseClaim).toHaveBeenCalledWith(1, transactionHash);
  });
});
