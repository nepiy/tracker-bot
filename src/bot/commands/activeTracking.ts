import { InlineKeyboard, type Bot } from "grammy";
import type { NftPriceAlertView } from "../../database/repositories/nftPriceAlerts.js";
import type { SubscriptionView } from "../../database/repositories/subscriptions.js";
import type { WalletSubscriptionView } from "../../database/repositories/walletSubscriptions.js";
import { shortAddress } from "../../utils/address.js";
import { formatTokenWithUsd } from "../../utils/price.js";
import type { BotContext, BotDependencies } from "../context.js";
import { chainLabel, editMessageSafely } from "../ui.js";

const MAX_ITEMS_PER_SECTION = 8;

export interface ActiveTrackingSummary {
  collections: SubscriptionView[];
  wallets: WalletSubscriptionView[];
  priceAlerts: NftPriceAlertView[];
  freeMintAlertsEnabled: boolean;
}

function compactName(value: string, maxLength = 48): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function remainingLine(total: number): string[] {
  const remaining = total - MAX_ITEMS_PER_SECTION;
  return remaining > 0 ? [`   …and ${remaining} more. Open its management page to see all.`] : [];
}

function groupedWallets(wallets: WalletSubscriptionView[]): Array<{ address: string; networks: string[] }> {
  const grouped = new Map<string, { address: string; networks: string[] }>();
  for (const wallet of wallets) {
    const key = wallet.address.toLowerCase();
    const network = chainLabel(wallet.chainId, String(wallet.chainId));
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.networks.includes(network)) existing.networks.push(network);
    } else {
      grouped.set(key, { address: wallet.address, networks: [network] });
    }
  }
  return [...grouped.values()];
}

export function formatActiveTracking(summary: ActiveTrackingSummary): string {
  const wallets = groupedWallets(summary.wallets);
  const hasSpecificTracking = summary.collections.length > 0 || wallets.length > 0 || summary.priceAlerts.length > 0;
  const lines = [
    "📋 YOUR ACTIVE TRACKING",
    "",
    "Everything your personal account is currently asking the bot to monitor.",
    "",
    "OVERVIEW",
    `📡 Collections: ${summary.collections.length}`,
    `👛 Wallets: ${wallets.length} address${wallets.length === 1 ? "" : "es"} • ${summary.wallets.length} network monitor${summary.wallets.length === 1 ? "" : "s"}`,
    `🎯 Floor targets: ${summary.priceAlerts.length}`,
    `🆓 Free-mint alerts: ${summary.freeMintAlertsEnabled ? "🟢 ON" : "⚪ OFF"}`,
  ];

  if (!hasSpecificTracking && !summary.freeMintAlertsEnabled) {
    lines.push(
      "",
      "Nothing is active yet.",
      "Use the buttons below to add a collection, wallet, floor target, or optional free-mint alerts.",
    );
  }

  if (summary.collections.length) {
    lines.push("", "📡 COLLECTION DEV-WALLET ALERTS");
    for (const item of summary.collections.slice(0, MAX_ITEMS_PER_SECTION)) {
      lines.push(
        `• ${compactName(item.name)} — ${chainLabel(item.chainId, item.chain)}`,
        `  Dev/team wallet: ${item.walletAddress ? shortAddress(item.walletAddress) : "Analysis unavailable"}`,
      );
    }
    lines.push(...remainingLine(summary.collections.length));
  }

  if (wallets.length) {
    lines.push("", "👛 MARKETPLACE WALLET ALERTS");
    for (const wallet of wallets.slice(0, MAX_ITEMS_PER_SECTION)) {
      lines.push(`• ${shortAddress(wallet.address)} — ${wallet.networks.join(", ")}`);
    }
    lines.push(...remainingLine(wallets.length));
  }

  if (summary.priceAlerts.length) {
    lines.push("", "🎯 ONE-TIME FLOOR TARGETS");
    for (const alert of summary.priceAlerts.slice(0, MAX_ITEMS_PER_SECTION)) {
      const operator = alert.direction === "at_or_below" ? "≤" : "≥";
      const status = alert.status === "sending" ? "🟡 Queued" : "🟢 Watching";
      lines.push(
        `• ${compactName(alert.collectionName)} — floor ${operator} ${formatTokenWithUsd(alert.targetPrice, alert.currencySymbol, alert.usdRate)}`,
        `  ${status}`,
      );
    }
    lines.push(...remainingLine(summary.priceAlerts.length));
  }

  lines.push(
    "",
    "Group collection alerts are managed inside each Telegram group by its admins.",
  );
  return lines.join("\n");
}

export function activeTrackingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📡 Collections", "menu:list")
    .text("👛 Wallets", "menu:wallets")
    .row()
    .text("🎯 Floor Alerts", "menu:price-alerts")
    .text("⚙️ Alert Settings", "menu:settings")
    .row()
    .text("➕ Add Collection", "menu:track")
    .text("➕ Add Wallet", "menu:wallet-track")
    .row()
    .text("⚡ Recent Activity", "menu:activity")
    .row()
    .text("🔄 Refresh", "menu:active-tracking")
    .text("🏠 Main Menu", "menu:home");
}

async function loadActiveTracking(
  ctx: BotContext,
  dependencies: BotDependencies,
): Promise<ActiveTrackingSummary | null> {
  if (!ctx.from) return null;
  const user = await dependencies.repositories.users.ensure(ctx.from.id);
  const [collections, wallets, priceAlerts] = await Promise.all([
    dependencies.repositories.subscriptions.listActive(user.id),
    dependencies.repositories.walletSubscriptions.listActive(user.id),
    dependencies.repositories.nftPriceAlerts.listActive(user.id),
  ]);
  return {
    collections,
    wallets,
    priceAlerts,
    freeMintAlertsEnabled: user.free_mint_alerts_enabled,
  };
}

async function showActiveTracking(
  ctx: BotContext,
  dependencies: BotDependencies,
  edit: boolean,
): Promise<void> {
  const summary = await loadActiveTracking(ctx, dependencies);
  if (!summary) return;
  const text = formatActiveTracking(summary);
  const keyboard = activeTrackingKeyboard();
  if (edit) await editMessageSafely(ctx, text, keyboard);
  else await ctx.reply(text, { reply_markup: keyboard });
}

function isPrivate(ctx: BotContext): boolean {
  return ctx.chat?.type === "private";
}

export function registerActiveTrackingCommand(
  bot: Bot<BotContext>,
  dependencies: BotDependencies,
): void {
  bot.command("active", async (ctx) => {
    if (!isPrivate(ctx)) {
      await ctx.reply("Open a private chat with me to view your personal active tracking.");
      return;
    }
    await showActiveTracking(ctx, dependencies, false);
  });

  bot.callbackQuery("menu:active-tracking", async (ctx) => {
    if (!isPrivate(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Open a private chat with me to view personal tracking.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await showActiveTracking(ctx, dependencies, true);
  });
}
