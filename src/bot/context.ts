import type { Context } from "grammy";
import type { AppEnv } from "../config/env.js";
import type { Repositories } from "../database/repositories/index.js";
import type { TrackingService } from "../services/tracking.js";

export interface BotDependencies {
  env: AppEnv;
  repositories: Repositories;
  tracking: TrackingService;
}

export type BotContext = Context;
