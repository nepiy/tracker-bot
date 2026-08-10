import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext, BotDependencies } from "../context.js";

export function registerStopCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("stop", async (ctx) => {
    if (!ctx.from) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const subscriptions = await dependencies.repositories.subscriptions.listActive(user.id);
    if (!subscriptions.length) {
      await ctx.reply("You don't have any active subscriptions.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const subscription of subscriptions) {
      keyboard.text(`${subscription.name} ❌`, `stop:${subscription.id}`).row();
    }
    await ctx.reply("Stop tracking:", { reply_markup: keyboard });
  });

  bot.callbackQuery(/^stop:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!ctx.from) return;
    const subscriptionId = ctx.match[1];
    if (!subscriptionId) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const stopped = await dependencies.repositories.subscriptions.deactivate(user.id, subscriptionId);
    await ctx.answerCallbackQuery(stopped ? "Tracking stopped" : "Subscription is already inactive");
    await ctx.editMessageText(stopped ? "✅ Tracking stopped for this collection." : "This subscription is no longer active.");
  });
}
