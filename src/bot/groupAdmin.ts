import type { BotContext } from "./context.js";

export function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

export function isAdminStatus(status: string): boolean {
  return status === "creator" || status === "administrator";
}

export async function requireGroupAdmin(ctx: BotContext): Promise<boolean> {
  if (!isGroupChat(ctx) || !ctx.chat || !ctx.from) {
    await ctx.reply("This command can only be used in a Telegram group.");
    return false;
  }
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (isAdminStatus(member.status)) return true;
  } catch {
    await ctx.reply("I need to be a group administrator so I can verify who is allowed to manage tracking.");
    return false;
  }
  await ctx.reply("Only a group administrator can manage this group's tracking.");
  return false;
}
