import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config/env.js";
import type { NftPriceAlertRecipient } from "../src/database/repositories/nftPriceAlerts.js";
import type { Repositories } from "../src/database/repositories/index.js";
import {
  alertListKeyboard,
  formatNftPriceAlertDetails,
  formatNftPriceAlerts,
  parseNftTargetPrice,
} from "../src/bot/commands/priceAlerts.js";
import { getOpenSeaFloorPrice } from "../src/opensea/floorPrice.js";
import { NftPriceAlertWatcher, priceTargetReached } from "../src/watcher/nftPriceAlerts.js";
import { formatNftPriceTargetAlert } from "../src/watcher/notifications.js";

const alert: NftPriceAlertRecipient = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  telegramId: 12345,
  slug: "fishbroker",
  collectionName: "FishBroker",
  chain: "robinhood",
  contractAddress: "0x93ceba2125e8c2115943e865674a9109cb38f99a",
  targetPrice: "0.001000000000000000",
  initialFloorPrice: "0.002000000000000000",
  lastFloorPrice: "0.001500000000000000",
  currencySymbol: "ETH",
  direction: "at_or_below",
  status: "active",
  claimedAt: null,
  createdAt: "2026-08-12T00:00:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one-time NFT floor price alerts", () => {
  it("normalizes valid targets and rejects invalid or over-precise values", () => {
    expect(parseNftTargetPrice("0.0100 ETH")).toBe("0.01");
    expect(parseNftTargetPrice(".0005")).toBe("0.0005");
    expect(parseNftTargetPrice("0")).toBeNull();
    expect(parseNftTargetPrice("-1")).toBeNull();
    expect(parseNftTargetPrice("0.1234567890123456789")).toBeNull();
  });

  it("triggers only after the floor crosses the configured direction", () => {
    expect(priceTargetReached("at_or_below", 0.0011, "0.001")).toBe(false);
    expect(priceTargetReached("at_or_below", 0.001, "0.001")).toBe(true);
    expect(priceTargetReached("at_or_below", 0.0009, "0.001")).toBe(true);
    expect(priceTargetReached("at_or_above", 0.0019, "0.002")).toBe(false);
    expect(priceTargetReached("at_or_above", 0.0021, "0.002")).toBe(true);
  });

  it("formats active targets and explains that a delivered target expires", () => {
    const dashboard = formatNftPriceAlerts([alert]);
    expect(dashboard).toContain("1 active");
    expect(dashboard).toContain("falls to or below 0.001 ETH");
    expect(dashboard).toContain("Last floor: 0.0015 ETH");
    expect(dashboard).toContain("Status: 🟢 Watching");
    expect(alertListKeyboard([alert]).inline_keyboard[1]?.[0]?.callback_data).toBe(`price-alert:manage:${alert.id}`);
    expect(alertListKeyboard([alert]).inline_keyboard.flat().some((button) => button.callback_data?.includes("cancel"))).toBe(false);

    const pending = formatNftPriceAlerts([{ ...alert, status: "sending", claimedAt: "2026-08-12T00:10:00Z" }]);
    expect(pending).toContain("Status: 🟡 Delivering notification");

    expect(formatNftPriceAlertDetails(alert, true)).toContain("CANCEL FLOOR-PRICE ALERT?");
    expect(formatNftPriceAlertDetails(alert, true)).toContain("without sending a notification");

    const notification = formatNftPriceTargetAlert({
      alert,
      currentFloor: "0.000900000000000000",
      currencySymbol: "ETH",
    });
    expect(notification).toContain("NFT FLOOR PRICE TARGET REACHED");
    expect(notification).toContain("Target: 0.001 ETH");
    expect(notification).toContain("Current floor: 0.0009 ETH");
    expect(notification).toContain("one-time alert and has now expired");
  });

  it("reads the current floor from the official OpenSea stats response", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      total: { floor_price: 0.0015, floor_price_symbol: "ETH" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(getOpenSeaFloorPrice("test-key", "fishbroker", fetcher)).resolves.toEqual({
      amount: 0.0015,
      symbol: "ETH",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.opensea.io/api/v2/collections/fishbroker/stats",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "test-key" }) }),
    );
  });

  it("claims, delivers, and expires a crossed target exactly once", async () => {
    const nftPriceAlerts = {
      releaseStaleClaims: vi.fn(async () => undefined),
      listForWatcher: vi.fn(async () => [alert]),
      recordFloor: vi.fn(async () => undefined),
      claim: vi.fn(async () => true),
      markTriggered: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const watcher = new NftPriceAlertWatcher(
      { OPENSEA_API_KEY: "test-key", PRICE_ALERT_POLL_INTERVAL_MS: 60_000 } as AppEnv,
      { nftPriceAlerts } as unknown as Repositories,
    );
    const sendNftPriceTarget = vi.fn(async () => undefined);
    (watcher as unknown as { notifications: { sendNftPriceTarget: typeof sendNftPriceTarget } }).notifications = {
      sendNftPriceTarget,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      total: { floor_price: 0.0009, floor_price_symbol: "ETH" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const now = new Date("2026-08-12T00:10:00Z");

    await watcher.pollOnce(now);

    expect(nftPriceAlerts.recordFloor).toHaveBeenCalledWith("fishbroker", "0.0009", now);
    expect(nftPriceAlerts.claim).toHaveBeenCalledWith(alert.id, now);
    expect(sendNftPriceTarget).toHaveBeenCalledWith(alert.telegramId, expect.objectContaining({
      currentFloor: "0.0009",
    }));
    expect(nftPriceAlerts.markTriggered).toHaveBeenCalledWith(alert.id, "0.0009", now);
    expect(nftPriceAlerts.release).not.toHaveBeenCalled();
  });

  it("releases a crossed target when Telegram delivery fails so it can retry", async () => {
    const nftPriceAlerts = {
      releaseStaleClaims: vi.fn(async () => undefined),
      listForWatcher: vi.fn(async () => [alert]),
      recordFloor: vi.fn(async () => undefined),
      claim: vi.fn(async () => true),
      markTriggered: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const watcher = new NftPriceAlertWatcher(
      { OPENSEA_API_KEY: "test-key", PRICE_ALERT_POLL_INTERVAL_MS: 60_000 } as AppEnv,
      { nftPriceAlerts } as unknown as Repositories,
    );
    const deliveryError = new Error("Telegram timeout");
    const sendNftPriceTarget = vi.fn(async () => { throw deliveryError; });
    (watcher as unknown as { notifications: { sendNftPriceTarget: typeof sendNftPriceTarget } }).notifications = {
      sendNftPriceTarget,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      total: { floor_price: 0.0009, floor_price_symbol: "ETH" },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await watcher.pollOnce(new Date("2026-08-12T00:10:00Z"));

    expect(nftPriceAlerts.release).toHaveBeenCalledWith(alert.id);
    expect(nftPriceAlerts.markTriggered).not.toHaveBeenCalled();
  });
});
