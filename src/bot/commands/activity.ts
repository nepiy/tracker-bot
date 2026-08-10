import { InlineKeyboard, type Bot } from "grammy";
import { formatEther } from "viem";
import type { BotContext, BotDependencies } from "../context.js";
import { shortAddress } from "../../utils/address.js";

function relativeTime(timestamp: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function registerActivityCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("activity", async (ctx) => {
    if (!ctx.from) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const subscriptions = await dependencies.repositories.subscriptions.listActive(user.id);
    if (!subscriptions.length) {
      await ctx.reply("Track a collection before viewing activity.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const subscription of subscriptions) {
      keyboard.text(subscription.name, `activity:${subscription.id}`).row();
    }
    await ctx.reply("Choose a tracked collection:", { reply_markup: keyboard });
  });

  bot.callbackQuery(/^activity:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!ctx.from) return;
    const subscriptionId = ctx.match[1];
    if (!subscriptionId) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const subscriptions = await dependencies.repositories.subscriptions.listActive(user.id);
    const subscription = subscriptions.find((item) => item.id === subscriptionId);
    if (!subscription) {
      await ctx.answerCallbackQuery("Subscription not found");
      return;
    }
    const activity = await dependencies.repositories.transactions.recentForCollection(subscription.collectionId);
    await ctx.answerCallbackQuery();
    if (!activity.length) {
      await ctx.editMessageText(`📡 ${subscription.name}\n\nNo outgoing activity has been detected yet.`);
      return;
    }
    const lines = activity.flatMap((item, index) => {
      const action = item.activity_type === "native_transfer"
        ? `${formatEther(BigInt(item.value))} ETH → ${item.to_address ? shortAddress(item.to_address) : "contract creation"}`
        : `${String(item.metadata.label ?? item.activity_type)} → ${item.to_address ? shortAddress(item.to_address) : "contract creation"}`;
      return [`${index + 1}. ${action}`, `   ${relativeTime(item.timestamp)}`, ""];
    });
    await ctx.editMessageText([`📡 ${subscription.name}`, "", "Recent Dev Activity", "", ...lines].join("\n").trim());
  });
}
