import type { Bot } from "grammy";
import type { BotContext } from "../context.js";
import { editMessageSafely, HELP_TEXT, homeKeyboard, MAIN_MENU_TEXT, mainMenuKeyboard } from "../ui.js";

export function registerStartCommands(bot: Bot<BotContext>): void {
  bot.command("start", (ctx) => ctx.reply(MAIN_MENU_TEXT, { reply_markup: mainMenuKeyboard() }));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT, { reply_markup: homeKeyboard() }));

  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editMessageSafely(ctx, MAIN_MENU_TEXT, mainMenuKeyboard());
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editMessageSafely(ctx, HELP_TEXT, homeKeyboard());
  });
}
