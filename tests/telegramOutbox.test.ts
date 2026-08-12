import { describe, expect, it, vi } from "vitest";
import type { Address, Hash } from "viem";
import type { AppEnv } from "../src/config/env.js";
import type { Repositories } from "../src/database/repositories/index.js";
import type { TelegramOutboxItem } from "../src/database/repositories/telegramOutbox.js";
import { NotificationService } from "../src/watcher/notifications.js";
import { TelegramOutboxWatcher, telegramRetryDelayMs } from "../src/watcher/telegramOutbox.js";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  ETHEREUM_RPC_URL: "https://ethereum.example",
  BASE_RPC_URL: "https://base.example",
  ROBINHOOD_RPC_URL: "https://robinhood.example",
  MONITORING_CHAINS_JSON: "[]",
  CEX_ADDRESSES_JSON: "[]",
  TELEGRAM_OUTBOX_POLL_INTERVAL_MS: 5_000,
} as unknown as AppEnv;

const item: TelegramOutboxItem = {
  id: "11111111-1111-4111-8111-111111111111",
  eventKey: "activity:1:tx:user:collection",
  telegramId: 12345,
  messageText: "automatic alert",
  attempts: 0,
};

function createOutboxHarness(sendText: () => Promise<void>) {
  const releaseStaleClaims = vi.fn(async () => undefined);
  const pruneDelivered = vi.fn(async () => undefined);
  const listPending = vi.fn(async () => [item]);
  const claim = vi.fn(async () => ({ ...item, attempts: 1 }));
  const markDelivered = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const repositories = {
    telegramOutbox: { releaseStaleClaims, pruneDelivered, listPending, claim, markDelivered, release },
  } as unknown as Repositories;
  const watcher = new TelegramOutboxWatcher(env, repositories);
  (watcher as unknown as { notifications: { sendText: typeof sendText } }).notifications = { sendText };
  return { watcher, releaseStaleClaims, pruneDelivered, claim, markDelivered, release };
}

describe("durable Telegram notification outbox", () => {
  it("automatically delivers a queued alert and marks it delivered", async () => {
    const sendText = vi.fn(async () => undefined);
    const harness = createOutboxHarness(sendText);
    const now = new Date("2026-08-12T08:00:00.000Z");

    await harness.watcher.pollOnce(now);

    expect(harness.releaseStaleClaims).toHaveBeenCalledWith(
      new Date("2026-08-12T07:59:00.000Z"),
      now,
    );
    expect(harness.claim).toHaveBeenCalledWith(item, now);
    expect(sendText).toHaveBeenCalledWith(item.telegramId, item.messageText);
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.release).not.toHaveBeenCalled();
  });

  it("keeps a failed Telegram send pending for automatic retry", async () => {
    const sendText = vi.fn(async () => { throw new Error("Telegram timeout"); });
    const harness = createOutboxHarness(sendText);

    await harness.watcher.pollOnce(new Date("2026-08-12T08:00:00.000Z"));

    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledTimes(1);
    expect(harness.release.mock.calls[0]![0]).toBe(item.id);
    expect(harness.release.mock.calls[0]![1]).toBeInstanceOf(Error);
    expect(harness.release.mock.calls[0]![2].getTime()).toBeGreaterThan(Date.now());
  });

  it("backs retries off and caps the wait at one hour", () => {
    expect(telegramRetryDelayMs(1)).toBe(5_000);
    expect(telegramRetryDelayMs(2)).toBe(10_000);
    expect(telegramRetryDelayMs(100)).toBe(3_600_000);
  });

  it("durably queues every automatic alert category instead of sending inline", async () => {
    const enqueue = vi.fn(async () => undefined);
    const service = new NotificationService(env, { enqueue } as never);
    const wallet = "0x0000000000000000000000000000000000000001" as Address;
    const other = "0x0000000000000000000000000000000000000002" as Address;
    const nft = "0x0000000000000000000000000000000000000003" as Address;
    const hash = `0x${"4".repeat(64)}` as Hash;

    await service.send(
      [{ telegramId: 12345, collectionId: "collection-id", collectionName: "Collection" }],
      {
        chainId: 1,
        wallet,
        to: other,
        value: 1n,
        hash,
        decoded: { type: "native_transfer", label: "Native transfer", metadata: { recipient: other } },
        balanceBefore: 100n,
      },
    );
    await service.sendMarketplace(
      [{ telegramId: 12345, subscriptionId: "subscription-id" }],
      {
        chainId: 1,
        wallet,
        hash,
        type: "nft_buy",
        marketplace: "Seaport",
        nftContract: nft,
        tokenId: 42n,
        quantity: 1n,
        standard: "ERC-721",
        counterparty: other,
      },
    );

    const stage = {
      slug: "free-mint",
      name: "Free Mint",
      chain: "ethereum",
      openSeaUrl: "https://opensea.io/collection/free-mint",
      stageId: "public-stage",
      stageType: "public_sale",
      stageLabel: "Public mint",
      price: "0",
      currencyAddress: "0x0000000000000000000000000000000000000000",
      startsAt: new Date("2026-08-12T10:00:00.000Z"),
      endsAt: null,
    };
    await service.sendFreeMint(12345, stage);
    await service.sendMintPriceChange(12345, {
      stage: { ...stage, price: "10000000000000000" },
      token: { symbol: "ETH", decimals: 18, usdPrice: "3000" },
    }, 2);
    await service.sendNftPriceTarget(12345, {
      alert: {
        id: "price-alert-id",
        userId: "user-id",
        telegramId: 12345,
        slug: "free-mint",
        collectionName: "Free Mint",
        chain: "ethereum",
        contractAddress: nft,
        targetPrice: "0.01",
        initialFloorPrice: "0.02",
        lastFloorPrice: "0.01",
        currencySymbol: "ETH",
        currencyAddress: "0x0000000000000000000000000000000000000000",
        usdRate: "3000",
        direction: "at_or_below",
        status: "sending",
        claimedAt: "2026-08-12T08:00:00.000Z",
        createdAt: "2026-08-12T07:00:00.000Z",
      },
      currentFloor: "0.01",
      currencySymbol: "ETH",
      usdRate: "3000",
    });

    expect(enqueue).toHaveBeenCalledTimes(5);
    expect(enqueue.mock.calls[0]![0][0]).toMatchObject({
      eventKey: `activity:1:${hash}:12345:collection-id`,
      telegramId: 12345,
    });
    expect(enqueue.mock.calls[1]![0][0]).toMatchObject({
      eventKey: expect.stringContaining("marketplace:1:"),
      telegramId: 12345,
    });
    expect(enqueue.mock.calls[2]![0][0].eventKey).toContain("free-mint:public-stage:");
    expect(enqueue.mock.calls[3]![0][0].eventKey).toContain("mint-price-change:public-stage:");
    expect(enqueue.mock.calls[4]![0][0]).toMatchObject({
      eventKey: "nft-price-target:price-alert-id:12345",
      telegramId: 12345,
    });
  });
});
