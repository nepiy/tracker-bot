import { getEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createDatabaseClient } from "../database/client.js";
import { createRepositories } from "../database/repositories/index.js";
import { WalletWatcher } from "./watcher.js";

const env = getEnv();
const repositories = createRepositories(createDatabaseClient(env));
const watcher = new WalletWatcher(env, repositories);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await watcher.run(controller.signal);
} catch (error) {
  logger.fatal({ error }, "watcher terminated unexpectedly");
  process.exitCode = 1;
}
