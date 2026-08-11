import type { Address } from "viem";
import type { AppEnv } from "../config/env.js";
import { getCexAddressBook } from "../config/monitoring.js";
import type { DecodedActivity } from "../types/index.js";

export interface RiskAssessmentInput {
  chainId: number;
  to: Address | null;
  value: bigint;
  balanceBefore: bigint | null;
  decoded: DecodedActivity;
}

export interface RiskAssessment {
  highRisk: boolean;
  reasons: string[];
  cexLabel: string | null;
  balancePercentage: string | null;
}

function destinationAddress(input: RiskAssessmentInput): string | null {
  const recipient = input.decoded.metadata.recipient;
  if (typeof recipient === "string" && /^0x[0-9a-fA-F]{40}$/.test(recipient)) return recipient.toLowerCase();
  return input.to?.toLowerCase() ?? null;
}

function formatPercentage(value: bigint, balance: bigint): string {
  const basisPoints = value * 10_000n / balance;
  return `${basisPoints / 100n}.${String(basisPoints % 100n).padStart(2, "0")}%`;
}

export function assessActivityRisk(input: RiskAssessmentInput, env: AppEnv): RiskAssessment {
  const reasons: string[] = [];
  let balancePercentage: string | null = null;
  if (input.balanceBefore && input.balanceBefore > 0n && input.value * 100n > input.balanceBefore * 90n) {
    balancePercentage = formatPercentage(input.value, input.balanceBefore);
    reasons.push(`Sent ${balancePercentage} of the pre-transaction native balance`);
  }
  if (input.decoded.type === "bridge") reasons.push("Bridge-out transaction detected");

  const destination = destinationAddress(input);
  const cexLabel = destination
    ? getCexAddressBook(env).get(`${input.chainId}:${destination}`) ?? null
    : null;
  if (cexLabel) reasons.push(`Destination matches configured CEX: ${cexLabel}`);
  return { highRisk: reasons.length > 0, reasons, cexLabel, balancePercentage };
}
