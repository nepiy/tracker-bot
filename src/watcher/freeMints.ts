import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import { findUpcomingFreeMints } from "../opensea/upcomingDrops.js";
import { withRetry } from "../utils/retry.js";
import { NotificationService } from "./notifications.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class FreeMintWatcher {
  private readonly notifications: NotificationService;

  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
  ) {
    this.notifications = new NotificationService(env);
  }

  async pollOnce(now = new Date()): Promise<void> {
    const recipients = await this.repositories.users.listFreeMintAlertRecipients();
    if (!recipients.length) return;

    const mints = await withRetry(
      () => findUpcomingFreeMints(this.env.OPENSEA_API_KEY, now),
      {
        attempts: 3,
        onRetry: (error, attempt) => logger.warn({ err: error, attempt }, "retrying OpenSea drop discovery"),
      },
    );

    for (const mint of mints) {
      await Promise.allSettled(recipients.map(async (recipient) => {
        const notificationId = await this.repositories.freeMintNotifications.claim({
          userId: recipient.userId,
          dropSlug: mint.slug,
          stageId: mint.stageId,
          stageStart: mint.startsAt,
        });
        if (!notificationId) return;
        try {
          await this.notifications.sendFreeMint(recipient.telegramId, mint);
        } catch (error) {
          await this.repositories.freeMintNotifications.release(notificationId).catch((releaseError) => {
            logger.error({ err: releaseError, notificationId }, "failed to release free mint notification claim");
          });
          logger.error(
            { err: error, telegramId: recipient.telegramId, dropSlug: mint.slug, stageId: mint.stageId },
            "Telegram free mint notification failed",
          );
          return;
        }
        await this.repositories.freeMintNotifications.markDelivered(notificationId).catch((error) => {
          logger.error(
            { err: error, notificationId, dropSlug: mint.slug, stageId: mint.stageId },
            "failed to mark free mint notification delivered",
          );
        });
      }));
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failureDelayMs = 5_000;
    logger.info({ windowHours: 12 }, "free mint watcher starting");
    while (!signal.aborted) {
      try {
        await this.pollOnce();
        failureDelayMs = 5_000;
        await delay(this.env.FREE_MINT_POLL_INTERVAL_MS, signal);
      } catch (error) {
        logger.error({ err: error, retryInMs: failureDelayMs }, "free mint watcher loop failed");
        await delay(failureDelayMs, signal);
        failureDelayMs = Math.min(failureDelayMs * 2, 60_000);
      }
    }
    logger.info("free mint watcher stopped");
  }
}
