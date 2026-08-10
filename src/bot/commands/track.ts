import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../../config/logger.js";
import { findOpenSeaUrl } from "../../opensea/parseOpenSeaUrl.js";
import type { BotContext, BotDependencies } from "../context.js";
import { formatTrackingResult, replyWithError } from "../helpers.js";

const TRACK_PROMPT = [
  "➕ Add an OpenSea collection",
  "",
  "Send the full collection link, for example:",
  "https://opensea.io/collection/fishbroker",
].join("\n");

async function requestOpenSeaLink(ctx: BotContext): Promise<void> {
  await ctx.reply(TRACK_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "https://opensea.io/collection/...",
    },
  });
}

async function trackUrl(ctx: BotContext, dependencies: BotDependencies, url: string): Promise<void> {
  if (!ctx.from) return;
  const progress = await ctx.reply("🔎 Analyzing collection…");
  try {
    const result = await dependencies.tracking.track(ctx.from.id, url);
    const keyboard = new InlineKeyboard()
      .text("📡 View collections", "menu:list")
      .text("⚡ Activity", "menu:activity")
      .row()
      .text("➕ Add another", "menu:track")
      .text("🏠 Menu", "menu:home");
    await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, formatTrackingResult(result), {
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error({ err: error, telegramId: ctx.from.id }, "tracking request failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

export function registerTrackCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("track", async (ctx) => {
    const url = findOpenSeaUrl(String(ctx.match ?? ""));
    if (!url) {
      await requestOpenSeaLink(ctx);
      return;
    }
    await trackUrl(ctx, dependencies, url);
  });

  bot.callbackQuery("menu:track", async (ctx) => {
    await ctx.answerCallbackQuery();
    await requestOpenSeaLink(ctx);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const url = findOpenSeaUrl(ctx.message.text);
    if (!url) {
      if (ctx.message.reply_to_message?.text === TRACK_PROMPT) {
        await ctx.reply("That doesn't look like an OpenSea collection link. Please send a link beginning with https://opensea.io/collection/.");
        return;
      }
      return next();
    }
    await trackUrl(ctx, dependencies, url);
  });
}
