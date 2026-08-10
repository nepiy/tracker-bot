import type { Bot } from "grammy";
import type { BotContext, BotDependencies } from "../context.js";
import { shortAddress } from "../../utils/address.js";

export function registerListCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("list", async (ctx) => {
    if (!ctx.from) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const subscriptions = await dependencies.repositories.subscriptions.listActive(user.id);
    if (!subscriptions.length) {
      await ctx.reply("You aren't tracking any collections yet.");
      return;
    }
    const lines = subscriptions.flatMap((subscription, index) => [
      `${index + 1}. ${subscription.name}`,
      `   Dev/Tracked: ${subscription.walletAddress ? shortAddress(subscription.walletAddress) : "unavailable"}`,
      "   🟢 Active",
      "",
    ]);
    await ctx.reply(["📡 Tracked Collections", "", ...lines].join("\n").trim());
  });
}
