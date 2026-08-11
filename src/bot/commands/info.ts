import { InlineKeyboard, type Bot } from "grammy";
import { formatUnits } from "viem";
import { logger } from "../../config/logger.js";
import {
  getCollectionInfo,
  type CollectionAmount,
  type CollectionInfo,
  type CollectionMintInfo,
} from "../../opensea/collectionInfo.js";
import { isFreeMintPrice } from "../../opensea/upcomingDrops.js";
import type { BotContext, BotDependencies } from "../context.js";
import { replyWithError } from "../helpers.js";

export const INFO_PROMPT = [
  "🔎 Find collection information",
  "",
  "Send either:",
  "• an OpenSea collection link",
  "• an Ethereum, Base, or Robinhood NFT contract",
  "",
  "Example:",
  "https://opensea.io/collection/fishbroker",
].join("\n");

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatGmt(date: Date): string {
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

function formatNumber(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatAmount(value: CollectionAmount | null): string {
  if (!value) return "No active offer";
  const usd = value.approximateUsd === null ? "" : ` (≈ ${formatUsd(value.approximateUsd)})`;
  return `${value.amount} ${value.symbol}${usd}`;
}

function formatMintPrice(mint: CollectionMintInfo): string {
  if (!mint.price) return "Not available";
  if (isFreeMintPrice(mint.price)) return "FREE (network gas may apply)";
  if (!mint.token) {
    const currency = mint.currencyAddress
      ? `${mint.currencyAddress.slice(0, 6)}...${mint.currencyAddress.slice(-4)}`
      : "unknown token";
    return `${mint.price} base units (${currency})`;
  }
  const amount = formatUnits(BigInt(mint.price), mint.token.decimals);
  const rate = Number(mint.token.usdPrice);
  const approximateUsd = Number(amount) * rate;
  const usd = Number.isFinite(approximateUsd) && approximateUsd > 0
    ? ` (≈ ${formatUsd(approximateUsd)})`
    : "";
  return `${amount} ${mint.token.symbol}${usd}`;
}

function mintLines(mint: CollectionMintInfo): string[] {
  const access = mint.stageType === "public_sale" ? "Public" : titleCase(mint.stageType);
  const supply = mint.totalSupply && mint.maxSupply
    ? `${mint.totalSupply} / ${mint.maxSupply}`
    : mint.totalSupply ?? null;
  return [
    "Mint details:",
    `Status: ${mint.status === "active" ? "🟢 Minting now" : "🕒 Minting soon (within 12 hours)"}`,
    `Stage: ${mint.label}`,
    `Access: ${access}`,
    `Price: ${formatMintPrice(mint)}`,
    ...(mint.startsAt ? [`Starts: ${formatGmt(mint.startsAt)}`] : []),
    ...(mint.endsAt ? [`Ends: ${formatGmt(mint.endsAt)}`] : []),
    ...(mint.maxPerWallet ? [`Max per wallet: ${mint.maxPerWallet}`] : []),
    ...(supply ? [`Minted supply: ${supply}`] : []),
  ];
}

export function formatCollectionInfo(info: CollectionInfo): string {
  const ownerName = info.ownerUsername
    ? `${info.ownerUsername}${info.ownerEnsName ? ` (${info.ownerEnsName})` : ""}`
    : info.ownerEnsName;
  const ownerLines = info.ownerAddress
    ? [ownerName ?? "OpenSea wallet", info.ownerAddress]
    : ["Not provided by OpenSea"];
  const marketLine = info.mint
    ? mintLines(info.mint)
    : [`Floor price: ${info.floorPrice === null ? "Not available" : `${formatNumber(info.floorPrice, 8)} ${info.floorPriceSymbol ?? ""}`.trim()}`];
  const change = info.priceChange24hPercent === null
    ? "Not available"
    : `${info.priceChange24hPercent >= 0 ? "+" : ""}${formatNumber(info.priceChange24hPercent, 2)}% (floor price)`;
  return [
    "🔎 COLLECTION INFORMATION",
    "",
    `Collection: ${info.name}`,
    `Chain: ${titleCase(info.chain)}`,
    "",
    "OpenSea link:",
    info.openSeaUrl,
    "",
    "NFT contract:",
    info.contractAddress,
    "",
    "Collection owner:",
    ...ownerLines,
    "",
    ...marketLine,
    "",
    `Top offer: ${formatAmount(info.topOffer)}`,
    `24h volume: ${info.volume24h === null ? "Not available" : `${formatNumber(info.volume24h)} ${info.floorPriceSymbol ?? ""}`.trim()}`,
    `24h price change: ${change}`,
    ...(info.otherCollections.length ? [
      "",
      "Other collections by this owner:",
      ...info.otherCollections.flatMap((collection) => [`• ${collection.name}`, `  ${collection.openSeaUrl}`]),
    ] : []),
  ].join("\n");
}

export async function requestCollectionInfoInput(ctx: BotContext): Promise<void> {
  await ctx.reply(INFO_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "OpenSea URL or 0x contract",
    },
  });
}

async function sendCollectionInfo(
  ctx: BotContext,
  dependencies: BotDependencies,
  input: string,
): Promise<void> {
  const progress = await ctx.reply("🔎 Reading OpenSea collection data…");
  try {
    const info = await getCollectionInfo(input, dependencies.env.OPENSEA_API_KEY);
    const keyboard = new InlineKeyboard()
      .url("Open on OpenSea ↗", info.openSeaUrl)
      .row()
      .text("🔎 Look up another", "menu:info")
      .text("🏠 Menu", "menu:home");
    await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, formatCollectionInfo(info), {
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    logger.error({ err: error, telegramId: ctx.from?.id, chatId: ctx.chat?.id }, "collection info request failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progress.message_id).catch(() => undefined);
    await replyWithError(ctx, error);
  }
}

export function registerInfoCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("info", async (ctx) => {
    const input = String(ctx.match ?? "").trim();
    if (input) await sendCollectionInfo(ctx, dependencies, input);
    else await requestCollectionInfoInput(ctx);
  });

  bot.callbackQuery("menu:info", async (ctx) => {
    await ctx.answerCallbackQuery();
    await requestCollectionInfoInput(ctx);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/") || ctx.message.reply_to_message?.text !== INFO_PROMPT) return next();
    await sendCollectionInfo(ctx, dependencies, ctx.message.text);
  });
}
