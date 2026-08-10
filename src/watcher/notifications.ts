import { Api } from "grammy";
import { formatEther, type Address, type Hash } from "viem";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { NotificationRecipient } from "../database/repositories/subscriptions.js";
import type { DecodedActivity } from "../types/index.js";
import { getChainById } from "../blockchain/chains.js";

export interface ActivityNotification {
  chainId: number;
  wallet: Address;
  to: Address | null;
  value: bigint;
  hash: Hash;
  decoded: DecodedActivity;
}

export function formatActivityAlert(
  recipient: NotificationRecipient,
  activity: ActivityNotification,
  env: AppEnv,
): string {
  const chain = getChainById(activity.chainId, env);
  const destination = String(activity.decoded.metadata.recipient ?? activity.to ?? "Contract creation");
  const value = activity.value > 0n ? `${formatEther(activity.value)} ${chain.nativeSymbol}` : "0";
  return [
    "🚨 DEV WALLET ACTIVITY",
    "",
    `Collection: ${recipient.collectionName}`,
    `Chain: ${chain.name}`,
    "",
    `Wallet:\n${activity.wallet}`,
    "",
    `Action: ${activity.decoded.label}`,
    `To: ${destination}`,
    ...(activity.value > 0n ? [`Value: ${value}`] : []),
    "",
    `Transaction:\n${activity.hash}`,
    `${chain.explorerUrl}/tx/${activity.hash}`,
  ].join("\n");
}

export class NotificationService {
  private readonly api: Api;

  constructor(private readonly env: AppEnv) {
    this.api = new Api(env.TELEGRAM_BOT_TOKEN);
  }

  async send(recipients: NotificationRecipient[], activity: ActivityNotification): Promise<void> {
    const unique = new Map<string, NotificationRecipient>();
    for (const recipient of recipients) {
      unique.set(`${recipient.telegramId}:${recipient.collectionId}`, recipient);
    }
    await Promise.allSettled(
      [...unique.values()].map(async (recipient) => {
        try {
          await this.api.sendMessage(recipient.telegramId, formatActivityAlert(recipient, activity, this.env), {
            link_preview_options: { is_disabled: true },
          });
        } catch (error) {
          logger.error(
            { err: error, telegramId: recipient.telegramId, chainId: activity.chainId, txHash: activity.hash },
            "Telegram notification failed",
          );
        }
      }),
    );
  }
}
