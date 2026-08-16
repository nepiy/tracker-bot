import { describe, expect, it, vi } from "vitest";
import { findEligibleAllowlistStages, isAllowlistStage } from "../src/opensea/eligibility.js";
import { findEligibilityDropCandidates } from "../src/opensea/upcomingDrops.js";
import type { EligibilityDropStage } from "../src/opensea/upcomingDrops.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const stage = (overrides: Partial<EligibilityDropStage> = {}): EligibilityDropStage => ({
  stageId: "allowlist-stage",
  stageType: "allowlist",
  stageLabel: "FCFS allowlist",
  price: "0",
  currencyAddress: "0x0000000000000000000000000000000000000000",
  startsAt: new Date("2026-08-16T12:00:00Z"),
  endsAt: new Date("2026-08-16T14:00:00Z"),
  ...overrides,
});

describe("OpenSea wallet eligibility", () => {
  it("keeps public-only stages out while accepting GTD and FCFS labels", () => {
    expect(isAllowlistStage(stage({ stageType: "public_sale", stageLabel: "Public mint" }))).toBe(false);
    expect(isAllowlistStage(stage({ stageType: "public_sale", stageLabel: "GTD" }))).toBe(true);
    expect(isAllowlistStage(stage({ stageType: "signed_mint", stageLabel: "FCFS" }))).toBe(true);
  });

  it("joins authenticated eligibility to drop stages and filters public eligibility", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/drops")) {
        return jsonResponse({
          drops: [{
            collection_slug: "allowlisted-drop",
            collection_name: "Allowlisted Drop",
            chain: "ethereum",
            is_minting: false,
            next_stage: {
              uuid: "allowlist-stage",
              stage_type: "allowlist",
              label: "FCFS allowlist",
              price: "0",
              price_currency_address: "0x0000000000000000000000000000000000000000",
              start_time: "2026-08-16T12:00:00Z",
              end_time: "2026-08-16T14:00:00Z",
            },
          }],
          next: null,
        });
      }
      if (url.pathname.endsWith("/eligibility")) {
        return jsonResponse({ stages: [
          { stage_uuid: "allowlist-stage", is_eligible: true, max_total_mintable_by_wallet: "2" },
          { stage_uuid: "public-stage", is_eligible: true },
        ] });
      }
      return jsonResponse({
        collection_slug: "allowlisted-drop",
        collection_name: "Allowlisted Drop",
        chain: "ethereum",
        is_minting: false,
        stages: [{
          uuid: "allowlist-stage",
          stage_type: "allowlist",
          label: "FCFS allowlist",
          price: "0",
          price_currency_address: "0x0000000000000000000000000000000000000000",
          start_time: "2026-08-16T12:00:00Z",
          end_time: "2026-08-16T14:00:00Z",
        }],
      });
    });

    const result = await findEligibleAllowlistStages(
      "api-key",
      "wallet-token",
      new Date("2026-08-16T10:00:00Z"),
      24,
      fetcher,
    );
    expect(result.scannedDrops).toBe(1);
    expect(result.eligibleStages).toHaveLength(1);
    expect(result.eligibleStages[0]?.drop.name).toBe("Allowlisted Drop");
    expect(result.eligibleStages[0]?.maxMintable).toBe("2");
    expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith("/eligibility")
      && new Headers((init as RequestInit).headers).get("authorization") === "Bearer wallet-token")).toBe(true);
  });

  it("uses a detail lookup when a newly listed calendar item has no summary stage", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/drops")) {
        return jsonResponse({
          drops: [{
            collection_slug: "newly-listed-drop",
            collection_name: "Newly Listed Drop",
            chain: "ethereum",
            is_minting: false,
          }],
          next: null,
        });
      }
      return jsonResponse({
        collection_slug: "newly-listed-drop",
        collection_name: "Newly Listed Drop",
        chain: "ethereum",
        is_minting: false,
        stages: [{
          uuid: "new-stage",
          stage_type: "allowlist",
          label: "GTD",
          price: "0",
          price_currency_address: "0x0000000000000000000000000000000000000000",
          start_time: "2026-08-16T12:00:00Z",
          end_time: "2026-08-16T14:00:00Z",
        }],
      });
    });

    const result = await findEligibilityDropCandidates(
      "api-key",
      new Date("2026-08-16T10:00:00Z"),
      24,
      fetcher,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.stages[0]?.stageLabel).toBe("GTD");
  });
});
