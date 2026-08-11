import { describe, expect, it, vi } from "vitest";
import {
  findUpcomingFreeMints,
  findUpcomingMintStages,
  getOpenSeaTokenDetails,
} from "../src/opensea/upcomingDrops.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenSea upcoming free mints", () => {
  it("finds zero-price stages starting in the next 12 hours", async () => {
    const now = new Date("2026-08-11T10:00:00Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/drops?")) {
        return jsonResponse({
          drops: [{
            collection_slug: "free-public-drop",
            collection_name: "Free Public Drop",
            chain: "base",
            opensea_url: "https://opensea.io/collection/free-public-drop",
            next_stage: { start_time: "2026-08-11T14:00:00Z" },
          }],
          next: null,
        });
      }
      return jsonResponse({
        collection_slug: "free-public-drop",
        collection_name: "Free Public Drop",
        chain: "base",
        opensea_url: "https://opensea.io/collection/free-public-drop",
        stages: [
          {
            uuid: "public-free",
            stage_type: "public_sale",
            label: "Public mint",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T14:00:00Z",
            end_time: "2026-08-11T16:00:00Z",
          },
          {
            uuid: "paid",
            stage_type: "public_sale",
            label: "Paid mint",
            price: "1000000000000000",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T15:00:00Z",
          },
          {
            uuid: "creator-reserve",
            stage_type: "signed_presale",
            label: "Creator Reserve",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T13:00:00Z",
          },
          {
            uuid: "too-late",
            stage_type: "public_sale",
            label: "Later free mint",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-12T23:00:00Z",
          },
        ],
      });
    });

    await expect(findUpcomingFreeMints("test-key", now, 12, fetcher)).resolves.toEqual([{
      slug: "free-public-drop",
      name: "Free Public Drop",
      chain: "base",
      openSeaUrl: "https://opensea.io/collection/free-public-drop",
      stageId: "public-free",
      stageType: "public_sale",
      stageLabel: "Public mint",
      price: "0",
      currencyAddress: "0x0000000000000000000000000000000000000000",
      startsAt: new Date("2026-08-11T14:00:00Z"),
      endsAt: new Date("2026-08-11T16:00:00Z"),
    }]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const stages = await findUpcomingMintStages("test-key", now, 12, fetcher);
    expect(stages.map((stage) => [stage.stageId, stage.price])).toEqual([
      ["public-free", "0"],
      ["paid", "1000000000000000"],
    ]);
  });

  it("does not request drop details when the next stage is outside the window", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      drops: [{
        collection_slug: "later-drop",
        next_stage: { start_time: "2026-08-12T23:00:00Z" },
      }],
      next: null,
    }));

    await expect(findUpcomingFreeMints(
      "test-key",
      new Date("2026-08-11T10:00:00Z"),
      12,
      fetcher,
    )).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads payment-token decimals, symbol, and USD price", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      symbol: "USDC",
      decimals: 6,
      usd_price: "1.0",
    }));

    await expect(getOpenSeaTokenDetails(
      "test-key",
      "base",
      "0x0000000000000000000000000000000000000001",
      fetcher,
    )).resolves.toEqual({ symbol: "USDC", decimals: 6, usdPrice: "1.0" });
  });
});
