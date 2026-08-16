import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResolvedCollection } from "../../types/index.js";
import { safeDisplayText } from "../../utils/display.js";
import { assertDatabaseResult } from "../client.js";

export interface CollectionRow {
  id: string;
  opensea_slug: string;
  name: string;
  chain: string;
  chain_id: number;
  contract_address: string;
}

export class CollectionsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async upsert(collection: ResolvedCollection): Promise<CollectionRow> {
    const { data, error } = await this.db
      .from("collections")
      .upsert(
        {
          opensea_slug: collection.slug,
          name: safeDisplayText(collection.name, 300, collection.slug),
          chain: collection.chain,
          chain_id: collection.chainId,
          contract_address: collection.contractAddress,
        },
        { onConflict: "opensea_slug" },
      )
      .select("id,opensea_slug,name,chain,chain_id,contract_address")
      .single();
    assertDatabaseResult(error, "upsert collection");
    return data as CollectionRow;
  }
}
