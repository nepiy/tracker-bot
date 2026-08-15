import { describe, expect, it, vi } from "vitest";
import {
  findFreeMintDirectory,
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
            chain: "robinhood",
            opensea_url: "https://opensea.io/collection/free-public-drop",
            next_stage: { start_time: "2026-08-11T14:00:00Z" },
          }],
          next: null,
        });
      }
      return jsonResponse({
        collection_slug: "free-public-drop",
        collection_name: "Free Public Drop",
        chain: "robinhood",
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
            uuid: "gtd-free",
            stage_type: "allowlist",
            label: "GTD",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T14:30:00Z",
            end_time: "2026-08-11T15:00:00Z",
          },
          {
            uuid: "fcfs-free",
            stage_type: "signed_mint",
            label: "FCFS",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-11T15:30:00Z",
            end_time: "2026-08-11T16:00:00Z",
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

    await expect(findUpcomingFreeMints("test-key", now, 12, fetcher)).resolves.toMatchObject([
      { stageId: "public-free", stageLabel: "Public mint", startsAt: new Date("2026-08-11T14:00:00Z") },
      { stageId: "gtd-free", stageLabel: "GTD", startsAt: new Date("2026-08-11T14:30:00Z") },
      { stageId: "fcfs-free", stageLabel: "FCFS", startsAt: new Date("2026-08-11T15:30:00Z") },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const stages = await findUpcomingMintStages("test-key", now, 12, fetcher);
    expect(stages.map((stage) => [stage.stageId, stage.price])).toEqual([
      ["public-free", "0"],
      ["gtd-free", "0"],
      ["paid", "1000000000000000"],
      ["fcfs-free", "0"],
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
      "robinhood",
      "0x0000000000000000000000000000000000000001",
      fetcher,
    )).resolves.toEqual({ symbol: "USDC", decimals: 6, usdPrice: "1.0" });
  });

  it("freshly separates upcoming and currently-live free stages", async () => {
    const now = new Date("2026-08-13T12:00:00Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const type = url.searchParams.get("type");
      if (type === "upcoming") {
        return jsonResponse({
          drops: [
            {
              collection_slug: "later-free",
              collection_name: "Later Free",
              chain: "robinhood",
              opensea_url: "https://opensea.io/collection/later-free",
              is_minting: false,
              next_stage: {
                uuid: "later-stage",
                stage_type: "public_sale",
                label: "Public mint",
                price: "0",
                price_currency_address: "0x0000000000000000000000000000000000000000",
                start_time: "2026-08-14T18:00:00Z",
                end_time: "2026-08-14T20:00:00Z",
              },
            },
            {
              collection_slug: "live-free",
              collection_name: "Live Free",
              chain: "robinhood",
              opensea_url: "https://opensea.io/collection/live-free",
              is_minting: true,
              active_stage: {
                uuid: "live-stage",
                stage_type: "public_sale",
                label: "Live public mint",
                price: "0",
                price_currency_address: "0x0000000000000000000000000000000000000000",
                start_time: "2026-08-13T11:00:00Z",
                end_time: "2026-08-13T15:00:00Z",
              },
            },
          ],
          next: null,
        });
      }
      if (type === "featured") return jsonResponse({ drops: [], next: null });
      return jsonResponse({
        drops: [{
          collection_slug: "live-free",
          collection_name: "Live Free",
          chain: "robinhood",
          opensea_url: "https://opensea.io/collection/live-free",
          is_minting: true,
          active_stage: {
            uuid: "live-stage",
            stage_type: "public_sale",
            label: "Live public mint",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-13T11:00:00Z",
            end_time: "2026-08-13T15:00:00Z",
          },
        }],
        next: null,
      });
    });

    const upcoming = await findFreeMintDirectory("test-key", "upcoming", now, fetcher);
    const live = await findFreeMintDirectory("test-key", "live", now, fetcher);

    expect(upcoming.map((mint) => mint.slug)).toEqual(["later-free"]);
    expect(live.map((mint) => mint.slug)).toEqual(["live-free"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("hides a free stage when its drop supply is sold out", async () => {
    const now = new Date("2026-08-15T19:00:00Z");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("type")) {
        return jsonResponse({
          collection_slug: "sold-out-free",
          collection_name: "Sold Out Free",
          chain: "robinhood",
          total_supply: "1000",
          max_supply: "1000",
        });
      }
      if (url.searchParams.get("type") !== "featured") return jsonResponse({ drops: [], next: null });
      return jsonResponse({
        drops: [{
          collection_slug: "sold-out-free",
          collection_name: "Sold Out Free",
          chain: "robinhood",
          is_minting: true,
          active_stage: {
            uuid: "sold-out-stage",
            stage_type: "public_sale",
            label: "Public mint",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-15T17:00:00Z",
            end_time: "2026-08-16T17:00:00Z",
          },
        }],
        next: null,
      });
    });

    await expect(findFreeMintDirectory("test-key", "live", now, fetcher)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("continues calendar pagination when OpenSea returns a short page with a cursor", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        return jsonResponse({ drops: [], next: "second-page" });
      }
      return jsonResponse({
        drops: [{
          collection_slug: "newly-listed-free",
          collection_name: "Newly Listed Free",
          chain: "ethereum",
          opensea_url: "https://opensea.io/collection/newly-listed-free",
          is_minting: false,
          next_stage: {
            uuid: "new-stage",
            stage_type: "public_sale",
            label: "Public mint",
            price: "0",
            price_currency_address: "0x0000000000000000000000000000000000000000",
            start_time: "2026-08-13T14:00:00Z",
            end_time: null,
          },
        }],
        next: null,
      });
    });

    const mints = await findFreeMintDirectory(
      "test-key",
      "upcoming",
      new Date("2026-08-13T12:00:00Z"),
      fetcher,
    );

    expect(mints.map((mint) => mint.slug)).toEqual(["newly-listed-free"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
