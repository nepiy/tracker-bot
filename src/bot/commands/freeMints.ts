import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../../config/logger.js";
import {
  findFreeMintDirectory,
  type FreeMintDirectoryView,
  type UpcomingFreeMint,
} from "../../opensea/upcomingDrops.js";
import { ExternalServiceError } from "../../utils/errors.js";
import type { BotContext, BotDependencies } from "../context.js";
import { editMessageSafely } from "../ui.js";

const PAGE_SIZE = 5;

export const FREE_MINTS_MENU_TEXT = [
  "🆓 OpenSea Free Mints",
  "",
  "Browse zero-price public, GTD, and FCFS mint stages listed in OpenSea's drop calendar.",
  "",
  "🕒 Upcoming — scheduled free mints that have not started yet.",
  "🟢 Live now — free public, GTD, or FCFS stages OpenSea reports as minting with supply remaining.",
  "",
  "Every check fetches a new snapshot from OpenSea, so newly listed mints appear the next time you open or refresh a view.",
  "Network gas may still apply.",
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

function checkedAt(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

export function freeMintsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🕒 Upcoming", "free-mints:upcoming:0")
    .text("🟢 Live now", "free-mints:live:0")
    .row()
    .text("⚙️ Alert settings", "menu:settings")
    .text("🏠 Main menu", "menu:home");
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function safePage(page: number, total: number): number {
  return Math.min(Math.max(page, 0), pageCount(total) - 1);
}

export function formatFreeMintDirectory(
  view: FreeMintDirectoryView,
  allMints: UpcomingFreeMint[],
  requestedPage: number,
  now = new Date(),
): string {
  const page = safePage(requestedPage, allMints.length);
  const mints = allMints.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const heading = view === "upcoming" ? "🕒 UPCOMING FREE MINTS" : "🟢 LIVE FREE MINTS";
  const lines = [
    heading,
    "",
    `Fresh OpenSea check: ${checkedAt(now)} GMT`,
    `Found: ${allMints.length} free mint stage${allMints.length === 1 ? "" : "s"}`,
    `Page: ${page + 1}/${pageCount(allMints.length)}`,
    "",
  ];
  if (!mints.length) {
    lines.push(
      view === "upcoming"
        ? "OpenSea is not currently listing an upcoming free public, GTD, or FCFS stage."
        : "OpenSea is not currently reporting a free public, GTD, or FCFS stage as live with supply remaining.",
      "",
      "Tap Refresh later to run a new check.",
    );
    return lines.join("\n");
  }

  mints.forEach((mint, index) => {
    const position = page * PAGE_SIZE + index + 1;
    lines.push(
      `${position}. ${mint.name}`,
      `Chain: ${titleCase(mint.chain)}`,
      `Stage: ${mint.stageLabel}`,
      view === "upcoming" ? `Starts: ${formatGmt(mint.startsAt)}` : `Started: ${formatGmt(mint.startsAt)}`,
      ...(mint.endsAt ? [`Ends: ${formatGmt(mint.endsAt)}`] : []),
      "Price: FREE (gas may apply)",
      "",
    );
  });
  return lines.join("\n").trimEnd();
}

export function freeMintDirectoryKeyboard(
  view: FreeMintDirectoryView,
  allMints: UpcomingFreeMint[],
  requestedPage: number,
): InlineKeyboard {
  const page = safePage(requestedPage, allMints.length);
  const pages = pageCount(allMints.length);
  const visible = allMints.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  visible.forEach((mint, index) => {
    keyboard.url(`Open #${page * PAGE_SIZE + index + 1}`, mint.openSeaUrl).row();
  });
  if (page > 0) keyboard.text("⬅️ Previous", `free-mints:${view}:${page - 1}`);
  if (page + 1 < pages) keyboard.text("Next ➡️", `free-mints:${view}:${page + 1}`);
  if (page > 0 || page + 1 < pages) keyboard.row();
  keyboard
    .text("🔄 Refresh", `free-mints:${view}:${page}`)
    .text(view === "upcoming" ? "🟢 Live now" : "🕒 Upcoming", `free-mints:${view === "upcoming" ? "live" : "upcoming"}:0`)
    .row()
    .text("🆓 Free mint menu", "menu:free-mints")
    .text("🏠 Main menu", "menu:home");
  return keyboard;
}

async function showDirectory(
  ctx: BotContext,
  dependencies: BotDependencies,
  view: FreeMintDirectoryView,
  page: number,
): Promise<void> {
  const now = new Date();
  try {
    const mints = await findFreeMintDirectory(dependencies.env.OPENSEA_API_KEY, view, now);
    await editMessageSafely(
      ctx,
      formatFreeMintDirectory(view, mints, page, now),
      freeMintDirectoryKeyboard(view, mints, page),
    );
  } catch (error) {
    logger.error({ err: error, view }, "manual OpenSea free mint lookup failed");
    const retry = new InlineKeyboard()
      .text("🔄 Try again", `free-mints:${view}:${page}`)
      .row()
      .text("🆓 Free mint menu", "menu:free-mints")
      .text("🏠 Main menu", "menu:home");
    const detail = error instanceof ExternalServiceError && error.retryable
      ? "OpenSea is temporarily unavailable or rate-limited. Please try again shortly."
      : "The free-mint list could not be loaded. Please try again.";
    await editMessageSafely(ctx, `❌ ${detail}`, retry);
  }
}

export function registerFreeMintCommands(bot: Bot<BotContext>, dependencies: BotDependencies): void {
  bot.command("freemints", async (ctx) => {
    await ctx.reply(FREE_MINTS_MENU_TEXT, { reply_markup: freeMintsMenuKeyboard() });
  });

  bot.callbackQuery("menu:free-mints", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editMessageSafely(ctx, FREE_MINTS_MENU_TEXT, freeMintsMenuKeyboard());
  });

  bot.callbackQuery(/^free-mints:(upcoming|live):(\d+)$/, async (ctx) => {
    const view = ctx.match[1] as FreeMintDirectoryView;
    const page = Number(ctx.match[2]);
    await ctx.answerCallbackQuery({ text: "Refreshing from OpenSea…" });
    await showDirectory(ctx, dependencies, view, page);
  });
}
