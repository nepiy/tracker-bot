import { InlineKeyboard, type Bot } from "grammy";
import type { SubscriptionView } from "../../database/repositories/subscriptions.js";
import type { BotContext, BotDependencies } from "../context.js";
import { shortAddress } from "../../utils/address.js";
import { chainLabel, editMessageSafely, explorerAddressUrl } from "../ui.js";

export function formatTrackedCollections(subscriptions: SubscriptionView[]): string {
  if (!subscriptions.length) {
    return [
      "📡 Tracked Collections",
      "",
      "No collections are being tracked yet.",
      "",
      "Tap “Add collection” and send an OpenSea collection link to get started.",
    ].join("\n");
  }

  const lines = subscriptions.flatMap((subscription, index) => [
    `${index + 1}. ${subscription.name}`,
    `   ${chainLabel(subscription.chainId, subscription.chain)} • 🟢 Active`,
    `   Wallet: ${subscription.walletAddress ? shortAddress(subscription.walletAddress) : "Analyzing"}`,
    "",
  ]);
  const noun = subscriptions.length === 1 ? "collection" : "collections";
  return [
    "📡 Tracked Collections",
    "",
    `${subscriptions.length} active ${noun}`,
    "",
    ...lines,
    "Select a collection below to view its details.",
  ].join("\n").trim();
}

export function formatCollectionDetails(subscription: SubscriptionView): string {
  return [
    `🧿 ${subscription.name}`,
    "",
    "Status: 🟢 Active",
    `Network: ${chainLabel(subscription.chainId, subscription.chain)}`,
    "",
    "Collection contract:",
    subscription.contractAddress,
    "",
    "Tracked dev/team wallet (inferred):",
    subscription.walletAddress ?? "Analysis unavailable",
    "",
    `OpenSea: https://opensea.io/collection/${subscription.slug}`,
  ].join("\n");
}

function listKeyboard(subscriptions: SubscriptionView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("➕ Add collection", "menu:track").row();
  for (const subscription of subscriptions) {
    keyboard.text(`🧿 ${subscription.name}`, `list:${subscription.id}`).row();
  }
  return keyboard
    .text("⚡ Activity", "menu:activity")
    .text("🛑 Stop", "menu:stop")
    .row()
    .text("🔄 Refresh", "menu:list")
    .text("🏠 Menu", "menu:home");
}

async function loadSubscriptions(ctx: BotContext, dependencies: BotDependencies): Promise<SubscriptionView[]> {
  if (!ctx.from) return [];
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  return dependencies.repositories.subscriptions.listActive(user.id);
}

async function showList(ctx: BotContext, dependencies: BotDependencies, edit: boolean): Promise<void> {
  const subscriptions = await loadSubscriptions(ctx, dependencies);
  const text = formatTrackedCollections(subscriptions);
  const keyboard = listKeyboard(subscriptions);
  if (edit) {
    await editMessageSafely(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function registerListCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("list", (ctx) => showList(ctx, dependencies, false));

  bot.callbackQuery("menu:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showList(ctx, dependencies, true);
  });

  bot.callbackQuery(/^list:([0-9a-f-]{36})$/i, async (ctx) => {
    await ctx.answerCallbackQuery();
    const subscriptionId = ctx.match[1];
    if (!subscriptionId) return;
    const subscriptions = await loadSubscriptions(ctx, dependencies);
    const subscription = subscriptions.find((item) => item.id === subscriptionId);
    if (!subscription) {
      await editMessageSafely(ctx, "This collection is no longer being tracked.", listKeyboard(subscriptions));
      return;
    }

    const keyboard = new InlineKeyboard()
      .url("🌊 OpenSea", `https://opensea.io/collection/${subscription.slug}`);
    const explorerUrl = explorerAddressUrl(subscription.chainId, subscription.contractAddress);
    if (explorerUrl) keyboard.url("🔎 Explorer", explorerUrl);
    keyboard
      .row()
      .text("⚡ Activity", `activity:${subscription.id}`)
      .text("🛑 Stop", `stop:${subscription.id}`)
      .row()
      .text("← Collections", "menu:list")
      .text("🏠 Menu", "menu:home");
    await editMessageSafely(ctx, formatCollectionDetails(subscription), keyboard);
  });
}
