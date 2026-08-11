import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SubscriptionsRepository } from "../src/database/repositories/subscriptions.js";
import { GroupSubscriptionsRepository } from "../src/database/repositories/groupSubscriptions.js";

class SubscriptionDatabaseFake {
  active = false;
  upserts = 0;

  from() {
    const fake = this;
    const query = {
      select() { return query; },
      eq() { return query; },
      async maybeSingle() {
        return { data: fake.active ? { id: "sub", active: true } : null, error: null };
      },
      async upsert() {
        fake.active = true;
        fake.upserts += 1;
        return { error: null };
      },
    };
    return query;
  }
}

describe("subscription deduplication", () => {
  it("does not write a second active subscription", async () => {
    const database = new SubscriptionDatabaseFake();
    const repository = new SubscriptionsRepository(database as unknown as SupabaseClient);
    await expect(repository.subscribe("user", "collection")).resolves.toEqual({ alreadyActive: false });
    await expect(repository.subscribe("user", "collection")).resolves.toEqual({ alreadyActive: true });
    expect(database.upserts).toBe(1);
  });

  it("deduplicates group subscriptions independently of personal subscriptions", async () => {
    const database = new SubscriptionDatabaseFake();
    const repository = new GroupSubscriptionsRepository(database as unknown as SupabaseClient);
    await expect(repository.subscribe(-100123, "collection")).resolves.toEqual({ alreadyActive: false });
    await expect(repository.subscribe(-100123, "collection")).resolves.toEqual({ alreadyActive: true });
    expect(database.upserts).toBe(1);
  });
});
