import { Bot } from "grammy";
import { logger } from "../config/logger.js";
import type { BotContext, BotDependencies } from "./context.js";
import { registerActivityCommand } from "./commands/activity.js";
import { registerListCommand } from "./commands/list.js";
import { registerStartCommands } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerTrackCommand } from "./commands/track.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { rateLimit } from "./middleware/rateLimit.js";

export function createTelegramBot(dependencies: BotDependencies): Bot<BotContext> {
  const bot = new Bot<BotContext>(dependencies.env.TELEGRAM_BOT_TOKEN);
  bot.use(rateLimit(dependencies.env.TELEGRAM_RATE_LIMIT_PER_MINUTE));
  registerStartCommands(bot);
  registerTrackCommand(bot, dependencies);
  registerListCommand(bot, dependencies);
  registerStopCommand(bot, dependencies);
  registerActivityCommand(bot, dependencies);
  registerWalletCommands(bot, dependencies);
  bot.catch((error) => {
    logger.error({ err: error.error, updateId: error.ctx.update.update_id }, "Telegram bot update failed");
  });
  return bot;
}
