import type { SupabaseClient } from "@supabase/supabase-js";
import { assertDatabaseResult } from "../client.js";

export interface FreeMintNotificationClaim {
  userId: string;
  dropSlug: string;
  stageId: string;
  stageStart: Date;
}

export class FreeMintNotificationsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async claim(notification: FreeMintNotificationClaim): Promise<string | null> {
    const { data, error } = await this.db
      .from("free_mint_notifications")
      .insert({
        user_id: notification.userId,
        drop_slug: notification.dropSlug,
        stage_id: notification.stageId,
        stage_start: notification.stageStart.toISOString(),
      })
      .select("id")
      .single();
    if (error?.code === "23505") return null;
    assertDatabaseResult(error, "claim free mint notification");
    if (!data) throw new Error("Database claim free mint notification returned no row");
    return String(data.id);
  }

  async markDelivered(id: string): Promise<void> {
    const { data, error } = await this.db
      .from("free_mint_notifications")
      .update({ delivered_at: new Date().toISOString() })
      .eq("id", id)
      .is("delivered_at", null)
      .select("id");
    assertDatabaseResult(error, "mark free mint notification delivered");
    if (data?.length !== 1) throw new Error("Free mint notification delivery state was not updated");
  }

  async release(id: string): Promise<void> {
    const { error } = await this.db
      .from("free_mint_notifications")
      .delete()
      .eq("id", id)
      .is("delivered_at", null);
    assertDatabaseResult(error, "release free mint notification claim");
  }

  async releaseStaleClaims(before: Date): Promise<void> {
    const { error } = await this.db
      .from("free_mint_notifications")
      .delete()
      .is("delivered_at", null)
      .lt("claimed_at", before.toISOString());
    assertDatabaseResult(error, "release stale free mint notification claims");
  }
}
