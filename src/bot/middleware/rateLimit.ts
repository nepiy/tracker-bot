import type { MiddlewareFn } from "grammy";
import type { BotContext } from "../context.js";

interface Bucket {
  startedAt: number;
  count: number;
}

export function rateLimit(maxPerMinute: number): MiddlewareFn<BotContext> {
  const buckets = new Map<number, Bucket>();
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const now = Date.now();
    const bucket = buckets.get(userId);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      buckets.set(userId, { startedAt: now, count: 1 });
      if (buckets.size > 10_000) {
        for (const [id, candidate] of buckets) {
          if (now - candidate.startedAt >= 60_000) buckets.delete(id);
        }
      }
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      await ctx.reply("⏳ You're sending requests too quickly. Please wait a minute and try again.");
      return;
    }
    return next();
  };
}
