import { InlineKeyboard, type Bot } from "grammy";
import type { BotContext, BotDependencies } from "../context.js";
import { editMessageSafely } from "../ui.js";

export function formatSettings(freeMintAlertsEnabled: boolean): string {
  return [
    "⚙️ Notification settings",
    "",
    `OpenSea free mint alerts: ${freeMintAlertsEnabled ? "🟢 ON" : "⚪ OFF"}`,
    "",
    "When enabled, the bot sends one alert for each public, zero-price OpenSea mint stage starting within the next 12 hours.",
    "If an announced free stage changes to a paid price, you also receive a price-change warning.",
    "Times are shown in GMT. Network gas is not included in the mint price.",
    "",
    "This is a personal setting and is off by default.",
  ].join("\n");
}

function settingsKeyboard(enabled: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(enabled ? "🔕 Turn free mint alerts off" : "🔔 Turn free mint alerts on", "settings:free-mints:toggle")
    .row()
    .text("🆓 Browse free mints", "menu:free-mints")
    .row()
    .text("🔄 Refresh", "menu:settings")
    .text("🏠 Main menu", "menu:home");
}

async function showSettings(
  ctx: BotContext,
  dependencies: BotDependencies,
  edit: boolean,
): Promise<void> {
  if (!ctx.from) return;
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  const text = formatSettings(user.free_mint_alerts_enabled);
  const keyboard = settingsKeyboard(user.free_mint_alerts_enabled);
  if (edit) await editMessageSafely(ctx, text, keyboard);
  else await ctx.reply(text, { reply_markup: keyboard });
}

export function registerSettingsCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("settings", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Open a private chat with me to change your personal notification settings.");
      return;
    }
    await showSettings(ctx, dependencies, false);
  });

  bot.callbackQuery("menu:settings", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({
        text: "Open a private chat with me to change personal settings.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await showSettings(ctx, dependencies, true);
  });

  bot.callbackQuery("settings:free-mints:toggle", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({
        text: "Open a private chat with me to change personal settings.",
        show_alert: true,
      });
      return;
    }
    if (!ctx.from) return;
    const current = await dependencies.repositories.users.ensure(ctx.from.id);
    const updated = await dependencies.repositories.users.setFreeMintAlerts(
      ctx.from.id,
      !current.free_mint_alerts_enabled,
    );
    await ctx.answerCallbackQuery({
      text: updated.free_mint_alerts_enabled ? "Free mint alerts enabled" : "Free mint alerts disabled",
    });
    await editMessageSafely(
      ctx,
      formatSettings(updated.free_mint_alerts_enabled),
      settingsKeyboard(updated.free_mint_alerts_enabled),
    );
  });
}
