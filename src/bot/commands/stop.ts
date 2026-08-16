import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext, BotDependencies } from "../context.js";
import type { SubscriptionView } from "../../database/repositories/subscriptions.js";
import { editMessageSafely } from "../ui.js";
import { requirePrivateTrackingChat } from "../chatAccess.js";

function stopKeyboard(subscriptions: SubscriptionView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const subscription of subscriptions) {
    keyboard.text(`🛑 ${subscription.name}`, `stop:${subscription.id}`).row();
  }
  return keyboard
    .text("← Collections", "menu:list")
    .text("🏠 Menu", "menu:home");
}

async function loadSubscriptions(ctx: BotContext, dependencies: BotDependencies): Promise<SubscriptionView[]> {
  if (!ctx.from) return [];
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  return dependencies.repositories.subscriptions.listActive(user.id);
}

async function showStopMenu(ctx: BotContext, dependencies: BotDependencies, edit: boolean): Promise<void> {
  const subscriptions = await loadSubscriptions(ctx, dependencies);
  const text = subscriptions.length
    ? "🛑 Stop tracking\n\nChoose a collection to stop receiving alerts for it."
    : "🛑 Stop tracking\n\nYou don't have any active subscriptions.";
  const keyboard = stopKeyboard(subscriptions);
  if (edit) {
    await editMessageSafely(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function registerStopCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("stop", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    await showStopMenu(ctx, dependencies, false);
  });

  bot.callbackQuery("menu:stop", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery();
    await showStopMenu(ctx, dependencies, true);
  });

  bot.callbackQuery(/^stop:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!ctx.from) return;
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery();
    const subscriptionId = ctx.match[1];
    if (!subscriptionId) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const stopped = await dependencies.repositories.subscriptions.deactivate(user.id, subscriptionId);
    const keyboard = new InlineKeyboard()
      .text("📡 Collections", "menu:list")
      .text("🏠 Menu", "menu:home");
    await editMessageSafely(
      ctx,
      stopped ? "✅ Tracking stopped for this collection." : "This subscription is no longer active.",
      keyboard,
    );
  });
}
