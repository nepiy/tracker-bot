import { InlineKeyboard } from "grammy";
import type { BotContext } from "./context.js";

export const MAIN_MENU_TEXT = [
  "🛰 NFT Dev Wallet Tracker",
  "",
  "Track NFT collection team wallets, or monitor any wallet for NFT marketplace buys and sells.",
  "",
  "Choose an option below:",
].join("\n");

export const HELP_TEXT = [
  "❓ How it works",
  "",
  "1. Add an OpenSea collection link.",
  "2. The bot verifies its contract and analyzes on-chain wallet signals.",
  "3. The watcher alerts you about outgoing activity from the selected wallet.",
  "",
  "Direct wallet tracking:",
  "1. Choose Track wallet and send an EVM address.",
  "2. Select Ethereum, Base, Robinhood, or all networks.",
  "3. Receive buy/sell alerts for recognized NFT marketplace settlements.",
  "",
  "You can also paste an OpenSea collection URL directly at any time.",
  "",
  "Commands:",
  "/track <OpenSea URL> — add a collection",
  "/list — tracked collections dashboard",
  "/activity — recent outgoing activity",
  "/stop — stop tracking a collection",
  "/wallet <address> — track marketplace buys and sells",
  "/wallets — list or stop tracked wallets",
  "/help — show this information",
  "",
  "Wallet ownership is inferred from on-chain evidence and is not a verified real-world identity.",
].join("\n");

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add collection", "menu:track")
    .text("📡 Collections", "menu:list")
    .row()
    .text("⚡ Activity", "menu:activity")
    .text("🛑 Stop tracking", "menu:stop")
    .row()
    .text("👛 Track wallet", "menu:wallet-track")
    .text("👛 Wallets", "menu:wallets")
    .row()
    .text("❓ Help", "menu:help")
    .text("🔄 Refresh", "menu:home");
}

export function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏠 Main menu", "menu:home");
}

export async function editMessageSafely(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("message is not modified")) return;
    throw error;
  }
}

export function chainLabel(chainId: number, fallback: string): string {
  const labels: Record<number, string> = {
    1: "Ethereum",
    8453: "Base",
    4663: "Robinhood Chain",
  };
  return labels[chainId] ?? fallback;
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io/address",
    8453: "https://basescan.org/address",
    4663: "https://robinhoodchain.blockscout.com/address",
  };
  const base = explorers[chainId];
  return base ? `${base}/${address}` : null;
}
