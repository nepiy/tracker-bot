import { InlineKeyboard, type Bot } from "grammy";
import { formatEther } from "viem";
import type { BotContext, BotDependencies } from "../context.js";
import type { SubscriptionView } from "../../database/repositories/subscriptions.js";
import type { ActivityRow } from "../../database/repositories/transactions.js";
import { getChainById } from "../../blockchain/chains.js";
import { shortAddress } from "../../utils/address.js";
import { editMessageSafely } from "../ui.js";

export type ActivityFilter = "all" | "send" | "swap" | "bridge";

const SEND_TYPES = new Set(["native_transfer", "erc20_transfer", "nft_transfer"]);

export function activityMatchesFilter(activity: ActivityRow, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "send") return SEND_TYPES.has(activity.activity_type);
  return activity.activity_type === filter;
}

export function formatActivityAction(activity: ActivityRow, nativeSymbol: string): string {
  const destination = String(activity.metadata.recipient ?? activity.to_address ?? "contract creation");
  const shortDestination = destination.startsWith("0x") ? shortAddress(destination) : destination;
  const nativeValue = BigInt(activity.value);
  const value = nativeValue > 0n ? `${formatEther(nativeValue)} ${nativeSymbol}` : null;

  switch (activity.activity_type) {
    case "native_transfer":
      return `📤 Send ${value ?? `0 ${nativeSymbol}`} → ${shortDestination}`;
    case "erc20_transfer":
      return `📤 ERC-20 send → ${shortDestination}`;
    case "nft_transfer": {
      const tokenId = activity.metadata.tokenId ? ` #${String(activity.metadata.tokenId)}` : "";
      return `🖼 NFT send${tokenId} → ${shortDestination}`;
    }
    case "swap":
      return `🔄 ${String(activity.metadata.method ?? "Swap")}${value ? ` • ${value}` : ""} via ${shortDestination}`;
    case "bridge":
      return `🌉 ${String(activity.metadata.method ?? "Bridge")}${value ? ` • ${value}` : ""} via ${shortDestination}`;
    default:
      return `🧩 ${String(activity.metadata.label ?? "Contract interaction")} → ${shortDestination}`;
  }
}

function relativeTime(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function registerActivityCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  async function loadSubscriptions(ctx: BotContext): Promise<SubscriptionView[]> {
    if (!ctx.from) return [];
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    return dependencies.repositories.subscriptions.listActive(user.id);
  }

  function activityKeyboard(subscriptions: SubscriptionView[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const subscription of subscriptions) {
      keyboard.text(`⚡ ${subscription.name}`, `activity:${subscription.id}`).row();
    }
    return keyboard
      .text("← Collections", "menu:list")
      .text("🏠 Menu", "menu:home");
  }

  function feedKeyboard(subscriptionId: string, filter: ActivityFilter): InlineKeyboard {
    const button = (emoji: string, label: string, value: ActivityFilter) => `${filter === value ? "✅" : emoji} ${label}`;
    return new InlineKeyboard()
      .text(button("📊", "All", "all"), `activity:${subscriptionId}:all`)
      .text(button("📤", "Sends", "send"), `activity:${subscriptionId}:send`)
      .row()
      .text(button("🔄", "Swaps", "swap"), `activity:${subscriptionId}:swap`)
      .text(button("🌉", "Bridges", "bridge"), `activity:${subscriptionId}:bridge`)
      .row()
      .text("🔄 Refresh", `activity:${subscriptionId}:${filter}`)
      .text("← Collections", "menu:list")
      .row()
      .text("🏠 Menu", "menu:home");
  }

  async function showActivityMenu(ctx: BotContext, edit: boolean): Promise<void> {
    const subscriptions = await loadSubscriptions(ctx);
    const text = subscriptions.length
      ? "⚡ Recent Activity\n\nChoose a tracked collection."
      : "⚡ Recent Activity\n\nTrack a collection before viewing activity.";
    const keyboard = activityKeyboard(subscriptions);
    if (edit) {
      await editMessageSafely(ctx, text, keyboard);
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  }

  bot.command("activity", (ctx) => showActivityMenu(ctx, false));

  bot.callbackQuery("menu:activity", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showActivityMenu(ctx, true);
  });

  bot.callbackQuery(/^activity:([0-9a-f-]{36})(?::(all|send|swap|bridge))?$/i, async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const subscriptionId = ctx.match[1];
    if (!subscriptionId) return;
    const filter = (ctx.match[2]?.toLowerCase() ?? "all") as ActivityFilter;
    const subscriptions = await loadSubscriptions(ctx);
    const subscription = subscriptions.find((item) => item.id === subscriptionId);
    if (!subscription) {
      await editMessageSafely(ctx, "This collection is no longer being tracked.", activityKeyboard(subscriptions));
      return;
    }
    const activity = await dependencies.repositories.transactions.recentForCollection(subscription.collectionId, 25);
    const keyboard = feedKeyboard(subscription.id, filter);
    if (!activity.length) {
      await editMessageSafely(ctx, `⚡ ${subscription.name}\n\nNo sends, swaps, or bridges have been detected yet.`, keyboard);
      return;
    }
    const filtered = activity.filter((item) => activityMatchesFilter(item, filter));
    const sends = activity.filter((item) => SEND_TYPES.has(item.activity_type)).length;
    const swaps = activity.filter((item) => item.activity_type === "swap").length;
    const bridges = activity.filter((item) => item.activity_type === "bridge").length;
    const chain = getChainById(subscription.chainId, dependencies.env);
    const lines = filtered.flatMap((item, index) => [
      `${index + 1}. ${formatActivityAction(item, chain.nativeSymbol)}`,
      `   ${relativeTime(item.timestamp)}`,
      "",
    ]);
    const filterLabel: Record<ActivityFilter, string> = {
      all: "All activity",
      send: "Sends",
      swap: "Swaps",
      bridge: "Bridges",
    };
    const body = filtered.length
      ? lines
      : [`No ${filterLabel[filter].toLowerCase()} found in the latest ${activity.length} activities.`];
    await editMessageSafely(
      ctx,
      [
        `⚡ ${subscription.name} Activity`,
        "",
        `📤 Sends: ${sends} • 🔄 Swaps: ${swaps} • 🌉 Bridges: ${bridges}`,
        `Filter: ${filterLabel[filter]}`,
        "",
        ...body,
      ].join("\n").trim(),
      keyboard,
    );
  });
}
