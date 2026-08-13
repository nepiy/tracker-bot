import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { Repositories } from "../src/database/repositories/index.js";
import type { MarketplaceWatchedWallet } from "../src/database/repositories/walletSubscriptions.js";
import type { ChainConfig } from "../src/types/index.js";
import { BlockscoutMarketplaceReconciler } from "../src/watcher/blockscoutMarketplace.js";
import type { NotificationService } from "../src/watcher/notifications.js";

const chain: ChainConfig = {
  key: "robinhood",
  name: "Robinhood Chain",
  chainId: 4663,
  openSeaIdentifiers: ["robinhood"],
  rpcUrl: "https://rpc.example",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  explorerApiUrl: "https://robinhoodchain.blockscout.com",
  explorerType: "blockscout",
  nativeSymbol: "ETH",
};
const walletAddress = "0x2019e902214ee743bdf51448d09becf43ad17018" as Address;
const seller = "0x0c16f31a6706817c859ad1411f3388dc38ffb6cc" as Address;
const collection = "0xb3d28a4cc0beaab42c3b46611e4a0b3c9fec7dd9" as Address;
const router = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f" as Address;
const hash = `0x${"b".repeat(64)}`;
const timestamp = "2026-08-13T14:49:43.000Z";
const watched: MarketplaceWatchedWallet = {
  id: "wallet-id",
  chain_id: 4663,
  address: walletAddress,
  recipients: [{ telegramId: 123, subscriptionId: "subscription-id" }],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Blockscout marketplace reconciliation", () => {
  it("recovers a paid router purchase independently from RPC logs and deduplicates later polls", async () => {
    const claim = vi.fn(async () => true);
    const sendMarketplace = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/token-transfers?")) {
        return jsonResponse({
          items: [{
            transaction_hash: hash,
            timestamp,
            token_type: "ERC-721",
          }],
          next_page_params: null,
        });
      }
      if (url.endsWith(`/transactions/${hash}`)) {
        return jsonResponse({
          hash,
          status: "ok",
          block_number: 35_475_007,
          timestamp,
          value: "10829885836081",
          from: { hash: walletAddress },
          to: { hash: router },
          token_transfers: [{
            block_number: 35_475_007,
            transaction_hash: hash,
            timestamp,
            log_index: 34,
            token_type: "ERC-721",
            from: { hash: seller },
            to: { hash: walletAddress },
            token: { address_hash: collection, type: "ERC-721" },
            total: { token_id: "839" },
          }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const reconciler = new BlockscoutMarketplaceReconciler(
      { marketplaceActivity: { claim } } as unknown as Repositories,
      { sendMarketplace } as unknown as NotificationService,
      undefined,
      fetcher,
    );

    const now = new Date("2026-08-13T15:00:00.000Z").getTime();
    await reconciler.reconcile(chain, [watched], now);
    await reconciler.reconcile(chain, [watched], now + 30_000);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(sendMarketplace).toHaveBeenCalledTimes(1);
    expect(sendMarketplace.mock.calls[0]![1]).toMatchObject({
      type: "nft_buy",
      marketplace: "Marketplace router",
      nftContract: collection,
      tokenId: 839n,
      wallet: walletAddress,
    });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes(`/transactions/${hash}`))).toHaveLength(1);
  });

  it("ignores an unpaid direct wallet-to-wallet NFT transfer", async () => {
    const claim = vi.fn(async () => true);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/token-transfers?")) {
        return jsonResponse({
          items: [{ transaction_hash: hash, timestamp, token_type: "ERC-721" }],
          next_page_params: null,
        });
      }
      return jsonResponse({
        hash,
        status: "ok",
        block_number: 35_475_007,
        timestamp,
        value: "0",
        from: { hash: seller },
        to: { hash: collection },
        token_transfers: [{
          block_number: 35_475_007,
          log_index: 34,
          token_type: "ERC-721",
          from: { hash: seller },
          to: { hash: walletAddress },
          token: { address_hash: collection, type: "ERC-721" },
          total: { token_id: "839" },
        }],
      });
    }) as unknown as typeof fetch;
    const reconciler = new BlockscoutMarketplaceReconciler(
      { marketplaceActivity: { claim } } as unknown as Repositories,
      { sendMarketplace: vi.fn() } as unknown as NotificationService,
      undefined,
      fetcher,
    );

    await reconciler.reconcile(chain, [watched], new Date("2026-08-13T15:00:00.000Z").getTime());

    expect(claim).not.toHaveBeenCalled();
  });
});
