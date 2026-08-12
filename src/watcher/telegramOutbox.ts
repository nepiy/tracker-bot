import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import type { TelegramOutboxItem } from "../database/repositories/telegramOutbox.js";
import { withRetry } from "../utils/retry.js";
import { NotificationService } from "./notifications.js";

const STALE_CLAIM_MS = 60 * 1_000;
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function telegramRetryDelayMs(attempts: number): number {
  return Math.min(5_000 * (2 ** Math.max(attempts - 1, 0)), MAX_RETRY_DELAY_MS);
}

export class TelegramOutboxWatcher {
  private readonly notifications: NotificationService;

  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
  ) {
    this.notifications = new NotificationService(env);
  }

  private async deliver(item: TelegramOutboxItem, now: Date): Promise<void> {
    const claimed = await this.repositories.telegramOutbox.claim(item, now);
    if (!claimed) return;

    try {
      await this.notifications.sendText(claimed.telegramId, claimed.messageText);
      await withRetry(
        () => this.repositories.telegramOutbox.markDelivered(claimed.id, new Date()),
        {
          attempts: 3,
          onRetry: (error, attempt) => logger.warn(
            { err: error, attempt, notificationId: claimed.id },
            "retrying Telegram delivery confirmation",
          ),
        },
      );
      logger.info(
        { notificationId: claimed.id, telegramId: claimed.telegramId, attempts: claimed.attempts },
        "delivered queued Telegram notification",
      );
    } catch (error) {
      const retryAt = new Date(Date.now() + telegramRetryDelayMs(claimed.attempts));
      await this.repositories.telegramOutbox.release(claimed.id, error, retryAt).catch((releaseError) => {
        logger.error(
          { err: releaseError, notificationId: claimed.id },
          "failed to release Telegram notification for retry",
        );
      });
      logger.error(
        {
          err: error,
          notificationId: claimed.id,
          telegramId: claimed.telegramId,
          attempts: claimed.attempts,
          retryAt: retryAt.toISOString(),
        },
        "queued Telegram notification delivery failed",
      );
    }
  }

  async pollOnce(now = new Date()): Promise<void> {
    await this.repositories.telegramOutbox.releaseStaleClaims(
      new Date(now.getTime() - STALE_CLAIM_MS),
      now,
    );
    await this.repositories.telegramOutbox.pruneDelivered(
      new Date(now.getTime() - DELIVERED_RETENTION_MS),
    );
    const pending = await this.repositories.telegramOutbox.listPending(now);
    const outcomes = await Promise.allSettled(pending.map((item) => this.deliver(item, now)));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        logger.error({ err: outcome.reason }, "Telegram outbox item processing failed");
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failureDelayMs = 5_000;
    logger.info(
      { pollIntervalMs: this.env.TELEGRAM_OUTBOX_POLL_INTERVAL_MS },
      "Telegram notification outbox starting",
    );
    while (!signal.aborted) {
      try {
        await this.pollOnce();
        failureDelayMs = 5_000;
        await delay(this.env.TELEGRAM_OUTBOX_POLL_INTERVAL_MS, signal);
      } catch (error) {
        logger.error({ err: error, retryInMs: failureDelayMs }, "Telegram notification outbox loop failed");
        await delay(failureDelayMs, signal);
        failureDelayMs = Math.min(failureDelayMs * 2, 60_000);
      }
    }
    logger.info("Telegram notification outbox stopped");
  }
}
