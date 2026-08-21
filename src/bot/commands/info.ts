import { InlineKeyboard, type Bot } from "grammy";
import { formatUnits, type Address } from "viem";
import { getMonitoringChains, resolveChainIdentifier } from "../../blockchain/chains.js";
import { createChainClient } from "../../blockchain/clients.js";
import {
  findCreatorMarketTokensOnChain,
  type CreatorMarketToken,
} from "../../blockchain/creatorTokens.js";
import { resolveContractDeployment } from "../../blockchain/deployment.js";
import { logger } from "../../config/logger.js";
import { createExplorer } from "../../explorers/index.js";
import {
  getCollectionInfo,
  type CollectionAmount,
  type CollectionInfo,
  type CollectionMintInfo,
} from "../../opensea/collectionInfo.js";
import { isFreeMintPrice } from "../../opensea/upcomingDrops.js";
import { formatTokenWithUsd, formatUsd } from "../../utils/price.js";
import type { BotContext, BotDependencies } from "../context.js";
import { replyWithError } from "../helpers.js";
import { deleteCallbackMessage, deleteReplyPrompt } from "../ui.js";

export const INFO_PROMPT = [
  "🔎 Find collection information",
  "",
  "Send either:",
  "• an OpenSea collection link",
  "• an Ethereum or Robinhood NFT contract",
  "",
  "Example:",
  "https://opensea.io/collection/stonkbrokers-434284142",
].join("\n");

export interface CreatorTokenHistory {
  deployerAddress: Address;
  tokens: CreatorMarketToken[];
  complete: boolean;
}

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

function formatAmount(value: CollectionAmount | null): string {
  if (!value) return "No active offer";
  const formattedUsd = value.approximateUsd === null ? null : formatUsd(value.approximateUsd);
  const usd = formattedUsd === null ? "" : ` (≈ ${formattedUsd})`;
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
    : [`Floor price: ${info.floorPrice === null || !info.floorPriceSymbol
      ? "Not available"
      : formatTokenWithUsd(info.floorPrice, info.floorPriceSymbol, info.floorPriceUsdRate)}`];
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

function formatCompactUsd(value: number | null): string | null {
  if (value === null) return null;
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 0.01 ? 6 : 2,
  }).format(value);
}

function formatTokenEntry(token: CreatorMarketToken, index: number): string {
  const created = token.createdAt
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" })
      .format(token.createdAt)
    : "Date unavailable";
  const price = formatCompactUsd(token.priceUsd);
  const marketCap = formatCompactUsd(token.marketCapUsd);
  const liquidity = formatCompactUsd(token.liquidityUsd);
  return [
    `${index + 1}. ${token.name} (${token.symbol})`,
    `Chain: ${token.chainName} • Created: ${created} GMT`,
    `Contract: ${token.address}`,
    ...(price ? [`Price: ${price}`] : []),
    ...(marketCap ? [`Market cap/FDV: ${marketCap}`] : []),
    ...(liquidity ? [`Liquidity: ${liquidity}`] : []),
    `Explorer: ${token.explorerUrl}`,
    `Market: ${token.marketUrl}`,
  ].join("\n");
}

export function formatCreatorTokenHistory(history: CreatorTokenHistory): string[] {
  if (!history.tokens.length) return [];
  const header = [
    "🪙 CREATOR MEMECOIN HISTORY",
    "",
    "Verified deployment initiator:",
    history.deployerAddress,
    "",
    `${history.tokens.length} market-listed ERC-20 ${history.tokens.length === 1 ? "token" : "tokens"} detected across configured chains.`,
    "On-chain standards cannot prove that a token is a memecoin, so this list only includes deployer-created ERC-20 tokens with a detected DEX market.",
    ...(!history.complete ? ["⚠️ Explorer history limits were reached on at least one chain; additional older deployments may exist."] : []),
  ].join("\n");
  const chunks: string[] = [];
  let current = header;
  for (const [index, token] of history.tokens.entries()) {
    const entry = formatTokenEntry(token, index);
    const candidate = `${current}\n\n${entry}`;
    if (candidate.length > 3_900 && current !== header) {
      chunks.push(current);
      current = `🪙 CREATOR MEMECOIN HISTORY (continued)\n\n${entry}`;
    } else {
      current = candidate;
    }
  }
  chunks.push(current);
  return chunks;
}

async function loadCreatorTokenHistory(
  info: CollectionInfo,
  dependencies: BotDependencies,
): Promise<CreatorTokenHistory> {
  const sourceChain = resolveChainIdentifier(info.chain, dependencies.env);
  const sourceClient = createChainClient(sourceChain);
  const sourceExplorer = createExplorer(sourceChain, dependencies.env);
  const deployment = await resolveContractDeployment(
    info.contractAddress as Address,
    sourceExplorer,
    sourceClient,
  );
  const results = await Promise.allSettled(getMonitoringChains(dependencies.env).map(async (chain) => {
    const explorer = createExplorer(chain, dependencies.env);
    const client = createChainClient(chain);
    return await findCreatorMarketTokensOnChain(
      deployment.deploymentInitiator,
      chain,
      explorer,
      client,
    );
  }));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason, deployer: deployment.deploymentInitiator }, "creator token chain lookup failed");
    }
  }
  const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!successful.length && results.some((result) => result.status === "rejected")) {
    throw results.find((result) => result.status === "rejected")!.reason;
  }
  const tokens = successful
    .flatMap((result) => result.tokens)
    .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0));
  return {
    deployerAddress: deployment.deploymentInitiator,
    tokens,
    complete: successful.length === results.length && successful.every((result) => result.complete),
  };
}

export async function requestCollectionInfoInput(ctx: BotContext): Promise<void> {
  await deleteCallbackMessage(ctx);
  await ctx.reply(INFO_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "OpenSea URL or 0x contract",
    },
  });
}

export async function sendCollectionInfo(
  ctx: BotContext,
  dependencies: BotDependencies,
  input: string,
  existingProgressMessageId?: number,
): Promise<void> {
  await deleteReplyPrompt(ctx, INFO_PROMPT);
  const progressMessageId = existingProgressMessageId
    ?? (await ctx.reply("🔎 Reading collection and deployer history…")).message_id;
  try {
    const info = await getCollectionInfo(input, dependencies.env.OPENSEA_API_KEY);
    const creatorHistory = await loadCreatorTokenHistory(info, dependencies).catch((error) => {
      logger.warn({ err: error, chain: info.chain, contract: info.contractAddress }, "creator token history lookup failed");
      return null;
    });
    const keyboard = new InlineKeyboard()
      .url("Open on OpenSea ↗", info.openSeaUrl)
      .row()
      .text("🔎 Look up another", "menu:info")
      .text("🏠 Menu", "menu:home");
    await ctx.api.editMessageText(ctx.chat!.id, progressMessageId, formatCollectionInfo(info), {
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    for (const message of creatorHistory ? formatCreatorTokenHistory(creatorHistory) : []) {
      await ctx.reply(message, { link_preview_options: { is_disabled: true } }).catch((error) => {
        logger.warn({ err: error, chatId: ctx.chat?.id }, "creator token history delivery failed");
      });
    }
  } catch (error) {
    logger.error({ err: error, telegramId: ctx.from?.id, chatId: ctx.chat?.id }, "collection info request failed");
    await ctx.api.deleteMessage(ctx.chat!.id, progressMessageId).catch(() => undefined);
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
