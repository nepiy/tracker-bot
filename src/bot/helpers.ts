import type { Context } from "grammy";
import type { AppEnv } from "../config/env.js";
import type { WalletEvidence } from "../types/index.js";
import type { TrackingResult } from "../services/tracking.js";
import { ExternalServiceError, UserFacingError } from "../utils/errors.js";

const EVIDENCE_LABELS: Record<WalletEvidence, string> = {
  contract_deployer: "Contract deployer",
  deployment_initiator: "Deployment transaction initiator",
  factory_deployment_initiator: "Factory deployment initiator",
  contract_owner: "Contract owner",
  royalty_receiver: "Royalty receiver",
  mint_proceeds_receiver: "Mint proceeds receiver",
  withdrawal_destination: "Withdrawal destination",
  treasury: "Treasury",
};

export function formatTrackingResult(result: TrackingResult): string {
  const evidence = result.analysis.candidates.find(
    (candidate) => candidate.address === result.trackedAddress,
  )?.evidence ?? [];
  const confidence = `${result.analysis.confidenceLabel[0]?.toUpperCase()}${result.analysis.confidenceLabel.slice(1)} (${result.analysis.confidence}%)`;
  const status = result.alreadyActive ? "ℹ️ Already tracking" : "✅ Tracking enabled";
  const chainName: Record<number, string> = {
    1: "Ethereum",
    4663: "Robinhood Chain",
  };
  const walletHeading = result.trackingFallback
    ? "Tracked wallet (verified deployment initiator; dev identity unknown)"
    : "Likely Dev/Team Wallet (inferred)";
  const explanation = result.trackingFallback
    ? "\nI couldn't confidently identify a dev/team wallet, so outgoing activity from the verified deployment initiator will be tracked instead."
    : "\nThis wallet is inferred from on-chain signals and is not a verified real-world identity.";
  return [
    status,
    "",
    `Collection: ${result.collection.name}`,
    `Chain: ${chainName[result.collection.chainId] ?? result.collection.chain}`,
    "",
    `Contract (verified by OpenSea):\n${result.collection.contractAddress}`,
    "",
    `Contract creator (verified on-chain):\n${result.deployment.contractCreator}`,
    `Deployment initiator (verified transaction sender):\n${result.deployment.deploymentInitiator}`,
    "",
    `${walletHeading}:\n${result.trackedAddress}`,
    `Confidence: ${confidence}`,
    "",
    "Evidence:",
    ...(evidence.length ? evidence.map((item) => `✓ ${EVIDENCE_LABELS[item]}`) : ["No additional deterministic signals found"]),
    explanation,
  ].join("\n");
}

export async function replyWithError(ctx: Context, error: unknown): Promise<void> {
  if (error instanceof UserFacingError) {
    await ctx.reply(`❌ ${error.message}`);
    return;
  }
  if (error instanceof ExternalServiceError) {
    const suffix = error.retryable ? " Please try again in a moment." : " Check the bot configuration.";
    await ctx.reply(`❌ ${error.service} is unavailable.${suffix}`);
    return;
  }
  await ctx.reply("❌ Something went wrong while processing that collection. Please try again later.");
}

export function explorerTransactionUrl(env: AppEnv, chainId: number, hash: string): string {
  const urls: Record<number, string> = {
    1: "https://etherscan.io",
    4663: "https://robinhoodchain.blockscout.com",
  };
  const base = urls[chainId];
  if (!base) throw new Error(`Unsupported chain ID: ${chainId}`);
  void env;
  return `${base}/tx/${hash}`;
}
