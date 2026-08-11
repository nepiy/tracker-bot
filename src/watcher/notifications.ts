import { Api } from "grammy";
import { formatEther, formatUnits, type Address, type Hash } from "viem";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { NotificationRecipient } from "../database/repositories/subscriptions.js";
import type { WalletNotificationRecipient } from "../database/repositories/walletSubscriptions.js";
import type { DecodedActivity } from "../types/index.js";
import { getChainById } from "../blockchain/chains.js";
import { assessActivityRisk } from "./risk.js";
import type {
  OpenSeaTokenDetails,
  UpcomingFreeMint,
  UpcomingMintStage,
} from "../opensea/upcomingDrops.js";

export interface ActivityNotification {
  chainId: number;
  wallet: Address;
  to: Address | null;
  value: bigint;
  hash: Hash;
  decoded: DecodedActivity;
  balanceBefore: bigint | null;
}

export interface MarketplaceNotification {
  chainId: number;
  wallet: Address;
  hash: Hash;
  type: "nft_buy" | "nft_sell";
  marketplace: string;
  nftContract: Address;
  tokenId: bigint;
  quantity: bigint;
  standard: "ERC-721" | "ERC-1155";
  counterparty: Address | null;
}

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function formatGmtDate(date: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} GMT`;
}

export function formatFreeMintAlert(mint: UpcomingFreeMint): string {
  return [
    "🆓 OPENSEA FREE MINT ALERT",
    "",
    `Collection: ${mint.name}`,
    `Chain: ${titleCase(mint.chain)}`,
    `Stage: ${mint.stageLabel}`,
    `Access: ${mint.stageType === "public_sale" ? "Public" : titleCase(mint.stageType)}`,
    "Price: FREE (network gas may apply)",
    "",
    `Starts: ${formatGmtDate(mint.startsAt)}`,
    ...(mint.endsAt ? [`Ends: ${formatGmtDate(mint.endsAt)}`] : []),
    "",
    mint.openSeaUrl,
  ].join("\n");
}

export interface MintPriceChangeNotification {
  stage: UpcomingMintStage;
  token: OpenSeaTokenDetails | null;
}

export function formatPaidMintPrice(
  price: string,
  currencyAddress: string,
  token: OpenSeaTokenDetails | null,
): string {
  if (!token) {
    return `${price} base units (${currencyAddress.slice(0, 6)}...${currencyAddress.slice(-4)})`;
  }
  const amount = formatUnits(BigInt(price), token.decimals);
  const usdRate = token.usdPrice === null ? Number.NaN : Number(token.usdPrice);
  const usdValue = Number(amount) * usdRate;
  let usdLabel = "";
  if (Number.isFinite(usdValue) && usdValue > 0) {
    usdLabel = usdValue < 0.01
      ? " (≈ <$0.01)"
      : ` (≈ ${new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(usdValue)})`;
  }
  return `${amount} ${token.symbol}${usdLabel}`;
}

export function formatMintPriceChangeAlert(notification: MintPriceChangeNotification): string {
  const { stage, token } = notification;
  return [
    "🚨 OPENSEA MINT PRICE CHANGED",
    "",
    `Collection: ${stage.name}`,
    `Chain: ${titleCase(stage.chain)}`,
    `Stage: ${stage.stageLabel}`,
    "",
    "Previous price: FREE",
    `New price: ${formatPaidMintPrice(stage.price, stage.currencyAddress, token)}`,
    "Status: This mint is no longer free.",
    "",
    `Starts: ${formatGmtDate(stage.startsAt)}`,
    ...(stage.endsAt ? [`Ends: ${formatGmtDate(stage.endsAt)}`] : []),
    "",
    stage.openSeaUrl,
  ].join("\n");
}

export function formatActivityAlert(
  recipient: NotificationRecipient,
  activity: ActivityNotification,
  env: AppEnv,
): string {
  const chain = getChainById(activity.chainId, env);
  const destination = String(activity.decoded.metadata.recipient ?? activity.to ?? "Contract creation");
  const value = activity.value > 0n ? `${formatEther(activity.value)} ${chain.nativeSymbol}` : "0";
  const actionIcon: Record<DecodedActivity["type"], string> = {
    native_transfer: "📤",
    erc20_transfer: "📤",
    nft_transfer: "🖼",
    swap: "🔄",
    bridge: "🌉",
    contract_interaction: "🧩",
  };
  const risk = assessActivityRisk(activity, env);
  return [
    risk.highRisk ? "🚨🚨 ALERT: HIGH-RISK DEV ACTIVITY 🚨🚨" : "🚨 DEV WALLET ACTIVITY",
    ...(risk.highRisk ? ["", ...risk.reasons.map((reason) => `⚠️ ${reason}`)] : []),
    "",
    `Collection: ${recipient.collectionName}`,
    `Chain: ${chain.name}`,
    "",
    `Wallet:\n${activity.wallet}`,
    "",
    `Action: ${actionIcon[activity.decoded.type]} ${activity.decoded.label}`,
    `To: ${destination}`,
    ...(activity.value > 0n ? [`Value: ${value}`] : []),
    "",
    `Transaction:\n${activity.hash}`,
    `${chain.explorerUrl}/tx/${activity.hash}`,
  ].join("\n");
}

export function formatMarketplaceAlert(activity: MarketplaceNotification, env: AppEnv): string {
  const chain = getChainById(activity.chainId, env);
  const action = activity.type === "nft_buy" ? "🟢 BUY" : "🔴 SELL";
  return [
    "🛍 WALLET MARKETPLACE ACTIVITY",
    "",
    `Action: ${action}`,
    `Marketplace protocol: ${activity.marketplace}`,
    `Chain: ${chain.name}`,
    "",
    `Wallet:\n${activity.wallet}`,
    `NFT contract:\n${activity.nftContract}`,
    `Standard: ${activity.standard}`,
    `Token ID: ${activity.tokenId}`,
    ...(activity.quantity > 1n ? [`Quantity: ${activity.quantity}`] : []),
    ...(activity.counterparty ? [`Counterparty:\n${activity.counterparty}`] : []),
    "",
    `Transaction:\n${activity.hash}`,
    `${chain.explorerUrl}/tx/${activity.hash}`,
  ].join("\n");
}

export class NotificationService {
  private readonly api: Api;

  constructor(private readonly env: AppEnv) {
    this.api = new Api(env.TELEGRAM_BOT_TOKEN);
  }

  async send(recipients: NotificationRecipient[], activity: ActivityNotification): Promise<void> {
    const unique = new Map<string, NotificationRecipient>();
    for (const recipient of recipients) {
      unique.set(`${recipient.telegramId}:${recipient.collectionId}`, recipient);
    }
    await Promise.allSettled(
      [...unique.values()].map(async (recipient) => {
        try {
          await this.api.sendMessage(recipient.telegramId, formatActivityAlert(recipient, activity, this.env), {
            link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          logger.error(
            { err: error, telegramId: recipient.telegramId, chainId: activity.chainId, txHash: activity.hash },
            "Telegram notification failed",
          );
        }
      }),
    );
  }

  async sendMarketplace(recipients: WalletNotificationRecipient[], activity: MarketplaceNotification): Promise<void> {
    const unique = new Map(recipients.map((recipient) => [recipient.telegramId, recipient]));
    await Promise.allSettled(
      [...unique.values()].map(async (recipient) => {
        try {
          await this.api.sendMessage(recipient.telegramId, formatMarketplaceAlert(activity, this.env), {
            link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          logger.error(
            { err: error, telegramId: recipient.telegramId, chainId: activity.chainId, txHash: activity.hash },
            "Telegram marketplace notification failed",
          );
        }
      }),
    );
  }

  async sendFreeMint(telegramId: number, mint: UpcomingFreeMint): Promise<void> {
    await this.api.sendMessage(telegramId, formatFreeMintAlert(mint), {
      link_preview_options: { is_disabled: true },
    });
  }

  async sendMintPriceChange(
    telegramId: number,
    notification: MintPriceChangeNotification,
  ): Promise<void> {
    await this.api.sendMessage(telegramId, formatMintPriceChangeAlert(notification), {
      link_preview_options: { is_disabled: true },
    });
  }
}
