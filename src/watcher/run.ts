import { getEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createDatabaseClient } from "../database/client.js";
import { createRepositories } from "../database/repositories/index.js";
import { WalletWatcher } from "./watcher.js";
import { FreeMintWatcher } from "./freeMints.js";
import { NftPriceAlertWatcher } from "./nftPriceAlerts.js";

const env = getEnv();
const repositories = createRepositories(createDatabaseClient(env));
const watcher = new WalletWatcher(env, repositories);
const freeMintWatcher = new FreeMintWatcher(env, repositories);
const nftPriceAlertWatcher = new NftPriceAlertWatcher(env, repositories);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await Promise.all([
    watcher.run(controller.signal),
    freeMintWatcher.run(controller.signal),
    nftPriceAlertWatcher.run(controller.signal),
  ]);
} catch (error) {
  logger.fatal({ err: error }, "watcher terminated unexpectedly");
  process.exitCode = 1;
}
