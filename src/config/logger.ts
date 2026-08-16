import pino from "pino";
import { sanitizeLogValue } from "../utils/sanitize.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: (error) => sanitizeLogValue(pino.stdSerializers.err(error)),
  },
  redact: {
    paths: [
      "token",
      "apiKey",
      "serviceRoleKey",
      "authorization",
      "rpcUrl",
      "url",
      "telegramId",
      "chatId",
      "*.token",
      "*.apiKey",
      "*.serviceRoleKey",
      "*.authorization",
      "*.rpcUrl",
      "*.url",
      "*.telegramId",
      "*.chatId",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
});
