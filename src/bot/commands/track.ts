import type { Bot } from "grammy";
import { logger } from "../../config/logger.js";
import { findOpenSeaUrl } from "../../opensea/parseOpenSeaUrl.js";
import type { BotContext, BotDependencies } from "../context.js";
import { formatTrackingResult, replyWithError } from "../helpers.js";

async function trackUrl(ctx: BotContext, dependencies: BotDependencies, url: string): Promise<void> {
  if (!ctx.from) return;
  const progress = await ctx.reply("🔎 Analyzing collection…");
  try {
    const result = await dependencies.tracking.track(ctx.from.id, url);
    await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, formatTrackingResult(result));
  } catch (error) {
    logger.error({ error, telegramId: ctx.from.id }, "tracking request failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

export function registerTrackCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("track", async (ctx) => {
    const url = findOpenSeaUrl(String(ctx.match ?? ""));
    if (!url) {
      await ctx.reply("Send /track followed by an OpenSea collection URL.");
      return;
    }
    await trackUrl(ctx, dependencies, url);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const url = findOpenSeaUrl(ctx.message.text);
    if (!url) return next();
    await trackUrl(ctx, dependencies, url);
  });
}
