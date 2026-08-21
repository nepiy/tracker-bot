import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../../config/logger.js";
import { findOpenSeaUrl } from "../../opensea/parseOpenSeaUrl.js";
import { sendCollectionInfo } from "./info.js";
import type { BotContext, BotDependencies } from "../context.js";
import { formatTrackingResult, replyWithError } from "../helpers.js";
import { isGroupChat, requireGroupAdmin } from "../groupAdmin.js";
import { deleteCallbackMessage, deleteReplyPrompt } from "../ui.js";
import { UserFacingError } from "../../utils/errors.js";

export const TRACK_PROMPT = [
  "➕ Add an OpenSea collection",
  "",
  "Send the full collection link",
].join("\n");

export const GROUP_TRACK_PROMPT = [
  "👥 Add a collection to this group",
  "",
  "Only group admins can manage group tracking.",
  "Send the full collection link",
].join("\n");

export async function requestOpenSeaLink(ctx: BotContext): Promise<void> {
  await deleteCallbackMessage(ctx);
  const group = isGroupChat(ctx);
  await ctx.reply(group ? GROUP_TRACK_PROMPT : TRACK_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "https://opensea.io/collection/...",
    },
  });
}

async function trackUrl(
  ctx: BotContext,
  dependencies: BotDependencies,
  url: string,
  allowResearchFallback = false,
): Promise<void> {
  if (!ctx.from) return;
  const group = isGroupChat(ctx);
  if (group && !await requireGroupAdmin(ctx)) return;
  await deleteReplyPrompt(ctx, group ? GROUP_TRACK_PROMPT : TRACK_PROMPT);
  const progress = await ctx.reply("🔎 Analyzing collection…");
  try {
    const result = group
      ? await dependencies.tracking.trackGroup(ctx.chat!.id, url)
      : await dependencies.tracking.track(ctx.from.id, url);
    if (group) {
      const keyboard = new InlineKeyboard()
        .text("👥 Group collections", "group:list")
        .text("➕ Add another", "group:track");
      await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, [
        result.alreadyActive ? "ℹ️ This group is already tracking the collection." : "✅ Group tracking enabled",
        "",
        formatTrackingResult(result),
        "",
        "Only group admins can change group tracking.",
      ].join("\n"), { reply_markup: keyboard });
      return;
    }
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
    if (allowResearchFallback && !group
      && error instanceof UserFacingError
      && error.code === "UNSUPPORTED_TRACKING_CHAIN") {
      await sendCollectionInfo(ctx, dependencies, url, progress.message_id);
      return;
    }
    logger.error({ err: error, telegramId: ctx.from.id, chatId: ctx.chat?.id }, "tracking request failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

export function registerTrackCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  const handleTrackCommand = async (ctx: BotContext): Promise<void> => {
    if (isGroupChat(ctx) && !await requireGroupAdmin(ctx)) return;
    const url = findOpenSeaUrl(String(ctx.match ?? ""));
    if (!url) {
      await requestOpenSeaLink(ctx);
      return;
    }
    await trackUrl(ctx, dependencies, url);
  };
  bot.command("track", handleTrackCommand);
  bot.command("grouptrack", async (ctx) => {
    if (!isGroupChat(ctx)) {
      await ctx.reply("Use /grouptrack inside a Telegram group, or /track in a private chat.");
      return;
    }
    await handleTrackCommand(ctx);
  });

  bot.callbackQuery("menu:track", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isGroupChat(ctx) && !await requireGroupAdmin(ctx)) return;
    await requestOpenSeaLink(ctx);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const url = findOpenSeaUrl(ctx.message.text);
    if (!url) {
      if (ctx.message.reply_to_message?.text === TRACK_PROMPT || ctx.message.reply_to_message?.text === GROUP_TRACK_PROMPT) {
        if (isGroupChat(ctx) && !await requireGroupAdmin(ctx)) return;
        await deleteReplyPrompt(ctx, ctx.message.reply_to_message.text);
        await ctx.reply("That doesn't look like an OpenSea collection link. Please send a link beginning with https://opensea.io/collection/.");
        return;
      }
      return next();
    }
    await trackUrl(ctx, dependencies, url, true);
  });
}
