import { describe, expect, it, vi } from "vitest";
import { formatCollectionInfo } from "../src/bot/commands/info.js";
import { getCollectionInfo } from "../src/opensea/collectionInfo.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const contract = "0x0000000000000000000000000000000000000001";
const owner = "0x0000000000000000000000000000000000000002";

describe("OpenSea collection information", () => {
  it("returns floor, offer, 24h metrics, owner, and only the owner's other collections", async () => {
    const now = new Date("2026-08-11T12:00:00Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/collections/test-collection")) {
        return jsonResponse({
          collection: "test-collection",
          name: "Test Collection",
          owner,
          opensea_url: "https://opensea.io/collection/test-collection",
          contracts: [{ address: contract, chain: "base" }],
          pricing_currencies: {
            listing_currency: {
              address: "0x0000000000000000000000000000000000000000",
              symbol: "ETH",
              decimals: 18,
              usd_price: "2000",
            },
            offer_currency: {
              address: "0x0000000000000000000000000000000000000003",
              symbol: "WETH",
              decimals: 18,
              usd_price: "2000",
            },
          },
        });
      }
      if (url.pathname.endsWith("/collections/test-collection/stats")) {
        return jsonResponse({
          total: { floor_price: 0.25, floor_price_symbol: "ETH" },
          intervals: [{ interval: "one_day", volume: 12.34567 }],
        });
      }
      if (url.pathname.endsWith("/offers/collection/test-collection")) {
        return jsonResponse({ offers: [{ price: { currency: "WETH", decimals: 18, value: "500000000000000000" } }] });
      }
      if (url.pathname.endsWith("/drops/test-collection")) return jsonResponse({}, 404);
      if (url.pathname.endsWith("/collections/test-collection/floor_prices")) {
        return jsonResponse({
          floor_prices: [
            { time: new Date("2026-08-10T12:00:00Z").getTime() / 1_000, token_unit: 0.2, chain: "base" },
            { time: now.getTime() / 1_000, token_unit: 0.25, chain: "base" },
          ],
        });
      }
      if (url.pathname.endsWith(`/accounts/resolve/${owner}`)) {
        return jsonResponse({ username: "test-owner", ens_name: "owner.eth" });
      }
      if (url.pathname.endsWith("/collections") && url.searchParams.get("creator_username") === "test-owner") {
        return jsonResponse({
          collections: [
            { collection: "test-collection", name: "Test Collection" },
            { collection: "second-collection", name: "Second Collection", opensea_url: "https://opensea.io/collection/second-collection" },
          ],
        });
      }
      throw new Error(`Unexpected OpenSea request: ${url}`);
    });

    const info = await getCollectionInfo(
      "https://opensea.io/collection/test-collection",
      "test-key",
      now,
      fetcher,
    );

    expect(info).toMatchObject({
      name: "Test Collection",
      chain: "base",
      contractAddress: contract,
      ownerAddress: owner,
      ownerUsername: "test-owner",
      ownerEnsName: "owner.eth",
      mint: null,
      floorPrice: 0.25,
      floorPriceSymbol: "ETH",
      topOffer: { amount: "0.5", symbol: "WETH", approximateUsd: 1000 },
      volume24h: 12.34567,
      otherCollections: [{
        name: "Second Collection",
        openSeaUrl: "https://opensea.io/collection/second-collection",
      }],
    });
    expect(info.priceChange24hPercent).toBeCloseTo(25);

    const message = formatCollectionInfo(info);
    expect(message).toContain("Floor price: 0.25 ETH");
    expect(message).toContain("Top offer: 0.5 WETH (≈ $1,000.00)");
    expect(message).toContain("24h volume: 12.3457 ETH");
    expect(message).toContain("24h price change: +25% (floor price)");
    expect(message).toContain("Second Collection");
  });

  it("resolves a contract on supported chains and shows active mint details instead of the floor", async () => {
    const now = new Date("2026-08-11T12:00:00Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/chain/ethereum/contract/")) {
        return jsonResponse({ address: contract, chain: "ethereum", collection: "minting-collection" });
      }
      if (url.pathname.includes("/chain/base/contract/") || url.pathname.includes("/chain/robinhood/contract/")) {
        return jsonResponse({}, 404);
      }
      if (url.pathname.endsWith("/collections/minting-collection")) {
        return jsonResponse({
          collection: "minting-collection",
          name: "Minting Collection",
          opensea_url: "https://opensea.io/collection/minting-collection",
          contracts: [{ address: contract, chain: "ethereum" }],
          pricing_currencies: {
            listing_currency: {
              address: "0x0000000000000000000000000000000000000000",
              symbol: "ETH",
              decimals: 18,
              usd_price: "2000",
            },
          },
        });
      }
      if (url.pathname.endsWith("/drops/minting-collection")) {
        return jsonResponse({
          is_minting: true,
          active_stage: {
            uuid: "public",
            stage_type: "public_sale",
            label: "Public mint",
            price: "10000000000000000",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T11:00:00Z",
            end_time: "2026-08-11T15:00:00Z",
            max_per_wallet: 2,
          },
          total_supply: 125,
          max_supply: 1000,
        });
      }
      if (url.pathname.endsWith("/collections/minting-collection/stats")) {
        return jsonResponse({ total: { floor_price: 0.1, floor_price_symbol: "ETH" }, intervals: [] });
      }
      if (url.pathname.endsWith("/offers/collection/minting-collection")) return jsonResponse({ offers: [] });
      if (url.pathname.endsWith("/collections/minting-collection/floor_prices")) return jsonResponse({ floor_prices: [] });
      throw new Error(`Unexpected OpenSea request: ${url}`);
    });

    const info = await getCollectionInfo(contract, "test-key", now, fetcher);
    expect(info.mint).toMatchObject({
      status: "active",
      label: "Public mint",
      price: "10000000000000000",
      maxPerWallet: "2",
      totalSupply: "125",
      maxSupply: "1000",
    });

    const message = formatCollectionInfo(info);
    expect(message).toContain("Status: 🟢 Minting now");
    expect(message).toContain("Price: 0.01 ETH (≈ $20.00)");
    expect(message).toContain("Minted supply: 125 / 1000");
    expect(message).not.toContain("Floor price:");
    expect(message).not.toContain("Other collections by this owner:");
  });

  it("labels the next stage as minting soon only inside the 12-hour window", async () => {
    const now = new Date("2026-08-11T12:00:00Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/collections/upcoming-collection")) {
        return jsonResponse({
          collection: "upcoming-collection",
          name: "Upcoming Collection",
          contracts: [{ address: contract, chain: "base" }],
        });
      }
      if (url.pathname.endsWith("/drops/upcoming-collection")) {
        return jsonResponse({
          is_minting: false,
          next_stage: {
            uuid: "next-stage",
            stage_type: "allowlist",
            label: "Allowlist mint",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T22:00:00Z",
          },
        });
      }
      if (url.pathname.endsWith("/collections/upcoming-collection/stats")) {
        return jsonResponse({ total: { floor_price: 0.1, floor_price_symbol: "ETH" }, intervals: [] });
      }
      if (url.pathname.endsWith("/offers/collection/upcoming-collection")) return jsonResponse({ offers: [] });
      if (url.pathname.endsWith("/collections/upcoming-collection/floor_prices")) return jsonResponse({ floor_prices: [] });
      throw new Error(`Unexpected OpenSea request: ${url}`);
    });

    const info = await getCollectionInfo(
      "https://opensea.io/collection/upcoming-collection",
      "test-key",
      now,
      fetcher,
    );
    expect(info.mint?.status).toBe("upcoming");
    const message = formatCollectionInfo(info);
    expect(message).toContain("Status: 🕒 Minting soon (within 12 hours)");
    expect(message).toContain("Access: Allowlist");
    expect(message).toContain("Starts: 11 Aug 2026, 22:00 GMT");
    expect(message).not.toContain("Floor price:");
  });
});
