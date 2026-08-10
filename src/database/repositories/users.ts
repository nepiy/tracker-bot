import type { SupabaseClient } from "@supabase/supabase-js";
import { assertDatabaseResult } from "../client.js";

export interface UserRow {
  id: string;
  telegram_id: number;
}

export class UsersRepository {
  constructor(private readonly db: SupabaseClient) {}

  async ensure(telegramId: number): Promise<UserRow> {
    const { data, error } = await this.db
      .from("users")
      .upsert({ telegram_id: telegramId }, { onConflict: "telegram_id", ignoreDuplicates: false })
      .select("id,telegram_id")
      .single();
    assertDatabaseResult(error, "upsert user");
    return data as UserRow;
  }
}
