import { Api } from "grammy";
import { formatEther, formatUnits, type Address, type Hash } from "viem";
import type { AppEnv } from "../config/env.js";
import type { NotificationRecipient } from "../database/repositories/subscriptions.js";
import type { WalletNotificationRecipient } from "../database/repositories/walletSubscriptions.js";
import type { DecodedActivity } from "../types/index.js";
import { getChainById } from "../blockchain/chains.js";
import type { ChainConfig } from "../types/index.js";
import { assessActivityRisk } from "./risk.js";
import type { SwapAssetMovement } from "./risk.js";
import type {
  OpenSeaTokenDetails,
  UpcomingFreeMint,
  UpcomingMintStage,
} from "../opensea/upcomingDrops.js";
import type { NftPriceAlertRecipient } from "../database/repositories/nftPriceAlerts.js";
import { formatTokenWithUsd } from "../utils/price.js";
import type { TelegramOutboxRepository } from "../database/repositories/telegramOutbox.js";
import { getOpenSeaTokenDetails } from "../opensea/upcomingDrops.js";
import { logger } from "../config/logger.js";
import {
  getOpenSeaNftSummary,
  openSeaAssetUrl,
  type OpenSeaNftSummary,
} from "../opensea/nft.js";

const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_USD_QUOTE_CACHE_MS = 60_000;

export type NativeUsdRateLookup = (chain: ChainConfig) => Promise<string | null>;
export type OpenSeaNftLookup = typeof getOpenSeaNftSummary;

export interface ActivityNotification {
  chainId: number;
  wallet: Address;
  to: Address | null;
  value: bigint;
  hash: Hash;
  decoded: DecodedActivity;
  balanceBefore: bigint | null;
  swapAssets: readonly SwapAssetMovement[];
}

export interface MarketplaceNotification {
  chainId: number;
  wallet: Address;
  hash: Hash;
  type: "nft_buy" | "nft_sell" | "nft_mint";
  marketplace: string;
  nftContract: Address;
  tokenId: bigint;
  quantity: bigint;
  standard: "ERC-721" | "ERC-1155";
  counterparty: Address | null;
  nftName?: string;
  openSeaUrl?: string;
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

function freeMintAccessLabel(mint: UpcomingFreeMint): string {
  const text = `${mint.stageType} ${mint.stageLabel}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(?:gtd|guaranteed)\b/.test(text)) return "GTD";
  if (/\b(?:fcfs|first come first served|first come first serve)\b/.test(text)) return "FCFS";
  if (mint.stageType === "public_sale") return "Public";
  return titleCase(mint.stageType);
}

export function formatFreeMintAlert(mint: UpcomingFreeMint): string {
  return [
    "🆓 OPENSEA FREE MINT ALERT",
    "",
    `Collection: ${mint.name}`,
    `Chain: ${titleCase(mint.chain)}`,
    `Stage: ${mint.stageLabel}`,
    `Access: ${freeMintAccessLabel(mint)}`,
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

export interface NftPriceTargetNotification {
  alert: NftPriceAlertRecipient;
  currentFloor: string;
  currencySymbol: string;
  usdRate: string | null;
}

export function formatNftPriceTargetAlert(notification: NftPriceTargetNotification): string {
  const { alert } = notification;
  const movement = alert.direction === "at_or_below" ? "fell to or below" : "rose to or above";
  return [
    "🎯 NFT FLOOR PRICE TARGET REACHED",
    "",
    `Collection: ${alert.collectionName}`,
    `Chain: ${titleCase(alert.chain)}`,
    `Condition: Floor ${movement} your target`,
    `Target: ${formatTokenWithUsd(alert.targetPrice, alert.currencySymbol, notification.usdRate)}`,
    `Current floor: ${formatTokenWithUsd(notification.currentFloor, notification.currencySymbol, notification.usdRate)}`,
    "",
    "This was a one-time alert and has now expired.",
    "",
    `https://opensea.io/collection/${alert.slug}`,
  ].join("\n");
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
  nativeUsdRate: string | null = null,
): string {
  const chain = getChainById(activity.chainId, env);
  const destination = String(activity.decoded.metadata.recipient ?? activity.to ?? "Contract creation");
  const value = activity.value > 0n
    ? formatTokenWithUsd(formatEther(activity.value), chain.nativeSymbol, nativeUsdRate)
    : "0";
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
  const action = activity.type === "nft_buy"
    ? "🟢 BUY"
    : activity.type === "nft_sell"
      ? "🔴 SELL"
      : "🟣 NFT MINTED";
  const openSeaChain = chain.openSeaIdentifiers[0] ?? chain.key;
  const nftName = activity.nftName?.trim() || `NFT #${activity.tokenId}`;
  const openSeaUrl = activity.openSeaUrl ?? openSeaAssetUrl(openSeaChain, activity.nftContract, activity.tokenId);
  return [
    "🛍 WALLET MARKETPLACE ACTIVITY",
    "",
    `Action: ${action}`,
    `Marketplace protocol: ${activity.marketplace}`,
    `Chain: ${chain.name}`,
    "",
    `Wallet:\n${activity.wallet}`,
    `NFT name: ${nftName}`,
    `Link: ${openSeaUrl}`,
    ...(activity.counterparty ? [`Counterparty:\n${activity.counterparty}`] : []),
    "",
    `Transaction:\n${activity.hash}`,
    `${chain.explorerUrl}/tx/${activity.hash}`,
  ].join("\n");
}

export class NotificationService {
  private readonly api: Api;
  private readonly nativeUsdQuoteCache = new Map<string, { expiresAt: number; rate: string | null }>();

  constructor(
    private readonly env: AppEnv,
    private readonly outbox?: TelegramOutboxRepository,
    private readonly nativeUsdRateLookup: NativeUsdRateLookup = async (chain) => {
      // All currently supported OpenSea collection networks use ETH as their native currency.
      // Querying Ethereum's native ETH quote also covers Base and Robinhood Chain reliably.
      if (chain.nativeSymbol !== "ETH") return null;
      const token = await getOpenSeaTokenDetails(env.OPENSEA_API_KEY, "ethereum", NATIVE_ETH_ADDRESS);
      return token.usdPrice;
    },
    private readonly openSeaNftLookup: OpenSeaNftLookup = getOpenSeaNftSummary,
  ) {
    this.api = new Api(env.TELEGRAM_BOT_TOKEN, { timeoutSeconds: 15 });
  }

  private async nativeUsdRate(chain: ChainConfig): Promise<string | null> {
    if (chain.nativeSymbol !== "ETH") return null;
    const cacheKey = chain.nativeSymbol;
    const cached = this.nativeUsdQuoteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.rate;

    let rate: string | null = null;
    try {
      rate = await this.nativeUsdRateLookup(chain);
    } catch (error) {
      logger.warn({ err: error, chainId: chain.chainId }, "native USD quote unavailable for activity alert");
    }
    this.nativeUsdQuoteCache.set(cacheKey, { rate, expiresAt: Date.now() + NATIVE_USD_QUOTE_CACHE_MS });
    return rate;
  }

  async send(recipients: NotificationRecipient[], activity: ActivityNotification): Promise<void> {
    if (!this.outbox) throw new Error("Telegram outbox is required for activity notifications");
    const chain = getChainById(activity.chainId, this.env);
    const nativeUsdRate = activity.value > 0n ? await this.nativeUsdRate(chain) : null;
    const unique = new Map<string, NotificationRecipient>();
    for (const recipient of recipients) {
      // Cross-chain wallet records are useful for monitoring, but an NFT collection
      // only receives alerts for transactions on the collection's own chain.
      if (recipient.chainId !== activity.chainId) continue;
      unique.set(`${recipient.telegramId}:${recipient.collectionId}`, recipient);
    }
    await this.outbox.enqueue([...unique.values()].map((recipient) => ({
      eventKey: `activity:${activity.chainId}:${activity.hash.toLowerCase()}:${recipient.telegramId}:${recipient.collectionId}`,
      telegramId: recipient.telegramId,
      messageText: formatActivityAlert(recipient, activity, this.env, nativeUsdRate),
    })));
  }

  async sendMarketplace(recipients: WalletNotificationRecipient[], activity: MarketplaceNotification): Promise<void> {
    if (!this.outbox) throw new Error("Telegram outbox is required for marketplace notifications");
    const unique = new Map(recipients.map((recipient) => [recipient.telegramId, recipient]));
    if (unique.size === 0) return;
    const chain = getChainById(activity.chainId, this.env);
    const openSeaChain = chain.openSeaIdentifiers[0] ?? chain.key;
    let nft: OpenSeaNftSummary = {
      name: `NFT #${activity.tokenId}`,
      openSeaUrl: openSeaAssetUrl(openSeaChain, activity.nftContract, activity.tokenId),
    };
    try {
      nft = await this.openSeaNftLookup(
        this.env.OPENSEA_API_KEY,
        openSeaChain,
        activity.nftContract,
        activity.tokenId,
      ) ?? nft;
    } catch (error) {
      logger.warn(
        {
          err: error,
          chainId: activity.chainId,
          nftContract: activity.nftContract,
          tokenId: activity.tokenId.toString(),
        },
        "OpenSea NFT metadata unavailable for marketplace alert",
      );
    }
    const enriched = { ...activity, nftName: nft.name, openSeaUrl: nft.openSeaUrl };
    await this.outbox.enqueue([...unique.values()].map((recipient) => ({
      eventKey: [
        "marketplace",
        activity.chainId,
        activity.hash.toLowerCase(),
        recipient.subscriptionId,
        activity.type,
        activity.nftContract.toLowerCase(),
        activity.tokenId,
      ].join(":"),
      telegramId: recipient.telegramId,
      messageText: formatMarketplaceAlert(enriched, this.env),
    })));
  }

  async sendText(telegramId: number, messageText: string): Promise<void> {
    await this.api.sendMessage(telegramId, messageText, {
      link_preview_options: { is_disabled: true },
    });
  }

  async sendFreeMint(telegramId: number, mint: UpcomingFreeMint): Promise<void> {
    if (!this.outbox) throw new Error("Telegram outbox is required for free mint notifications");
    await this.outbox.enqueue([{
      eventKey: `free-mint:${mint.stageId}:${mint.startsAt.toISOString()}:${telegramId}`,
      telegramId,
      messageText: formatFreeMintAlert(mint),
    }]);
  }

  async sendMintPriceChange(
    telegramId: number,
    notification: MintPriceChangeNotification,
    priceVersion: number,
  ): Promise<void> {
    if (!this.outbox) throw new Error("Telegram outbox is required for mint price-change notifications");
    await this.outbox.enqueue([{
      eventKey: [
        "mint-price-change",
        notification.stage.stageId,
        notification.stage.startsAt.toISOString(),
        priceVersion,
        telegramId,
      ].join(":"),
      telegramId,
      messageText: formatMintPriceChangeAlert(notification),
    }]);
  }

  async sendNftPriceTarget(
    telegramId: number,
    notification: NftPriceTargetNotification,
  ): Promise<void> {
    if (!this.outbox) throw new Error("Telegram outbox is required for NFT price-target notifications");
    await this.outbox.enqueue([{
      eventKey: `nft-price-target:${notification.alert.id}:${telegramId}`,
      telegramId,
      messageText: formatNftPriceTargetAlert(notification),
    }]);
  }
}
