import { InlineKeyboard, type Bot } from "grammy";
import { isTrackingChainId, ROBINHOOD_CHAIN_ID } from "../../blockchain/chains.js";
import type { CollectionSaleSubscriptionView } from "../../database/repositories/collectionSaleSubscriptions.js";
import { resolveOpenSeaCollection } from "../../opensea/resolveCollection.js";
import { findOpenSeaUrl } from "../../opensea/parseOpenSeaUrl.js";
import { UserFacingError } from "../../utils/errors.js";
import type { BotContext, BotDependencies } from "../context.js";
import { deleteCallbackMessage, deleteReplyPrompt, editMessageSafely, homeKeyboard } from "../ui.js";
import { replyWithError } from "../helpers.js";
import { requirePrivateTrackingChat } from "../chatAccess.js";

export const SALE_ALERT_PROMPT = [
  "🛒 Track collection sales",
  "",
  "Send the full OpenSea collection link.",
  "",
  "You’ll receive a detailed alert when an NFT from that collection sells on Robinhood Chain.",
].join("\n");

export function formatSaleAlerts(items: CollectionSaleSubscriptionView[]): string {
  if (items.length === 0) {
    return [
      "🛒 Collection sale alerts",
      "",
      "No collection sale alerts are active.",
      "",
      "Add a collection to receive the NFT name, seller, buyer, marketplace, price, and transaction link when it sells.",
    ].join("\n");
  }
  return [
    `🛒 Collection sale alerts • ${items.length} active`,
    "",
    ...items.map((item, index) => [
      `${index + 1}. ${item.name}`,
      `   Robinhood Chain • 🟢 Active`,
      `   https://opensea.io/collection/${item.slug}`,
    ].join("\n")),
  ].join("\n\n");
}

function saleAlertsKeyboard(items: CollectionSaleSubscriptionView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("➕ Add collection", "menu:sale-alert-add").row();
  for (const item of items) {
    keyboard.text(`🛑 ${item.name}`, `sale:stop:${item.id}`).row();
  }
  return keyboard.text("🔄 Refresh", "menu:sale-alerts").text("🏠 Menu", "menu:home");
}

async function loadSaleAlerts(ctx: BotContext, dependencies: BotDependencies): Promise<CollectionSaleSubscriptionView[]> {
  if (!ctx.from) return [];
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  return dependencies.repositories.collectionSaleSubscriptions.listActive(user.id);
}

async function requestSaleLink(ctx: BotContext): Promise<void> {
  await deleteCallbackMessage(ctx);
  await ctx.reply(SALE_ALERT_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "https://opensea.io/collection/...",
    },
  });
}

async function addSaleAlert(ctx: BotContext, dependencies: BotDependencies, url: string): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  await deleteReplyPrompt(ctx, SALE_ALERT_PROMPT);
  const progress = await ctx.reply("🔎 Checking the collection…");
  try {
    const collection = await resolveOpenSeaCollection(url, dependencies.env, fetch, [ROBINHOOD_CHAIN_ID]);
    if (!isTrackingChainId(collection.chainId)) {
      throw new UserFacingError(
        "Collection sale alerts are currently available only for collections on Robinhood Chain.",
        "UNSUPPORTED_TRACKING_CHAIN",
      );
    }
    const stored = await dependencies.repositories.collections.upsert(collection);
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const result = await dependencies.repositories.collectionSaleSubscriptions.subscribe(user.id, stored.id);
    const keyboard = new InlineKeyboard()
      .text("🛒 View sale alerts", "menu:sale-alerts")
      .text("➕ Add another", "menu:sale-alert-add")
      .row()
      .text("🏠 Menu", "menu:home");
    await ctx.api.editMessageText(ctx.chat.id, progress.message_id, [
      result.alreadyActive ? "ℹ️ Sale alerts are already active" : "✅ Collection sale alerts enabled",
      "",
      `Collection: ${stored.name}`,
      "Chain: Robinhood Chain",
      "",
      "You’ll receive one detailed alert for each detected NFT sale.",
    ].join("\n"), { reply_markup: keyboard });
  } catch (error) {
    await ctx.api.deleteMessage(ctx.chat.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

export function registerCollectionSaleCommands(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("sales", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    const url = findOpenSeaUrl(String(ctx.match ?? ""));
    if (url) await addSaleAlert(ctx, dependencies, url);
    else await requestSaleLink(ctx);
  });

  bot.callbackQuery("menu:sale-alerts", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery();
    const items = await loadSaleAlerts(ctx, dependencies);
    await editMessageSafely(ctx, formatSaleAlerts(items), saleAlertsKeyboard(items));
  });

  bot.callbackQuery("menu:sale-alert-add", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery();
    await requestSaleLink(ctx);
  });

  bot.callbackQuery(/^sale:stop:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!ctx.from) return;
    if (!await requirePrivateTrackingChat(ctx)) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const stopped = await dependencies.repositories.collectionSaleSubscriptions.deactivate(user.id, ctx.match[1]!);
    await ctx.answerCallbackQuery({ text: stopped ? "Sale alerts stopped" : "Already stopped" });
    const items = await dependencies.repositories.collectionSaleSubscriptions.listActive(user.id);
    await editMessageSafely(ctx, formatSaleAlerts(items), saleAlertsKeyboard(items));
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    if (ctx.chat.type !== "private") return next();
    if (ctx.message.reply_to_message?.text !== SALE_ALERT_PROMPT) return next();
    const url = findOpenSeaUrl(ctx.message.text);
    if (!url) {
      await deleteReplyPrompt(ctx, SALE_ALERT_PROMPT);
      await ctx.reply("That doesn't look like an OpenSea collection link. Please send a link beginning with https://opensea.io/collection/.", { reply_markup: homeKeyboard() });
      return;
    }
    await addSaleAlert(ctx, dependencies, url);
  });
}
