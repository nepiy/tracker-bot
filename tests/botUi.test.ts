import { describe, expect, it } from "vitest";
import type { SubscriptionView } from "../src/database/repositories/subscriptions.js";
import type { ActivityRow } from "../src/database/repositories/transactions.js";
import { formatCollectionDetails, formatTrackedCollections } from "../src/bot/commands/list.js";
import { activityMatchesFilter, formatActivityAction } from "../src/bot/commands/activity.js";
import { chainLabel, explorerAddressUrl } from "../src/bot/ui.js";
import { formatWalletSubscriptions } from "../src/bot/commands/wallet.js";

const subscription: SubscriptionView = {
  id: "11111111-1111-4111-8111-111111111111",
  collectionId: "22222222-2222-4222-8222-222222222222",
  slug: "fishbroker",
  name: "FishBroker",
  chain: "robinhood",
  chainId: 4663,
  contractAddress: "0x93ceba2125e8c2115943e865674a9109cb38f99a",
  walletAddress: "0x57ff7e3527e1e0f75de60bd13c90c1fac8a9004f",
  active: true,
};

describe("Telegram collection dashboard", () => {
  it("guides an empty list toward OpenSea link input", () => {
    expect(formatTrackedCollections([])).toContain("Add collection");
    expect(formatTrackedCollections([])).toContain("OpenSea collection link");
  });

  it("formats and filters swaps and bridges as first-class activity", () => {
    const swap: ActivityRow = {
      id: "swap",
      tx_hash: `0x${"1".repeat(64)}`,
      from_address: subscription.walletAddress!,
      to_address: subscription.contractAddress,
      value: "1000000000000000000",
      activity_type: "swap",
      timestamp: new Date().toISOString(),
      metadata: { label: "Swap", method: "Exact-token swap" },
    };
    const bridge: ActivityRow = {
      ...swap,
      id: "bridge",
      tx_hash: `0x${"2".repeat(64)}`,
      activity_type: "bridge",
      metadata: { label: "Bridge", method: "Bridge deposit" },
    };

    expect(formatActivityAction(swap, "ETH")).toContain("🔄 Exact-token swap • 1 ETH");
    expect(formatActivityAction(bridge, "ETH")).toContain("🌉 Bridge deposit • 1 ETH");
    expect(activityMatchesFilter(swap, "swap")).toBe(true);
    expect(activityMatchesFilter(swap, "bridge")).toBe(false);
    expect(activityMatchesFilter(bridge, "all")).toBe(true);
  });

  it("shows collection, network, state, and compact tracked wallet", () => {
    const text = formatTrackedCollections([subscription]);
    expect(text).toContain("1 active collection");
    expect(text).toContain("FishBroker");
    expect(text).toContain("Robinhood Chain • 🟢 Active");
    expect(text).toContain("0x57ff...004f");
  });

  it("shows full collection details and its OpenSea URL", () => {
    const text = formatCollectionDetails(subscription);
    expect(text).toContain(subscription.contractAddress);
    expect(text).toContain(subscription.walletAddress);
    expect(text).toContain("https://opensea.io/collection/fishbroker");
  });

  it("builds supported network labels and explorer links", () => {
    expect(chainLabel(8453, "base")).toBe("Base");
    expect(explorerAddressUrl(4663, subscription.contractAddress)).toBe(
      `https://robinhoodchain.blockscout.com/address/${subscription.contractAddress}`,
    );
    expect(explorerAddressUrl(999, subscription.contractAddress)).toBeNull();
  });

  it("formats direct wallet tracking separately from collections", () => {
    const text = formatWalletSubscriptions([{
      id: "33333333-3333-4333-8333-333333333333",
      walletId: "44444444-4444-4444-8444-444444444444",
      chainId: 8453,
      address: subscription.walletAddress!,
      active: true,
    }]);
    expect(text).toContain("1 active");
    expect(text).toContain("0x57ff...004f");
    expect(text).toContain("Base • 🟢 Active");
  });
});
