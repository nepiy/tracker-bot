import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { NftPriceAlertRecipient } from "../database/repositories/nftPriceAlerts.js";
import type { Repositories } from "../database/repositories/index.js";
import { getOpenSeaFloorPrice } from "../opensea/floorPrice.js";
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

export function priceTargetReached(
  direction: NftPriceAlertRecipient["direction"],
  currentFloor: number,
  targetPrice: string,
): boolean {
  const target = Number(targetPrice);
  if (!Number.isFinite(currentFloor) || !Number.isFinite(target) || target <= 0) return false;
  return direction === "at_or_below" ? currentFloor <= target : currentFloor >= target;
}

export class NftPriceAlertWatcher {
  private readonly notifications: NotificationService;

  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
  ) {
    this.notifications = new NotificationService(env);
  }

  async pollOnce(now = new Date()): Promise<void> {
    await this.repositories.nftPriceAlerts.releaseStaleClaims(
      new Date(now.getTime() - STALE_CLAIM_MS),
    );
    const alerts = await this.repositories.nftPriceAlerts.listForWatcher();
    if (!alerts.length) return;

    const bySlug = new Map<string, NftPriceAlertRecipient[]>();
    for (const alert of alerts) {
      const group = bySlug.get(alert.slug) ?? [];
      group.push(alert);
      bySlug.set(alert.slug, group);
    }

    for (const [slug, collectionAlerts] of bySlug) {
      const floor = await withRetry(
        () => getOpenSeaFloorPrice(this.env.OPENSEA_API_KEY, slug),
        {
          attempts: 3,
          onRetry: (error, attempt) => logger.warn(
            { err: error, attempt, slug },
            "retrying OpenSea floor-price lookup",
          ),
        },
      ).catch((error) => {
        logger.error({ err: error, slug }, "OpenSea floor-price lookup failed");
        return undefined;
      });
      if (floor === undefined) continue;
      if (!floor) {
        logger.info({ slug }, "OpenSea collection has no active floor price");
        continue;
      }

      const floorValue = String(floor.amount);
      await this.repositories.nftPriceAlerts.recordFloor(slug, floorValue, now);
      const triggered = collectionAlerts.filter((alert) => (
        alert.currencySymbol.toLowerCase() === floor.symbol.toLowerCase()
        && priceTargetReached(alert.direction, floor.amount, alert.targetPrice)
      ));
      logger.debug({
        slug,
        floor: floorValue,
        symbol: floor.symbol,
        evaluatedAlerts: collectionAlerts.length,
        reachedAlerts: triggered.length,
      }, "evaluated NFT floor price targets");

      const outcomes = await Promise.allSettled(triggered.map(async (alert) => {
        const claimed = await this.repositories.nftPriceAlerts.claim(alert.id, now);
        if (!claimed) return;
        try {
          await this.notifications.sendNftPriceTarget(alert.telegramId, {
            alert,
            currentFloor: floorValue,
            currencySymbol: floor.symbol,
          });
        } catch (error) {
          await this.repositories.nftPriceAlerts.release(alert.id).catch((releaseError) => {
            logger.error({ err: releaseError, alertId: alert.id }, "failed to release NFT price alert claim");
          });
          logger.error(
            { err: error, alertId: alert.id, telegramId: alert.telegramId, slug },
            "Telegram NFT price target notification failed",
          );
          return;
        }
        await withRetry(
          () => this.repositories.nftPriceAlerts.markTriggered(alert.id, floorValue, now),
          {
            attempts: 3,
            onRetry: (error, attempt) => logger.warn(
              { err: error, attempt, alertId: alert.id },
              "retrying NFT price alert expiration",
            ),
          },
        );
        logger.info(
          { alertId: alert.id, telegramId: alert.telegramId, slug, floor: floorValue },
          "delivered and expired NFT floor price alert",
        );
      }));
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          logger.error({ err: outcome.reason, slug }, "NFT floor price alert processing failed");
        }
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failureDelayMs = 5_000;
    logger.info({ pollIntervalMs: this.env.PRICE_ALERT_POLL_INTERVAL_MS }, "NFT price alert watcher starting");
    while (!signal.aborted) {
      try {
        await this.pollOnce();
        failureDelayMs = 5_000;
        await delay(this.env.PRICE_ALERT_POLL_INTERVAL_MS, signal);
      } catch (error) {
        logger.error({ err: error, retryInMs: failureDelayMs }, "NFT price alert watcher loop failed");
        await delay(failureDelayMs, signal);
        failureDelayMs = Math.min(failureDelayMs * 2, 60_000);
      }
    }
    logger.info("NFT price alert watcher stopped");
  }
}
