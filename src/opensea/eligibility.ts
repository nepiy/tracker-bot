import { safeDisplayText } from "../utils/display.js";
import { ExternalServiceError } from "../utils/errors.js";
import {
  findEligibilityDropCandidates,
  type EligibilityDropCandidate,
  type EligibilityDropStage,
} from "./upcomingDrops.js";

const OPEN_SEA_API = "https://api.opensea.io/api/v2";

interface OpenSeaEligibilityStageResponse {
  stage_uuid?: string;
  is_eligible?: boolean;
  price?: string;
  max_total_mintable_by_wallet?: string;
  max_total_mintable_by_wallet_per_token?: string;
}

interface OpenSeaEligibilityResponse {
  stages?: OpenSeaEligibilityStageResponse[];
}

export interface EligibleAllowlistStage {
  drop: EligibilityDropCandidate;
  stage: EligibilityDropStage;
  maxMintable: string | null;
}

export interface EligibilityScanResult {
  eligibleStages: EligibleAllowlistStage[];
  scannedDrops: number;
}

function normalizeStageText(stage: EligibilityDropStage): string {
  return `${stage.stageType} ${stage.stageLabel}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

/** Public stages are intentionally excluded from the wallet result. */
export function isAllowlistStage(stage: EligibilityDropStage): boolean {
  const text = normalizeStageText(stage);
  if (/\b(?:gtd|guaranteed|fcfs|first come first served|first come first serve)\b/.test(text)) {
    return true;
  }
  if (/\b(?:allowlist|allow list|whitelist|presale|pre sale|private|reserved|signed)\b/.test(text)) {
    return true;
  }
  const type = stage.stageType.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return type !== "public" && type !== "public sale";
}

async function fetchEligibility(
  slug: string,
  apiKey: string,
  authToken: string,
  fetcher: typeof fetch,
): Promise<OpenSeaEligibilityResponse> {
  const response = await fetcher(`${OPEN_SEA_API}/drops/${encodeURIComponent(slug)}/eligibility`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
      "x-api-key": apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) {
    throw new ExternalServiceError("OpenSea rate limit reached", "opensea", true);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ExternalServiceError("OpenSea wallet authorization expired or was not granted", "opensea", false);
  }
  if (!response.ok) {
    throw new ExternalServiceError(
      `OpenSea returned HTTP ${response.status} while checking eligibility`,
      "opensea",
      response.status >= 500,
    );
  }
  const body = await response.json() as OpenSeaEligibilityResponse;
  return {
    stages: Array.isArray(body.stages) ? body.stages : [],
  };
}

async function inChunks<T, R>(
  values: T[],
  size: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += size) {
    results.push(...await Promise.all(values.slice(index, index + size).map(mapper)));
  }
  return results;
}

/**
 * Checks only active or soon-to-start drops and returns eligible non-public
 * stages. The wallet address is derived from the OpenSea OAuth token, never
 * from a user-provided string.
 */
export async function findEligibleAllowlistStages(
  apiKey: string,
  authToken: string,
  now = new Date(),
  windowHours = 24,
  fetcher: typeof fetch = fetch,
): Promise<EligibilityScanResult> {
  const drops = await findEligibilityDropCandidates(apiKey, now, windowHours, fetcher);
  const checked = await inChunks(drops, 4, async (drop) => {
    const response = await fetchEligibility(drop.slug, apiKey, authToken, fetcher);
    const stageById = new Map(drop.stages.map((stage) => [stage.stageId, stage]));
    const eligible = (response.stages ?? []).flatMap((result) => {
      if (!result.stage_uuid || result.is_eligible !== true) return [];
      const stage = stageById.get(result.stage_uuid);
      if (!stage || !isAllowlistStage(stage)) return [];
      return [{
        drop,
        stage,
        maxMintable: typeof result.max_total_mintable_by_wallet === "string"
          ? result.max_total_mintable_by_wallet
          : null,
      }];
    });
    return eligible;
  });
  return {
    eligibleStages: checked.flat(),
    scannedDrops: drops.length,
  };
}

export function formatEligibilityStageLabel(stage: EligibilityDropStage): string {
  return safeDisplayText(stage.stageLabel || stage.stageType, 200, "Allowlist stage");
}
