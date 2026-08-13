import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { getOpenSeaNftSummary } from "../src/opensea/nft.js";

const contract = "0x2e4ac62072807923c0d7736b58272c8202019953" as Address;

describe("OpenSea NFT metadata", () => {
  it("returns the NFT display name and canonical OpenSea asset link", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      nft: {
        name: "Robinhood Chungos #6453",
        opensea_url: `https://opensea.io/assets/robinhood/${contract}/6453`,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(getOpenSeaNftSummary("test-key", "robinhood", contract, 6453n, fetcher)).resolves.toEqual({
      name: "Robinhood Chungos #6453",
      openSeaUrl: `https://opensea.io/assets/robinhood/${contract}/6453`,
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.opensea.io/api/v2/chain/robinhood/contract/${contract}/nfts/6453`,
      expect.objectContaining({ headers: { accept: "application/json", "x-api-key": "test-key" } }),
    );
  });

  it("returns null when OpenSea has no metadata for the NFT", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(getOpenSeaNftSummary("test-key", "robinhood", contract, 6453n, fetcher)).resolves.toBeNull();
  });
});
