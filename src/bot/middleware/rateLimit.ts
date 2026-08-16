import type { MiddlewareFn } from "grammy";
import type { BotContext } from "../context.js";

interface Bucket {
  startedAt: number;
  count: number;
}

async function notifyThrottled(ctx: BotContext, message: string): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
  } else if (ctx.chat) {
    await ctx.reply(message);
  }
}

export const MAX_RATE_LIMIT_BUCKETS = 10_000;

export function rateLimit(
  maxPerMinute: number,
  maxBuckets = MAX_RATE_LIMIT_BUCKETS,
  globalMaxPerMinute = 240,
  maxConcurrentUpdates = 20,
): MiddlewareFn<BotContext> {
  const buckets = new Map<number, Bucket>();
  const globalLimit = Math.max(1, globalMaxPerMinute);
  let globalBucket: Bucket = { startedAt: Date.now(), count: 0 };
  let lastGlobalNoticeAt = 0;
  let lastConcurrencyNoticeAt = 0;
  let inFlight = 0;
  return async (ctx, next) => {
    const now = Date.now();
    const continueUpdate = async (): Promise<void> => {
      if (inFlight >= Math.max(1, maxConcurrentUpdates)) {
        if (now - lastConcurrencyNoticeAt >= 5_000) {
          lastConcurrencyNoticeAt = now;
          await notifyThrottled(ctx, "⏳ The bot is busy. Please try again shortly.");
        }
        return;
      }
      inFlight += 1;
      try {
        await next();
      } finally {
        inFlight -= 1;
      }
    };
    if (now - globalBucket.startedAt >= 60_000) {
      globalBucket = { startedAt: now, count: 0 };
    }
    globalBucket.count += 1;
    if (globalBucket.count > globalLimit) {
      if (now - lastGlobalNoticeAt >= 5_000) {
        lastGlobalNoticeAt = now;
        await notifyThrottled(ctx, "⏳ The bot is handling unusually high traffic. Please try again shortly.");
      }
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) return continueUpdate();
    const bucket = buckets.get(userId);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      if (!bucket) {
        for (const [id, candidate] of buckets) {
          if (now - candidate.startedAt >= 60_000) buckets.delete(id);
        }
        const limit = Math.max(1, maxBuckets);
        while (buckets.size >= limit) {
          const oldestId = buckets.keys().next().value as number | undefined;
          if (oldestId === undefined) break;
          buckets.delete(oldestId);
        }
      }
      buckets.set(userId, { startedAt: now, count: 1 });
      return continueUpdate();
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      if (bucket.count === maxPerMinute + 1) {
        await notifyThrottled(ctx, "⏳ You're sending requests too quickly. Please wait a minute and try again.");
      }
      return;
    }
    return continueUpdate();
  };
}
