import { InlineKeyboard } from "grammy";
import type { BotContext } from "./context.js";

export const MAIN_MENU_TEXT = [
  "🛰 NFT Dev Wallet Tracker",
  "",
  "Research collections, watch team wallets, monitor NFT trades, and receive market alerts from one dashboard.",
  "",
  "What you can do:",
  "🔎 Research NFT — view its owner, contract, mint status, floor, offers, volume, related collections, and creator token history.",
  "🎯 Floor alerts — get one notification when a collection floor reaches your chosen target.",
  "📡 Collection tracking — monitor the inferred dev/team wallet for sends, swaps, bridges, and high-risk moves.",
  "👛 Wallet tracking — follow NFT marketplace buys and sells for any EVM wallet.",
  "👥 Group tracking — add the bot to a group where admins control collection alerts.",
  "📋 Active tracking — see every personal monitor and alert setting in one place.",
  "🆓 Free mints — freshly browse OpenSea's upcoming and currently live public free mints.",
  "",
  "Networks: Ethereum • Base • Robinhood Chain",
  "",
  "Choose an action:",
].join("\n");

export const HELP_TEXT = [
  "❓ NFT Dev Wallet Tracker Guide",
  "",
  "🔎 Research an NFT",
  "Send an OpenSea link or supported NFT contract to see collection ownership, mint status, floor price, top offer, 24-hour metrics, related collections, and market-listed ERC-20 tokens deployed by the same creator wallet.",
  "",
  "🎯 Create a floor alert",
  "Choose a target above or below the current floor. The bot notifies you once when the floor reaches it, then expires the alert automatically.",
  "",
  "📡 Track a collection",
  "The bot verifies the contract, analyzes on-chain signals to infer a likely dev/team wallet, and alerts on sends, swaps, bridges, contract activity, and configured high-risk movements.",
  "",
  "👛 Track a wallet",
  "Monitor NFT marketplace buys and sells for any EVM wallet on Ethereum, Base, Robinhood Chain, or all supported networks.",
  "",
  "👥 Use it in a group",
  "Group admins can add or remove collection tracking. Alerts are then delivered directly to the group.",
  "",
  "⚠️ Important",
  "Wallet ownership is inferred from on-chain evidence and is not a verified real-world identity. Floor prices and marketplace data come from OpenSea.",
  "",
  "Commands:",
  "/info <OpenSea URL or contract> — research a collection",
  "/pricealert <OpenSea URL or contract> — create a one-time floor target",
  "/pricealerts — view or cancel floor-price targets",
  "/track <OpenSea URL> — add a collection",
  "/list — tracked collections dashboard",
  "/activity — recent outgoing activity",
  "/stop — stop tracking a collection",
  "/wallet <address> — track marketplace buys and sells",
  "/wallets — list or stop tracked wallets",
  "/grouptrack <OpenSea URL> — track a collection in a group (admins only)",
  "/grouplist — manage this group's collection alerts (admins only)",
  "/settings — customize personal notification preferences",
  "/freemints — freshly browse upcoming and live OpenSea free mints",
  "/active — view all personal tracking and alert settings together",
  "/help — show this information",
].join("\n");

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Add to Group", "menu:add-group")
    .row()
    .text("📋 Active Tracking", "menu:active-tracking")
    .row()
    .text("🔎 Research NFT", "menu:info")
    .text("🎯 Floor Alerts", "menu:price-alerts")
    .row()
    .text("➕ Add Collection", "menu:track")
    .text("📡 Tracking Collection", "menu:list")
    .row()
    .text("👛 Add Wallet", "menu:wallet-track")
    .text("🗂 Tracking Wallet", "menu:wallets")
    .row()
    .text("⚡ Recent Activity", "menu:activity")
    .text("🆓 Free Mints", "menu:free-mints")
    .row()
    .text("⚙️ Alert Settings", "menu:settings")
    .text("🛑 Stop Collection", "menu:stop")
    .row()
    .text("❓ Guide", "menu:help")
    .text("🔄 Refresh Dashboard", "menu:home");
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
