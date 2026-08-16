import type { BotContext } from "./context.js";

const PRIVATE_TRACKING_MESSAGE = [
  "Open a private chat with me to manage personal tracking.",
  "Group admins can use /grouptrack and /grouplist for group collection alerts.",
].join(" ");

export async function requirePrivateTrackingChat(ctx: BotContext): Promise<boolean> {
  if (ctx.chat?.type === "private") return true;
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: PRIVATE_TRACKING_MESSAGE, show_alert: true });
  } else {
    await ctx.reply(PRIVATE_TRACKING_MESSAGE);
  }
  return false;
}
