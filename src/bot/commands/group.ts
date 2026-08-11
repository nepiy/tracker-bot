import { InlineKeyboard, type Bot } from "grammy";
import type { GroupSubscriptionView } from "../../database/repositories/groupSubscriptions.js";
import { shortAddress } from "../../utils/address.js";
import type { BotContext, BotDependencies } from "../context.js";
import { requireGroupAdmin } from "../groupAdmin.js";
import { chainLabel, editMessageSafely } from "../ui.js";

export function formatGroupSubscriptions(subscriptions: GroupSubscriptionView[]): string {
  if (!subscriptions.length) {
    return [
      "👥 Group tracking",
      "",
      "This group has no active collection alerts.",
      "",
      "An admin can use /track <OpenSea URL> to add one.",
    ].join("\n");
  }
  return [
    "👥 Group tracking",
    "",
    `${subscriptions.length} active ${subscriptions.length === 1 ? "collection" : "collections"}`,
    "",
    ...subscriptions.flatMap((subscription, index) => [
      `${index + 1}. ${subscription.name}`,
      `   ${chainLabel(subscription.chainId, subscription.chain)} • ${subscription.walletAddress ? shortAddress(subscription.walletAddress) : "Wallet analyzing"}`,
    ]),
    "",
    "Only group admins can change these alerts.",
  ].join("\n");
}

function groupKeyboard(subscriptions: GroupSubscriptionView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("➕ Add collection", "group:track").row();
  for (const subscription of subscriptions) {
    keyboard.text(`🛑 Stop ${subscription.name}`, `group:stop:${subscription.id}`).row();
  }
  return keyboard.text("🔄 Refresh", "group:list");
}

async function loadGroupSubscriptions(ctx: BotContext, dependencies: BotDependencies): Promise<GroupSubscriptionView[]> {
  if (!ctx.chat) return [];
  return dependencies.repositories.groupSubscriptions.listActive(ctx.chat.id);
}

export async function showGroupSubscriptions(
  ctx: BotContext,
  dependencies: BotDependencies,
  edit: boolean,
): Promise<void> {
  const subscriptions = await loadGroupSubscriptions(ctx, dependencies);
  const text = formatGroupSubscriptions(subscriptions);
  const keyboard = groupKeyboard(subscriptions);
  if (edit) await editMessageSafely(ctx, text, keyboard);
  else await ctx.reply(text, { reply_markup: keyboard });
}

export function registerGroupCommands(
  bot: Bot<BotContext>,
  dependencies: BotDependencies,
  requestGroupTrack: (ctx: BotContext) => Promise<void>,
): void {
  bot.command("grouplist", async (ctx) => {
    if (!await requireGroupAdmin(ctx)) return;
    await showGroupSubscriptions(ctx, dependencies, false);
  });

  bot.callbackQuery("group:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!await requireGroupAdmin(ctx)) return;
    await showGroupSubscriptions(ctx, dependencies, true);
  });

  bot.callbackQuery("group:track", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!await requireGroupAdmin(ctx)) return;
    await requestGroupTrack(ctx);
  });

  bot.callbackQuery(/^group:stop:([0-9a-f-]{36})$/i, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat || !await requireGroupAdmin(ctx)) return;
    const subscriptionId = ctx.match[1];
    if (!subscriptionId) return;
    await dependencies.repositories.groupSubscriptions.deactivate(ctx.chat.id, subscriptionId);
    await showGroupSubscriptions(ctx, dependencies, true);
  });
}
