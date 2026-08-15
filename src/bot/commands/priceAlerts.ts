import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../../config/logger.js";
import type {
  NftPriceAlertDirection,
  NftPriceAlertView,
} from "../../database/repositories/nftPriceAlerts.js";
import { getCollectionInfo } from "../../opensea/collectionInfo.js";
import { compactDecimal, formatTokenWithUsd } from "../../utils/price.js";
import type { BotContext, BotDependencies } from "../context.js";
import { replyWithError } from "../helpers.js";
import { editMessageSafely, homeKeyboard } from "../ui.js";

export const PRICE_ALERT_COLLECTION_PROMPT = [
  "🎯 Create an NFT floor-price alert",
  "",
  "Send either:",
  "• an OpenSea collection link",
  "• an Ethereum or Robinhood NFT contract",
  "",
  "The alert is personal, triggers once, and expires after delivery.",
].join("\n");

const TARGET_PROMPT_PREFIX = "🎯 Choose your floor-price target";

function privateChatOnly(ctx: BotContext): boolean {
  return ctx.chat?.type === "private";
}

export function parseNftTargetPrice(input: string): string | null {
  const raw = input.trim().split(/\s+/)[0] ?? "";
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const [rawWhole = "0", rawFraction = ""] = raw.split(".");
  if (rawFraction.length > 18) return null;
  const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  if (whole.length > 20) return null;
  const fraction = rawFraction.replace(/0+$/, "");
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? normalized : null;
}

function directionText(direction: NftPriceAlertDirection): string {
  return direction === "at_or_below" ? "falls to or below" : "rises to or above";
}

export function alertListKeyboard(alerts: NftPriceAlertView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("➕ Add price alert", "menu:price-alert-add").row();
  for (const alert of alerts) {
    keyboard
      .text(`⚙️ ${alert.collectionName} • ${compactDecimal(alert.targetPrice)} ${alert.currencySymbol}`, `price-alert:manage:${alert.id}`)
      .row();
  }
  return keyboard.text("🔄 Refresh", "menu:price-alerts").text("🏠 Menu", "menu:home");
}

export function formatNftPriceAlerts(alerts: NftPriceAlertView[]): string {
  if (!alerts.length) {
    return [
      "🎯 NFT floor-price alerts",
      "",
      "No active price targets.",
      "",
      "Add a collection and target price. The bot sends one notification when the floor crosses that target, then expires it.",
    ].join("\n");
  }
  return [
    `🎯 NFT floor-price alerts • ${alerts.length} active or pending`,
    "",
    ...alerts.flatMap((alert, index) => [
      `${index + 1}. ${alert.collectionName}`,
      `   Alert when floor ${directionText(alert.direction)} ${formatTokenWithUsd(alert.targetPrice, alert.currencySymbol, alert.usdRate)}`,
      `   Last floor: ${formatTokenWithUsd(alert.lastFloorPrice ?? alert.initialFloorPrice, alert.currencySymbol, alert.usdRate)}`,
      `   Status: ${alert.status === "sending" ? "🟡 Delivering notification" : "🟢 Watching"}`,
      `   https://opensea.io/collection/${alert.slug}`,
      "",
    ]),
    "Each target sends once and expires after successful delivery.",
  ].join("\n");
}

export function formatNftPriceAlertDetails(alert: NftPriceAlertView, confirmCancel = false): string {
  return [
    confirmCancel ? "⚠️ CANCEL FLOOR-PRICE ALERT?" : "🎯 FLOOR-PRICE ALERT DETAILS",
    "",
    `Collection: ${alert.collectionName}`,
    `Condition: Floor ${directionText(alert.direction)} ${formatTokenWithUsd(alert.targetPrice, alert.currencySymbol, alert.usdRate)}`,
    `Initial floor: ${formatTokenWithUsd(alert.initialFloorPrice, alert.currencySymbol, alert.usdRate)}`,
    `Last checked floor: ${formatTokenWithUsd(alert.lastFloorPrice ?? alert.initialFloorPrice, alert.currencySymbol, alert.usdRate)}`,
    `Status: ${alert.status === "sending" ? "🟡 Delivering notification" : "🟢 Watching"}`,
    "",
    `https://opensea.io/collection/${alert.slug}`,
    ...(confirmCancel ? ["", "This removes the target without sending a notification. This cannot be undone."] : []),
  ].join("\n");
}

function alertDetailsKeyboard(alert: NftPriceAlertView, confirmCancel = false): InlineKeyboard {
  if (confirmCancel) {
    return new InlineKeyboard()
      .text("✅ Yes, cancel alert", `price-alert:confirm-cancel:${alert.id}`)
      .row()
      .text("↩️ Keep alert", `price-alert:manage:${alert.id}`);
  }
  const keyboard = new InlineKeyboard();
  if (alert.status === "active") keyboard.text("🗑 Cancel Alert", `price-alert:cancel:${alert.id}`).row();
  return keyboard.text("⬅️ All Alerts", "menu:price-alerts").text("🏠 Menu", "menu:home");
}

function targetPrompt(
  name: string,
  slug: string,
  floorPrice: number,
  symbol: string,
  usdRate: string | null,
): string {
  return [
    TARGET_PROMPT_PREFIX,
    "",
    `Collection: ${name}`,
    `Collection slug: ${slug}`,
    `Current floor: ${formatTokenWithUsd(floorPrice, symbol, usdRate)}`,
    "",
    `Reply with a target price in ${symbol}, for example: 0.01`,
    "",
    "• A lower target alerts when the floor falls to or below it.",
    "• A higher target alerts when the floor rises to or above it.",
    "• The alert triggers once, then expires.",
  ].join("\n");
}

function slugFromTargetPrompt(text: string | undefined): string | null {
  if (!text?.startsWith(TARGET_PROMPT_PREFIX)) return null;
  return text.match(/^Collection slug: ([a-z0-9][a-z0-9-]{0,199})$/m)?.[1] ?? null;
}

async function requestCollection(ctx: BotContext): Promise<void> {
  if (!privateChatOnly(ctx)) {
    await ctx.reply("Open a private chat with me to create a personal NFT price alert.");
    return;
  }
  await ctx.reply(PRICE_ALERT_COLLECTION_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "OpenSea URL or 0x contract",
    },
  });
}

async function requestTarget(
  ctx: BotContext,
  dependencies: BotDependencies,
  collectionInput: string,
): Promise<void> {
  if (!privateChatOnly(ctx)) return;
  const progress = await ctx.reply("🔎 Reading the current OpenSea floor…");
  try {
    const info = await getCollectionInfo(collectionInput, dependencies.env.OPENSEA_API_KEY);
    if (info.floorPrice === null || info.floorPrice <= 0 || !info.floorPriceSymbol) {
      await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
      await ctx.reply("❌ OpenSea does not currently report an active floor price for that collection.", {
        reply_markup: homeKeyboard(),
      });
      return;
    }
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await ctx.reply(targetPrompt(
      info.name,
      info.slug,
      info.floorPrice,
      info.floorPriceSymbol,
      info.floorPriceUsdRate,
    ), {
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: `Target in ${info.floorPriceSymbol}`,
      },
    });
  } catch (error) {
    logger.error({ err: error, telegramId: ctx.from?.id }, "NFT price alert collection lookup failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

async function createTarget(
  ctx: BotContext,
  dependencies: BotDependencies,
  slug: string,
  rawTarget: string,
): Promise<void> {
  if (!ctx.from || !privateChatOnly(ctx)) return;
  const targetPrice = parseNftTargetPrice(rawTarget);
  if (!targetPrice) {
    await ctx.reply("❌ Send a positive price with no more than 18 decimal places, for example: 0.01");
    return;
  }

  const progress = await ctx.reply("🎯 Creating your one-time price alert…");
  try {
    const info = await getCollectionInfo(
      `https://opensea.io/collection/${slug}`,
      dependencies.env.OPENSEA_API_KEY,
    );
    if (info.floorPrice === null || info.floorPrice <= 0 || !info.floorPriceSymbol) {
      await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
      await ctx.reply("❌ OpenSea no longer reports an active floor price for that collection.");
      return;
    }
    const target = Number(targetPrice);
    if (target === info.floorPrice) {
      await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
      await ctx.reply("❌ That target already equals the current floor. Choose a lower or higher price.");
      return;
    }
    const direction: NftPriceAlertDirection = target < info.floorPrice ? "at_or_below" : "at_or_above";
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const alert = await dependencies.repositories.nftPriceAlerts.create({
      userId: user.id,
      slug: info.slug,
      collectionName: info.name,
      chain: info.chain,
      contractAddress: info.contractAddress,
      targetPrice,
      initialFloorPrice: String(info.floorPrice),
      currencySymbol: info.floorPriceSymbol,
      currencyAddress: info.floorPriceCurrencyAddress,
      usdRate: info.floorPriceUsdRate,
      direction,
    });
    const keyboard = new InlineKeyboard()
      .text("🎯 View alerts", "menu:price-alerts")
      .text("➕ Add another", "menu:price-alert-add")
      .row()
      .text("🏠 Menu", "menu:home");
    const message = alert
      ? [
        "✅ One-time NFT price alert created",
        "",
        `Collection: ${info.name}`,
        `Current floor: ${formatTokenWithUsd(info.floorPrice, info.floorPriceSymbol, info.floorPriceUsdRate)}`,
        `Target: ${formatTokenWithUsd(targetPrice, info.floorPriceSymbol, info.floorPriceUsdRate)}`,
        `Trigger: Floor ${directionText(direction)} the target`,
        "",
        "After the notification is delivered, this target expires automatically.",
      ].join("\n")
      : "ℹ️ You already have this active price target.";
    await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, message, { reply_markup: keyboard });
  } catch (error) {
    logger.error({ err: error, telegramId: ctx.from.id, slug }, "create NFT price alert failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

async function loadAlerts(
  ctx: BotContext,
  dependencies: BotDependencies,
): Promise<NftPriceAlertView[]> {
  if (!ctx.from) return [];
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  return dependencies.repositories.nftPriceAlerts.listActive(user.id);
}

export function registerNftPriceAlertCommands(
  bot: Bot<BotContext>,
  dependencies: BotDependencies,
): void {
  bot.command("pricealert", async (ctx) => {
    if (!privateChatOnly(ctx)) {
      await ctx.reply("Open a private chat with me to create a personal NFT price alert.");
      return;
    }
    const input = String(ctx.match ?? "").trim();
    if (input) await requestTarget(ctx, dependencies, input);
    else await requestCollection(ctx);
  });

  bot.command("pricealerts", async (ctx) => {
    if (!privateChatOnly(ctx)) {
      await ctx.reply("Open a private chat with me to manage personal NFT price alerts.");
      return;
    }
    const alerts = await loadAlerts(ctx, dependencies);
    await ctx.reply(formatNftPriceAlerts(alerts), { reply_markup: alertListKeyboard(alerts) });
  });

  bot.callbackQuery("menu:price-alert-add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await requestCollection(ctx);
  });

  bot.callbackQuery("menu:price-alerts", async (ctx) => {
    if (!privateChatOnly(ctx)) {
      await ctx.answerCallbackQuery({ text: "Open a private chat to manage personal alerts.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const alerts = await loadAlerts(ctx, dependencies);
    await editMessageSafely(ctx, formatNftPriceAlerts(alerts), alertListKeyboard(alerts));
  });

  const loadOwnedAlert = async (ctx: BotContext, alertId: string): Promise<NftPriceAlertView | null> => {
    if (!ctx.from) return null;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const alerts = await dependencies.repositories.nftPriceAlerts.listActive(user.id);
    return alerts.find((alert) => alert.id === alertId) ?? null;
  };

  bot.callbackQuery(/^price-alert:manage:([0-9a-f-]{36})$/, async (ctx) => {
    if (!privateChatOnly(ctx)) return;
    await ctx.answerCallbackQuery();
    const alert = await loadOwnedAlert(ctx, ctx.match[1]!);
    if (!alert) {
      const alerts = await loadAlerts(ctx, dependencies);
      await editMessageSafely(ctx, formatNftPriceAlerts(alerts), alertListKeyboard(alerts));
      return;
    }
    await editMessageSafely(ctx, formatNftPriceAlertDetails(alert), alertDetailsKeyboard(alert));
  });

  bot.callbackQuery(/^price-alert:cancel:([0-9a-f-]{36})$/, async (ctx) => {
    if (!privateChatOnly(ctx)) return;
    await ctx.answerCallbackQuery();
    const alert = await loadOwnedAlert(ctx, ctx.match[1]!);
    if (!alert || alert.status !== "active") {
      const alerts = await loadAlerts(ctx, dependencies);
      await editMessageSafely(ctx, formatNftPriceAlerts(alerts), alertListKeyboard(alerts));
      return;
    }
    await editMessageSafely(ctx, formatNftPriceAlertDetails(alert, true), alertDetailsKeyboard(alert, true));
  });

  bot.callbackQuery(/^price-alert:confirm-cancel:([0-9a-f-]{36})$/, async (ctx) => {
    if (!ctx.from || !privateChatOnly(ctx)) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const cancelled = await dependencies.repositories.nftPriceAlerts.cancel(user.id, ctx.match[1]!);
    await ctx.answerCallbackQuery({ text: cancelled ? "Price alert cancelled" : "Alert already expired or cancelled" });
    const alerts = await dependencies.repositories.nftPriceAlerts.listActive(user.id);
    await editMessageSafely(ctx, formatNftPriceAlerts(alerts), alertListKeyboard(alerts));
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    if (ctx.message.reply_to_message?.text === PRICE_ALERT_COLLECTION_PROMPT) {
      await requestTarget(ctx, dependencies, ctx.message.text);
      return;
    }
    const slug = slugFromTargetPrompt(ctx.message.reply_to_message?.text);
    if (!slug) return next();
    await createTarget(ctx, dependencies, slug, ctx.message.text);
  });
}
