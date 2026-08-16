import { InlineKeyboard, type Bot } from "grammy";
import { formatUnits, isAddress } from "viem";
import { logger } from "../../config/logger.js";
import { formatEligibilityStageLabel } from "../../opensea/eligibility.js";
import type { EligibilityCheckResult } from "../../services/eligibility.js";
import { UserFacingError, ExternalServiceError } from "../../utils/errors.js";
import { normalizeAddress } from "../../utils/address.js";
import type { BotContext, BotDependencies } from "../context.js";
import { homeKeyboard } from "../ui.js";

export const ELIGIBILITY_PROMPT = [
  "🎟 Check OpenSea allowlist eligibility",
  "",
  "Send the wallet address to check.",
  "",
  "The bot will ask OpenSea to verify that wallet, then show only active or upcoming allowlist, GTD, FCFS, presale, or other non-public mint stages.",
  "Public-mint-only eligibility is intentionally hidden.",
  "",
  "You will approve a read-only OpenSea sign-in. Never share a seed phrase or private key.",
].join("\n");

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

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatPrice(price: string): string {
  if (/^0+$/.test(price.trim())) return "FREE (network gas may apply)";
  try {
    return `${formatUnits(BigInt(price), 18)} native token units`;
  } catch {
    return "Price unavailable";
  }
}

interface EligibilityMessage {
  text: string;
  keyboard: InlineKeyboard;
}

const TELEGRAM_TEXT_LIMIT = 4_096;
const ELIGIBILITY_MESSAGE_MARGIN = 300;

function formatEligibleStages(
  authenticatedAddress: string,
  result: EligibilityCheckResult,
): EligibilityMessage[] {
  const header = [
    "🎟 OPENSEA ALLOWLIST ELIGIBILITY",
    "",
    `Wallet: ${authenticatedAddress}`,
    `Fresh check: ${formatGmt(new Date())}`,
    `Drops checked: ${result.scannedDrops}`,
    "",
  ];
  if (!result.eligibleStages.length) {
    return [{
      text: [...header,
        "No currently active or next-24-hour non-public mint stage was found for this wallet.",
        "Public-mint-only eligibility is not included.",
        "",
        "OpenSea's allowlists can change. Run the check again before minting.",
      ].join("\n"),
      keyboard: new InlineKeyboard().text("🏠 Main menu", "menu:home"),
    }];
  }

  const summary = `Found: ${result.eligibleStages.length} eligible allowlist stage${result.eligibleStages.length === 1 ? "" : "s"}`;
  const blocks = result.eligibleStages.map((item, index) => ({
    item,
    index,
    lines: [
      `${index + 1}. ${item.drop.name}`,
      `Chain: ${titleCase(item.drop.chain)}`,
      `Stage: ${formatEligibilityStageLabel(item.stage)}`,
      `Starts: ${formatGmt(item.stage.startsAt)}`,
      ...(item.stage.endsAt ? [`Ends: ${formatGmt(item.stage.endsAt)}`] : []),
      `Price: ${formatPrice(item.stage.price)}`,
      ...(item.maxMintable ? [`Max for wallet: ${item.maxMintable}`] : []),
      `OpenSea: ${item.drop.openSeaUrl}`,
      "",
    ],
  }));

  const messages: EligibilityMessage[] = [];
  let currentLines = [...header, summary, ""];
  let currentBlocks: typeof blocks = [];
  const flush = () => {
    const keyboard = new InlineKeyboard();
    for (const block of currentBlocks) keyboard.url(`Open #${block.index + 1}`, block.item.drop.openSeaUrl).row();
    keyboard
      .text("🎟 Check another wallet", "menu:eligibility")
      .row()
      .text("🏠 Main menu", "menu:home");
    messages.push({ text: currentLines.join("\n").trimEnd(), keyboard });
    currentLines = [
      "🎟 OPENSEA ALLOWLIST ELIGIBILITY (CONTINUED)",
      "",
      `Wallet: ${authenticatedAddress}`,
      "",
    ];
    currentBlocks = [];
  };

  for (const block of blocks) {
    const candidateLines = [...currentLines, ...block.lines];
    if (currentBlocks.length && candidateLines.join("\n").length > TELEGRAM_TEXT_LIMIT - ELIGIBILITY_MESSAGE_MARGIN) flush();
    currentLines.push(...block.lines);
    currentBlocks.push(block);
  }
  if (currentBlocks.length) flush();
  return messages;
}

function errorMessage(error: unknown): string {
  if (error instanceof UserFacingError) return `❌ ${error.message}`;
  if (error instanceof ExternalServiceError) {
    return error.retryable
      ? "❌ OpenSea is temporarily unavailable or rate-limited. Please try the eligibility check again shortly."
      : "❌ OpenSea did not authorize the read-only eligibility check. Please start again and approve the requested sign-in.\n\nNo wallet credentials are stored by the bot.";
  }
  return "❌ The eligibility check could not be completed. Please try again.";
}

export async function requestEligibilityInput(ctx: BotContext): Promise<void> {
  await ctx.reply(ELIGIBILITY_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "0x…",
    },
  });
}

async function sendEligibilityResult(
  ctx: BotContext,
  dependencies: BotDependencies,
  address: string,
): Promise<void> {
  if (!ctx.from) return;
  const telegramId = ctx.from.id;
  let normalized: string;
  try {
    if (!isAddress(address.trim(), { strict: false })) throw new Error("invalid");
    normalized = normalizeAddress(address.trim());
  } catch {
    await ctx.reply("❌ That is not a valid EVM wallet address. Please send a 0x address with 40 hexadecimal characters.");
    return;
  }

  try {
    const session = await dependencies.eligibility.start(telegramId, normalized);
    const verificationUrl = session.device.verification_uri_complete ?? session.device.verification_uri;
    const expiresMinutes = Math.max(1, Math.ceil(session.device.expires_in / 60));
    await ctx.reply([
      "🔐 OpenSea verification started",
      "",
      `Requested wallet: ${normalized}`,
      "",
      "1. Open the official OpenSea verification page below.",
      `2. Enter code: ${session.device.user_code}`,
      "3. Sign in with the same wallet address.",
      "",
      `This code expires in about ${expiresMinutes} minutes. The bot will send your result automatically after verification.`,
      "",
      "Only read:eligibility access is requested. No private key or seed phrase is ever requested.",
    ].join("\n"), {
      reply_markup: new InlineKeyboard()
        .url("🔐 Verify with OpenSea ↗", verificationUrl)
        .row()
        .text("🏠 Main menu", "menu:home"),
      link_preview_options: { is_disabled: true },
    });
    void session.result
      .then(async (result) => {
        const messages = formatEligibleStages(result.authenticatedAddress, result);
        for (const message of messages) {
          await ctx.api.sendMessage(telegramId, message.text, {
            reply_markup: message.keyboard,
            link_preview_options: { is_disabled: true },
          });
        }
      })
      .catch(async (error) => {
        logger.warn({ err: error, telegramId }, "OpenSea eligibility check failed");
        await ctx.api.sendMessage(telegramId, errorMessage(error), { reply_markup: homeKeyboard() }).catch(() => undefined);
      });
  } catch (error) {
    logger.warn({ err: error, telegramId }, "OpenSea eligibility session could not start");
    await ctx.reply(errorMessage(error), { reply_markup: homeKeyboard() });
  }
}

export function registerEligibilityCommand(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("eligibility", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Open a private chat with me to check a wallet's OpenSea eligibility.");
      return;
    }
    const input = String(ctx.match ?? "").trim();
    if (input) await sendEligibilityResult(ctx, dependencies, input);
    else await requestEligibilityInput(ctx);
  });

  bot.callbackQuery("menu:eligibility", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Open a private chat for wallet eligibility.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await requestEligibilityInput(ctx);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/") || ctx.chat.type !== "private") return next();
    if (ctx.message.reply_to_message?.text !== ELIGIBILITY_PROMPT) return next();
    await sendEligibilityResult(ctx, dependencies, ctx.message.text);
  });
}
