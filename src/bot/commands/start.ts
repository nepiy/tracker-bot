import type { Bot } from "grammy";
import type { BotContext } from "../context.js";

const HELP_TEXT = [
  "Track outgoing activity from an NFT collection's likely dev/team wallet.",
  "",
  "Paste an OpenSea collection URL to begin:",
  "https://opensea.io/collection/fishbroker",
  "",
  "Commands:",
  "/track <OpenSea URL> — start tracking",
  "/list — show tracked collections",
  "/stop — stop a subscription",
  "/activity — recent outgoing activity",
  "/help — show this help",
  "",
  "Wallet ownership is inferred from on-chain evidence and is never presented as a verified real-world identity.",
].join("\n");

export function registerStartCommands(bot: Bot<BotContext>): void {
  bot.command("start", (ctx) => ctx.reply(`👋 Welcome!\n\n${HELP_TEXT}`));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));
}
