import { Bot } from "grammy";
import { logger } from "../config/logger.js";
import type { BotContext, BotDependencies } from "./context.js";
import { registerActivityCommand } from "./commands/activity.js";
import { registerListCommand } from "./commands/list.js";
import { registerStartCommands } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerTrackCommand, requestOpenSeaLink } from "./commands/track.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerGroupCommands } from "./commands/group.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerInfoCommand } from "./commands/info.js";
import { registerNftPriceAlertCommands } from "./commands/priceAlerts.js";

export function createTelegramBot(dependencies: BotDependencies): Bot<BotContext> {
  const bot = new Bot<BotContext>(dependencies.env.TELEGRAM_BOT_TOKEN);
  bot.use(rateLimit(dependencies.env.TELEGRAM_RATE_LIMIT_PER_MINUTE));
  registerStartCommands(bot);
  registerNftPriceAlertCommands(bot, dependencies);
  registerInfoCommand(bot, dependencies);
  registerTrackCommand(bot, dependencies);
  registerGroupCommands(bot, dependencies, requestOpenSeaLink);
  registerListCommand(bot, dependencies);
  registerStopCommand(bot, dependencies);
  registerActivityCommand(bot, dependencies);
  registerWalletCommands(bot, dependencies);
  registerSettingsCommand(bot, dependencies);
  bot.catch((error) => {
    logger.error({ err: error.error, updateId: error.ctx.update.update_id }, "Telegram bot update failed");
  });
  return bot;
}
