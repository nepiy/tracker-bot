import { parseAbi, zeroAddress, type Address } from "viem";
import type { DeploymentInfo, DevWalletAnalysis, WalletCandidate, WalletEvidence } from "../types/index.js";
import { normalizeAddress } from "../utils/address.js";

export const DEFAULT_EVIDENCE_WEIGHTS: Record<WalletEvidence, number> = {
  contract_deployer: 30,
  deployment_initiator: 25,
  factory_deployment_initiator: 5,
  contract_owner: 25,
  royalty_receiver: 15,
  mint_proceeds_receiver: 25,
  withdrawal_destination: 20,
  treasury: 20,
};

const ownerAbi = parseAbi(["function owner() view returns (address)"]);
const royaltyAbi = parseAbi(["function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)"]);
const addressMethodAbi = (method: string) =>
  parseAbi([`function ${method}() view returns (address)`]);

export interface AnalysisClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

interface SignalDefinition {
  method: string;
  evidence: WalletEvidence;
}

const ADDRESS_SIGNALS: SignalDefinition[] = [
  { method: "primarySaleRecipient", evidence: "mint_proceeds_receiver" },
  { method: "fundsRecipient", evidence: "mint_proceeds_receiver" },
  { method: "withdrawalRecipient", evidence: "withdrawal_destination" },
  { method: "treasury", evidence: "treasury" },
];

export function scoreWalletCandidates(
  evidenceByAddress: Map<Address, Set<WalletEvidence>>,
  weights: Record<WalletEvidence, number> = DEFAULT_EVIDENCE_WEIGHTS,
): WalletCandidate[] {
  return [...evidenceByAddress.entries()]
    .map(([address, evidenceSet]) => {
      const evidence = [...evidenceSet];
      return {
        address,
        evidence,
        score: Math.min(100, evidence.reduce((total, item) => total + weights[item], 0)),
      };
    })
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

function addEvidence(
  map: Map<Address, Set<WalletEvidence>>,
  address: string,
  evidence: WalletEvidence,
): void {
  try {
    const normalized = normalizeAddress(address);
    if (normalized === zeroAddress) return;
    const current = map.get(normalized) ?? new Set<WalletEvidence>();
    current.add(evidence);
    map.set(normalized, current);
  } catch {
    // Contracts sometimes return zero or malformed sentinel values; ignore them.
  }
}

async function safelyReadAddress(
  client: AnalysisClient,
  contractAddress: Address,
  method: string,
): Promise<Address | null> {
  try {
    const value = await client.readContract({
      address: contractAddress,
      abi: addressMethodAbi(method),
      functionName: method,
    });
    return normalizeAddress(String(value));
  } catch {
    return null;
  }
}

export async function analyzeDevWallet(
  contractAddress: Address,
  deployment: DeploymentInfo,
  client: AnalysisClient,
  weights: Record<WalletEvidence, number> = DEFAULT_EVIDENCE_WEIGHTS,
): Promise<DevWalletAnalysis> {
  const evidence = new Map<Address, Set<WalletEvidence>>();
  addEvidence(evidence, deployment.contractCreator, "contract_deployer");
  addEvidence(evidence, deployment.deploymentInitiator, "deployment_initiator");
  if (deployment.creatorIsContract && deployment.deploymentInitiator !== deployment.contractCreator) {
    addEvidence(evidence, deployment.deploymentInitiator, "factory_deployment_initiator");
  }

  try {
    const owner = await client.readContract({ address: contractAddress, abi: ownerAbi, functionName: "owner" });
    addEvidence(evidence, String(owner), "contract_owner");
  } catch {
    // owner() is optional.
  }

  try {
    const royalty = (await client.readContract({
      address: contractAddress,
      abi: royaltyAbi,
      functionName: "royaltyInfo",
      args: [0n, 10n ** 18n],
    })) as readonly [Address, bigint];
    if (royalty[1] > 0n) addEvidence(evidence, royalty[0], "royalty_receiver");
  } catch {
    // ERC-2981 is optional and some contracts reject unknown token IDs.
  }

  const extraSignals = await Promise.all(
    ADDRESS_SIGNALS.map(async (signal) => ({
      ...signal,
      address: await safelyReadAddress(client, contractAddress, signal.method),
    })),
  );
  for (const signal of extraSignals) {
    if (signal.address) addEvidence(evidence, signal.address, signal.evidence);
  }

  const candidates = scoreWalletCandidates(evidence, weights);
  const confidence = candidates[0]?.score ?? 0;
  const confidenceLabel = confidence >= 70 ? "high" : confidence >= 45 ? "medium" : "low";
  const insufficientEvidence = confidence < 45;
  return {
    likelyDevWallet: insufficientEvidence ? null : (candidates[0]?.address ?? null),
    confidence,
    confidenceLabel,
    candidates,
    insufficientEvidence,
  };
}
