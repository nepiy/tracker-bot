import type { SupabaseClient } from "@supabase/supabase-js";
import { safeErrorMessage } from "../../utils/sanitize.js";
import { assertDatabaseResult } from "../client.js";

export interface TelegramOutboxInsert {
  eventKey: string;
  telegramId: number;
  messageText: string;
}

export interface TelegramOutboxItem {
  id: string;
  eventKey: string;
  telegramId: number;
  messageText: string;
  attempts: number;
}

interface TelegramOutboxRow {
  id: string;
  event_key: string;
  telegram_id: number;
  message_text: string;
  attempts: number;
}

function toItem(row: TelegramOutboxRow): TelegramOutboxItem {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    telegramId: Number(row.telegram_id),
    messageText: String(row.message_text),
    attempts: Number(row.attempts),
  };
}

export class TelegramOutboxRepository {
  constructor(private readonly db: SupabaseClient) {}

  async enqueue(notifications: TelegramOutboxInsert[]): Promise<void> {
    if (!notifications.length) return;
    const { error } = await this.db.from("telegram_notification_outbox").upsert(
      notifications.map((notification) => ({
        event_key: notification.eventKey,
        telegram_id: notification.telegramId,
        message_text: notification.messageText,
      })),
      { onConflict: "event_key", ignoreDuplicates: true },
    );
    assertDatabaseResult(error, "enqueue Telegram notifications");
  }

  async releaseStaleClaims(before: Date, now: Date): Promise<void> {
    const { error } = await this.db
      .from("telegram_notification_outbox")
      .update({
        status: "pending",
        claimed_at: null,
        next_attempt_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_error: "Recovered stale delivery claim after watcher interruption",
      })
      .eq("status", "sending")
      .lt("claimed_at", before.toISOString());
    assertDatabaseResult(error, "release stale Telegram notification claims");
  }

  async listPending(now: Date, limit = 100): Promise<TelegramOutboxItem[]> {
    const { data, error } = await this.db
      .from("telegram_notification_outbox")
      .select("id,event_key,telegram_id,message_text,attempts")
      .eq("status", "pending")
      .lte("next_attempt_at", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 250));
    assertDatabaseResult(error, "list pending Telegram notifications");
    return ((data ?? []) as TelegramOutboxRow[]).map(toItem);
  }

  async claim(item: TelegramOutboxItem, claimedAt: Date): Promise<TelegramOutboxItem | null> {
    const { data, error } = await this.db
      .from("telegram_notification_outbox")
      .update({
        status: "sending",
        claimed_at: claimedAt.toISOString(),
        attempts: item.attempts + 1,
        updated_at: claimedAt.toISOString(),
      })
      .eq("id", item.id)
      .eq("status", "pending")
      .lte("next_attempt_at", claimedAt.toISOString())
      .select("id,event_key,telegram_id,message_text,attempts")
      .maybeSingle();
    assertDatabaseResult(error, "claim Telegram notification");
    if (!data) return null;
    return toItem(data as TelegramOutboxRow);
  }

  async markDelivered(id: string, deliveredAt: Date): Promise<void> {
    const { data, error } = await this.db
      .from("telegram_notification_outbox")
      .update({
        status: "delivered",
        claimed_at: null,
        delivered_at: deliveredAt.toISOString(),
        last_error: null,
        updated_at: deliveredAt.toISOString(),
      })
      .eq("id", id)
      .eq("status", "sending")
      .select("id");
    assertDatabaseResult(error, "mark Telegram notification delivered");
    if (data?.length !== 1) throw new Error("Telegram notification delivery state was not updated");
  }

  async release(id: string, error: unknown, nextAttemptAt: Date): Promise<void> {
    const message = safeErrorMessage(error);
    const { data, error: databaseError } = await this.db
      .from("telegram_notification_outbox")
      .update({
        status: "pending",
        claimed_at: null,
        next_attempt_at: nextAttemptAt.toISOString(),
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "sending")
      .select("id");
    assertDatabaseResult(databaseError, "release Telegram notification for retry");
    if (data?.length !== 1) throw new Error("Telegram notification retry state was not updated");
  }

  async pruneDelivered(before: Date): Promise<void> {
    const { error } = await this.db
      .from("telegram_notification_outbox")
      .delete()
      .eq("status", "delivered")
      .lt("delivered_at", before.toISOString());
    assertDatabaseResult(error, "prune delivered Telegram notifications");
  }
}
