import { getEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createDatabaseClient } from "../database/client.js";
import { createRepositories } from "../database/repositories/index.js";
import { TrackingService } from "../services/tracking.js";
import { createTelegramBot } from "./bot.js";
import { EligibilityService } from "../services/eligibility.js";
import { startEligibilityCallbackServer } from "../services/eligibilityCallback.js";

const env = getEnv();
const repositories = createRepositories(createDatabaseClient(env));
const tracking = new TrackingService(env, repositories);
const eligibility = new EligibilityService(env);
const eligibilityCallbackServer = startEligibilityCallbackServer(eligibility, env);
const bot = createTelegramBot({ env, repositories, tracking, eligibility });

const shutdown = () => {
  eligibilityCallbackServer?.close();
  bot.stop();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

logger.info("starting Telegram bot");
await bot.start({
  onStart: ({ username }) => logger.info({ username }, "Telegram bot started"),
});
