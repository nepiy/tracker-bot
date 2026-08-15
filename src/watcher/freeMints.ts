import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import {
  findUpcomingMintStages,
  getOpenSeaTokenDetails,
  isFreeMintPrice,
  type UpcomingMintStage,
} from "../opensea/upcomingDrops.js";
import { withRetry } from "../utils/retry.js";
import { NotificationService } from "./notifications.js";

const STALE_CLAIM_MS = 60 * 1_000;

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
    this.notifications = new NotificationService(env, repositories.telegramOutbox);
  }

  async pollOnce(now = new Date()): Promise<void> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    await Promise.all([
      this.repositories.freeMintNotifications.releaseStaleClaims(staleBefore),
      this.repositories.mintPriceChangeNotifications.releaseStaleClaims(staleBefore),
    ]);
    const recipients = await this.repositories.users.listFreeMintAlertRecipients();
    if (!recipients.length) return;

    const stages = await withRetry(
      () => findUpcomingMintStages(this.env.OPENSEA_API_KEY, now, this.env.FREE_MINT_LOOKAHEAD_HOURS),
      {
        attempts: 3,
        onRetry: (error, attempt) => logger.warn({ err: error, attempt }, "retrying OpenSea drop discovery"),
      },
    );

    for (const stage of stages) {
      const observation = await this.repositories.mintStagePrices.observe(stage);
      if (isFreeMintPrice(stage.price)) {
        await this.sendFreeMint(stage, recipients);
      }
      if (observation.freeToPaid) {
        logger.info(
          { dropSlug: stage.slug, stageId: stage.stageId, priceVersion: observation.priceVersion },
          "recorded OpenSea free-to-paid mint transition",
        );
      }
    }

    const priceChanges = await this.repositories.mintStagePrices.listFreeToPaidEvents(stages);
    for (const priceChange of priceChanges) {
      await this.sendPriceChange(priceChange.stage, priceChange.priceVersion, recipients);
    }
  }

  private async sendFreeMint(
    mint: UpcomingMintStage,
    recipients: Awaited<ReturnType<Repositories["users"]["listFreeMintAlertRecipients"]>>,
  ): Promise<void> {
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

  private async sendPriceChange(
    stage: UpcomingMintStage,
    priceVersion: number,
    recipients: Awaited<ReturnType<Repositories["users"]["listFreeMintAlertRecipients"]>>,
  ): Promise<void> {
    const token = await withRetry(
      () => getOpenSeaTokenDetails(
        this.env.OPENSEA_API_KEY,
        stage.chain,
        stage.currencyAddress,
      ),
      { attempts: 2 },
    ).catch((error) => {
      logger.warn(
        { err: error, chain: stage.chain, currencyAddress: stage.currencyAddress },
        "could not resolve OpenSea mint payment token",
      );
      return null;
    });

    await Promise.allSettled(recipients.map(async (recipient) => {
      const notificationId = await this.repositories.mintPriceChangeNotifications.claim(
        recipient.userId,
        stage,
        priceVersion,
      );
      if (!notificationId) return;
      try {
        await this.notifications.sendMintPriceChange(recipient.telegramId, { stage, token }, priceVersion);
      } catch (error) {
        await this.repositories.mintPriceChangeNotifications.release(notificationId).catch((releaseError) => {
          logger.error({ err: releaseError, notificationId }, "failed to release mint price-change claim");
        });
        logger.error(
          { err: error, telegramId: recipient.telegramId, dropSlug: stage.slug, stageId: stage.stageId },
          "Telegram mint price-change notification failed",
        );
        return;
      }
      await this.repositories.mintPriceChangeNotifications.markDelivered(notificationId).catch((error) => {
        logger.error(
          { err: error, notificationId, dropSlug: stage.slug, stageId: stage.stageId },
          "failed to mark mint price-change notification delivered",
        );
      });
    }));
  }

  async run(signal: AbortSignal): Promise<void> {
    let failureDelayMs = 5_000;
    logger.info({
      windowHours: this.env.FREE_MINT_LOOKAHEAD_HOURS,
      pollIntervalMs: this.env.FREE_MINT_POLL_INTERVAL_MS,
    }, "free mint watcher starting");
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
