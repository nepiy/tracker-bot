import type { SupabaseClient } from "@supabase/supabase-js";
import { assertDatabaseResult } from "../client.js";

export interface UserRow {
  id: string;
  telegram_id: number;
  free_mint_alerts_enabled: boolean;
}

export interface FreeMintAlertRecipient {
  userId: string;
  telegramId: number;
}

export class UsersRepository {
  constructor(private readonly db: SupabaseClient) {}

  async ensure(telegramId: number): Promise<UserRow> {
    const { data, error } = await this.db
      .from("users")
      .upsert({ telegram_id: telegramId }, { onConflict: "telegram_id", ignoreDuplicates: false })
      .select("id,telegram_id,free_mint_alerts_enabled")
      .single();
    assertDatabaseResult(error, "upsert user");
    return data as UserRow;
  }

  async setFreeMintAlerts(telegramId: number, enabled: boolean): Promise<UserRow> {
    const { data, error } = await this.db
      .from("users")
      .upsert(
        { telegram_id: telegramId, free_mint_alerts_enabled: enabled },
        { onConflict: "telegram_id", ignoreDuplicates: false },
      )
      .select("id,telegram_id,free_mint_alerts_enabled")
      .single();
    assertDatabaseResult(error, "update free mint alert preference");
    return data as UserRow;
  }

  async listFreeMintAlertRecipients(): Promise<FreeMintAlertRecipient[]> {
    const { data, error } = await this.db
      .from("users")
      .select("id,telegram_id")
      .eq("free_mint_alerts_enabled", true);
    assertDatabaseResult(error, "list free mint alert recipients");
    return (data ?? []).map((row) => ({
      userId: String(row.id),
      telegramId: Number(row.telegram_id),
    }));
  }
}
