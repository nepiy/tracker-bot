import { describe, expect, it } from "vitest";
import type { SubscriptionView } from "../src/database/repositories/subscriptions.js";
import type { ActivityRow } from "../src/database/repositories/transactions.js";
import { formatCollectionDetails, formatTrackedCollections } from "../src/bot/commands/list.js";
import { activityMatchesFilter, formatActivityAction } from "../src/bot/commands/activity.js";
import { chainLabel, explorerAddressUrl, HELP_TEXT, MAIN_MENU_TEXT, mainMenuKeyboard } from "../src/bot/ui.js";
import { formatWalletSubscriptions, WALLET_PROMPT } from "../src/bot/commands/wallet.js";
import { ADD_TO_GROUP_TEXT, formatGroupSubscriptions, groupInstallUrl } from "../src/bot/commands/group.js";
import { isAdminStatus } from "../src/bot/groupAdmin.js";
import { formatSettings } from "../src/bot/commands/settings.js";
import { formatFreeMintAlert, formatMintPriceChangeAlert } from "../src/watcher/notifications.js";
import { activeTrackingKeyboard, formatActiveTracking } from "../src/bot/commands/activeTracking.js";
import {
  FREE_MINTS_MENU_TEXT,
  formatFreeMintDirectory,
  freeMintDirectoryKeyboard,
  freeMintsMenuKeyboard,
} from "../src/bot/commands/freeMints.js";
import { GROUP_TRACK_PROMPT, TRACK_PROMPT } from "../src/bot/commands/track.js";

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
  it("asks for a collection link without displaying an example URL", () => {
    expect(TRACK_PROMPT).toBe("➕ Add an OpenSea collection\n\nSend the full collection link");
    expect(GROUP_TRACK_PROMPT).toContain("Send the full collection link");
    expect(GROUP_TRACK_PROMPT).not.toContain("https://");
  });

  it("explains and groups the dashboard's primary workflows", () => {
    expect(MAIN_MENU_TEXT).toContain("🔎 Research NFT");
    expect(MAIN_MENU_TEXT).toContain("🎯 Floor alerts");
    expect(MAIN_MENU_TEXT).toContain("📡 Collection tracking");
    expect(MAIN_MENU_TEXT).toContain("👛 Wallet tracking");
    expect(MAIN_MENU_TEXT).toContain("👥 Group tracking");
    expect(MAIN_MENU_TEXT).toContain("Ethereum • Robinhood Chain");

    expect(mainMenuKeyboard().inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["👥 Add to Group"],
      ["📋 Active Tracking"],
      ["🔎 Research NFT", "🎯 Floor Alerts"],
      ["➕ Add Collection", "📡 Tracking Collection"],
      ["⚡ Recent Activity"],
      ["👛 Add Wallet", "🗂 Tracking Wallet"],
      ["🆓 Free Mints"],
      ["⚙️ Alert Settings", "🛑 Stop Collection"],
      ["❓ Guide", "🔄 Refresh Dashboard"],
    ]);
  });

  it("limits direct wallet tracking to Robinhood Chain while keeping research multi-chain", () => {
    expect(WALLET_PROMPT).toContain("Robinhood Chain");
    expect(WALLET_PROMPT).not.toContain("choose the network");
    expect(WALLET_PROMPT).not.toContain("Ethereum");
    expect(HELP_TEXT).toContain("on Robinhood Chain");
  });

  it("offers fresh, separate upcoming and live free-mint views", () => {
    const mints = Array.from({ length: 6 }, (_, index) => ({
      slug: `free-${index + 1}`,
      name: `Free Mint ${index + 1}`,
      chain: "robinhood",
      openSeaUrl: `https://opensea.io/collection/free-${index + 1}`,
      stageId: `stage-${index + 1}`,
      stageType: "public_sale",
      stageLabel: "Public mint",
      price: "0",
      currencyAddress: "0x0000000000000000000000000000000000000000",
      startsAt: new Date(`2026-08-14T${String(10 + index).padStart(2, "0")}:00:00Z`),
      endsAt: null,
    }));
    const now = new Date("2026-08-13T12:00:00Z");

    expect(FREE_MINTS_MENU_TEXT).toContain("Every check fetches a new snapshot");
    expect(freeMintsMenuKeyboard().inline_keyboard[0]?.map((button) => button.text)).toEqual([
      "🕒 Upcoming",
      "🟢 Live now",
    ]);
    const text = formatFreeMintDirectory("upcoming", mints, 0, now);
    expect(text).toContain("UPCOMING FREE MINTS");
    expect(text).toContain("Fresh OpenSea check:");
    expect(text).toContain("Found: 6 free mint stages");
    expect(text).toContain("Page: 1/2");
    expect(text).toContain("Free Mint 1");
    expect(text).not.toContain("Free Mint 6");
    expect(freeMintDirectoryKeyboard("upcoming", mints, 0).inline_keyboard.flat().some(
      (button) => button.callback_data === "free-mints:upcoming:1",
    )).toBe(true);
    expect(formatFreeMintDirectory("live", [], 0, now)).toContain(
      "not currently reporting a free public, GTD, or FCFS stage as live with supply remaining",
    );
  });

  it("summarizes every personal monitor and groups wallet networks", () => {
    const wallet = subscription.walletAddress!;
    const text = formatActiveTracking({
      collections: [subscription],
      wallets: [
        { id: "wallet-eth", walletId: "eth", chainId: 1, address: wallet, active: true },
        { id: "wallet-rh", walletId: "rh", chainId: 4663, address: wallet, active: true },
      ],
      priceAlerts: [{
        id: "price-alert",
        userId: "user",
        slug: subscription.slug,
        collectionName: subscription.name,
        chain: subscription.chain,
        contractAddress: subscription.contractAddress,
        targetPrice: "0.001000",
        initialFloorPrice: "0.002",
        lastFloorPrice: "0.0015",
        currencySymbol: "ETH",
        currencyAddress: "0x0000000000000000000000000000000000000000",
        usdRate: "2000",
        direction: "at_or_below",
        status: "active",
        claimedAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      }],
      freeMintAlertsEnabled: true,
    });

    expect(text).toContain("YOUR ACTIVE TRACKING");
    expect(text).toContain("📡 Collections: 1");
    expect(text).toContain("👛 Wallets: 1 address • 2 network monitors");
    expect(text).toContain("0x57ff...004f — Ethereum, Robinhood Chain");
    expect(text).toContain("FishBroker — floor ≤ 0.001 ETH (≈ $2.00)");
    expect(text).toContain("Free-mint alerts: 🟢 ON");
    expect(text).toContain("managed inside each Telegram group");
  });

  it("guides an empty active-tracking dashboard to each setup path", () => {
    expect(formatActiveTracking({
      collections: [],
      wallets: [],
      priceAlerts: [],
      freeMintAlertsEnabled: false,
    })).toContain("Nothing is active yet");
    expect(activeTrackingKeyboard().inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["📡 Collections", "👛 Wallets"],
      ["🎯 Floor Alerts"],
      ["➕ Add Collection", "➕ Add Wallet"],
      ["⚡ Recent Activity"],
      ["🔄 Refresh", "🏠 Main Menu"],
    ]);
  });

  it("builds the Telegram group picker link and explains admin control", () => {
    expect(groupInstallUrl("tracker_bot")).toBe("https://t.me/tracker_bot?startgroup=tracker");
    expect(ADD_TO_GROUP_TEXT).toContain("Choose a Group");
    expect(ADD_TO_GROUP_TEXT).toContain("Only group admins");
  });

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
    expect(chainLabel(4663, "robinhood")).toBe("Robinhood Chain");
    expect(explorerAddressUrl(4663, subscription.contractAddress)).toBe(
      `https://robinhoodchain.blockscout.com/address/${subscription.contractAddress}`,
    );
    expect(explorerAddressUrl(999, subscription.contractAddress)).toBeNull();
  });

  it("formats direct wallet tracking separately from collections", () => {
    const text = formatWalletSubscriptions([{
      id: "33333333-3333-4333-8333-333333333333",
      walletId: "44444444-4444-4444-8444-444444444444",
      chainId: 4663,
      address: subscription.walletAddress!,
      active: true,
    }]);
    expect(text).toContain("1 active");
    expect(text).toContain("0x57ff...004f");
    expect(text).toContain("Robinhood Chain • 🟢 Active");
  });

  it("formats group subscriptions and recognizes only Telegram admin roles", () => {
    const text = formatGroupSubscriptions([{
      id: "55555555-5555-4555-8555-555555555555",
      collectionId: subscription.collectionId,
      slug: subscription.slug,
      name: subscription.name,
      chain: subscription.chain,
      chainId: subscription.chainId,
      contractAddress: subscription.contractAddress,
      walletAddress: subscription.walletAddress,
    }]);
    expect(text).toContain("Group tracking");
    expect(text).toContain("Only group admins");
    expect(isAdminStatus("creator")).toBe(true);
    expect(isAdminStatus("administrator")).toBe(true);
    expect(isAdminStatus("member")).toBe(false);
  });

  it("shows the opt-in free mint preference and GMT notification time", () => {
    expect(formatSettings(false)).toContain("⚪ OFF");
    expect(formatSettings(true)).toContain("🟢 ON");
    expect(formatSettings(true)).toContain("price-change warning");
    const alertMint = {
      slug: "free-public-drop",
      name: "Free Public Drop",
      chain: "robinhood",
      openSeaUrl: "https://opensea.io/collection/free-public-drop",
      stageId: "public-free",
      stageType: "public_sale",
      stageLabel: "Public mint",
      price: "0",
      currencyAddress: "0x0000000000000000000000000000000000000000",
      startsAt: new Date("2026-08-11T14:05:00Z"),
      endsAt: new Date("2026-08-11T16:00:00Z"),
    } as const;
    const alert = formatFreeMintAlert(alertMint);
    expect(alert).toContain("OPENSEA FREE MINT ALERT");
    expect(alert).toContain("Price: FREE");
    expect(alert).toContain("11 Aug 2026, 14:05 GMT");
    expect(alert).toContain("Access: Public");

    expect(formatFreeMintAlert({ ...alertMint, stageType: "allowlist", stageLabel: "GTD" })).toContain("Access: GTD");
    expect(formatFreeMintAlert({ ...alertMint, stageType: "signed_mint", stageLabel: "FCFS" })).toContain("Access: FCFS");
  });

  it("formats a free-to-paid mint transition with token and USD values", () => {
    const alert = formatMintPriceChangeAlert({
      stage: {
        slug: "changed-mint",
        name: "Changed Mint",
        chain: "robinhood",
        openSeaUrl: "https://opensea.io/collection/changed-mint",
        stageId: "changed-stage",
        stageType: "public_sale",
        stageLabel: "Public mint",
        price: "10000",
        currencyAddress: "0x0000000000000000000000000000000000000001",
        startsAt: new Date("2026-08-11T15:00:00Z"),
        endsAt: null,
      },
      token: { symbol: "USDC", decimals: 6, usdPrice: "1" },
    });
    expect(alert).toContain("MINT PRICE CHANGED");
    expect(alert).toContain("Previous price: FREE");
    expect(alert).toContain("New price: 0.01 USDC (≈ $0.01)");
    expect(alert).toContain("11 Aug 2026, 15:00 GMT");
  });
});
