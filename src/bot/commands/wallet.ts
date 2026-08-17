import { InlineKeyboard, type Bot } from "grammy";
import { isAddress } from "viem";
import { getChains } from "../../blockchain/chains.js";
import type { WalletSubscriptionView } from "../../database/repositories/walletSubscriptions.js";
import { normalizeAddress, shortAddress } from "../../utils/address.js";
import type { BotContext, BotDependencies } from "../context.js";
import { chainLabel, deleteCallbackMessage, deleteReplyPrompt, editMessageSafely, homeKeyboard } from "../ui.js";
import { requirePrivateTrackingChat } from "../chatAccess.js";

export const WALLET_PROMPT = [
  "👛 Track a wallet",
  "",
  "Send an EVM wallet address. Then choose the network(s) to monitor for NFT mints and marketplace buys/sells.",
  "",
  "Example:",
  "0x1234567890abcdef1234567890abcdef12345678",
].join("\n");

export function formatWalletSubscriptions(items: WalletSubscriptionView[]): string {
  if (items.length === 0) {
    return [
      "👛 Tracked wallets",
      "",
      "No direct wallet tracking is active.",
      "",
      "Add a wallet to receive NFT mint and marketplace buy/sell alerts.",
    ].join("\n");
  }
  return [
    `👛 Tracked wallets • ${items.length} active`,
    "",
    ...items.map((item, index) => [
      `${index + 1}. ${shortAddress(item.address)}`,
      `   ${chainLabel(item.chainId, String(item.chainId))} • 🟢 Active`,
    ].join("\n")),
    "",
    "Alerts cover on-chain NFT mints plus NFT transfers inside recognized marketplace settlement transactions.",
  ].join("\n");
}

async function requestWalletAddress(ctx: BotContext): Promise<void> {
  await deleteCallbackMessage(ctx);
  await ctx.reply(WALLET_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "0x…",
    },
  });
}

async function chooseNetworks(ctx: BotContext, rawAddress: string): Promise<void> {
  await deleteReplyPrompt(ctx, WALLET_PROMPT);
  let address;
  try {
    address = normalizeAddress(rawAddress.trim());
  } catch {
    await ctx.reply("❌ That is not a valid EVM wallet address. Please send a 0x address with 40 hexadecimal characters.");
    return;
  }
  if (address === "0x0000000000000000000000000000000000000000") {
    await ctx.reply("❌ The zero address cannot be tracked. Please send a wallet or contract address.");
    return;
  }
  const keyboard = new InlineKeyboard()
    .text("Ethereum", `wallet:add:1:${address}`)
    .text("Robinhood", `wallet:add:4663:${address}`)
    .text("All networks", `wallet:add:all:${address}`)
    .row()
    .text("🏠 Menu", "menu:home");
  await ctx.reply([
    "Choose where to track this wallet:",
    "",
    address,
  ].join("\n"), { reply_markup: keyboard });
}

function walletListKeyboard(items: WalletSubscriptionView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("➕ Add wallet", "menu:wallet-track").row();
  for (const item of items) {
    keyboard.text(`🛑 ${shortAddress(item.address)} • ${chainLabel(item.chainId, String(item.chainId))}`, `wallet:stop:${item.id}`).row();
  }
  return keyboard.text("🔄 Refresh", "menu:wallets").text("🏠 Menu", "menu:home");
}

async function loadWallets(ctx: BotContext, dependencies: BotDependencies): Promise<WalletSubscriptionView[]> {
  if (!ctx.from) return [];
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  return dependencies.repositories.walletSubscriptions.listActive(user.id);
}

export function registerWalletCommands(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("wallet", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    const address = String(ctx.match ?? "").trim();
    if (address) await chooseNetworks(ctx, address);
    else await requestWalletAddress(ctx);
  });

  bot.command("wallets", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    const items = await loadWallets(ctx, dependencies);
    await ctx.reply(formatWalletSubscriptions(items), { reply_markup: walletListKeyboard(items) });
  });

  bot.callbackQuery("menu:wallet-track", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery();
    await requestWalletAddress(ctx);
  });

  bot.callbackQuery("menu:wallets", async (ctx) => {
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery();
    const items = await loadWallets(ctx, dependencies);
    await editMessageSafely(ctx, formatWalletSubscriptions(items), walletListKeyboard(items));
  });

  bot.callbackQuery(/^wallet:add:(all|\d+):(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    if (!ctx.from) return;
    if (!await requirePrivateTrackingChat(ctx)) return;
    await ctx.answerCallbackQuery({ text: "Enabling wallet alerts…" });
    const selection = ctx.match[1]!;
    const address = normalizeAddress(ctx.match[2]!);
    const supported = Object.values(getChains(dependencies.env));
    const chains = selection === "all"
      ? supported
      : supported.filter((chain) => chain.chainId === Number(selection));
    if (chains.length === 0) {
      await deleteCallbackMessage(ctx);
      await ctx.reply("❌ Unsupported network.", { reply_markup: homeKeyboard() });
      return;
    }
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    let newlyEnabled = 0;
    for (const chain of chains) {
      const wallet = await dependencies.repositories.wallets.upsert(chain.chainId, address);
      const result = await dependencies.repositories.walletSubscriptions.subscribe(user.id, wallet.id);
      if (!result.alreadyActive) newlyEnabled += 1;
    }
    const keyboard = new InlineKeyboard()
      .text("👛 View wallets", "menu:wallets")
      .text("➕ Add another", "menu:wallet-track")
      .row()
      .text("🏠 Menu", "menu:home");
    await editMessageSafely(ctx, [
      newlyEnabled ? "✅ Wallet tracking enabled" : "ℹ️ Wallet already tracked",
      "",
      address,
      `Networks: ${chains.map((chain) => chain.name).join(", ")}`,
      "",
      "You’ll receive alerts when this wallet mints an NFT or buys/sells through a recognized marketplace settlement.",
    ].join("\n"), keyboard);
  });

  bot.callbackQuery(/^wallet:stop:([0-9a-f-]{36})$/, async (ctx) => {
    if (!ctx.from) return;
    if (!await requirePrivateTrackingChat(ctx)) return;
    const user = await dependencies.repositories.users.ensure(ctx.from.id);
    const stopped = await dependencies.repositories.walletSubscriptions.deactivate(user.id, ctx.match[1]!);
    await ctx.answerCallbackQuery({ text: stopped ? "Wallet tracking stopped" : "Already stopped" });
    const items = await dependencies.repositories.walletSubscriptions.listActive(user.id);
    await editMessageSafely(ctx, formatWalletSubscriptions(items), walletListKeyboard(items));
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    if (ctx.chat.type !== "private") return next();
    if (ctx.message.reply_to_message?.text !== WALLET_PROMPT && !isAddress(ctx.message.text.trim(), { strict: false })) return next();
    await chooseNetworks(ctx, ctx.message.text);
  });
}
