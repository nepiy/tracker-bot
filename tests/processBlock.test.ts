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
});
