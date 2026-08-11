import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { Repositories } from "../src/database/repositories/index.js";
import { expandCollectionWallets } from "../src/watcher/watcher.js";

describe("cross-chain dev wallet expansion", () => {
  it("links the same inferred address to a configured monitoring chain", async () => {
    const address = "0x0000000000000000000000000000000000000001" as Address;
    const linkCollection = vi.fn(async () => undefined);
    const repositories = {
      wallets: {
        upsert: async (chainId: number, walletAddress: Address) => ({ id: "arb-wallet", chain_id: chainId, address: walletAddress }),
        linkCollection,
      },
    } as unknown as Repositories;

    const expanded = await expandCollectionWallets(
      42161,
      [{ id: "eth-wallet", chain_id: 1, address, collectionIds: ["collection"] }],
      new Set(),
      repositories,
    );

    expect(expanded).toEqual([{ id: "arb-wallet", chain_id: 42161, address, collectionIds: ["collection"] }]);
    expect(linkCollection).toHaveBeenCalledWith("collection", "arb-wallet", "cross_chain_dev", 100, []);
  });
});
