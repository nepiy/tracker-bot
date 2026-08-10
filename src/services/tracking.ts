import type { Address } from "viem";
import { analyzeDevWallet } from "../blockchain/devAnalyzer.js";
import { getChainById } from "../blockchain/chains.js";
import { createChainClient } from "../blockchain/clients.js";
import { resolveContractDeployment } from "../blockchain/deployment.js";
import type { AppEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { Repositories } from "../database/repositories/index.js";
import { createExplorer } from "../explorers/index.js";
import { resolveOpenSeaCollection } from "../opensea/resolveCollection.js";
import type { DeploymentInfo, DevWalletAnalysis, ResolvedCollection, WalletEvidence } from "../types/index.js";
import { withRetry } from "../utils/retry.js";

export interface TrackingResult {
  collection: ResolvedCollection;
  deployment: DeploymentInfo;
  analysis: DevWalletAnalysis;
  trackedAddress: Address;
  trackingFallback: boolean;
  alreadyActive: boolean;
}

const EVIDENCE_RELATIONSHIP: Partial<Record<WalletEvidence, string>> = {
  contract_deployer: "contract_creator",
  deployment_initiator: "deployment_initiator",
  contract_owner: "contract_owner",
  royalty_receiver: "royalty_receiver",
  mint_proceeds_receiver: "mint_proceeds_receiver",
  withdrawal_destination: "withdrawal_destination",
  treasury: "treasury",
};

export class TrackingService {
  constructor(
    private readonly env: AppEnv,
    private readonly repositories: Repositories,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async track(telegramId: number, url: string): Promise<TrackingResult> {
    const collection = await withRetry(
      () => resolveOpenSeaCollection(url, this.env, this.fetcher),
      { attempts: 3, onRetry: (error, attempt) => logger.warn({ err: error, attempt }, "retrying OpenSea resolution") },
    );
    logger.info(
      { slug: collection.slug, chainId: collection.chainId, contract: collection.contractAddress },
      "resolved OpenSea collection",
    );

    const chain = getChainById(collection.chainId, this.env);
    const client = createChainClient(chain);
    const explorer = createExplorer(chain, this.env);
    const deployment = await withRetry(
      () => resolveContractDeployment(collection.contractAddress, explorer, client),
      { attempts: 3, onRetry: (error, attempt) => logger.warn({ err: error, attempt, chainId: chain.chainId }, "retrying deployment resolution") },
    );
    logger.info({ ...deployment, contract: collection.contractAddress }, "resolved contract deployment");

    const analysis = await analyzeDevWallet(collection.contractAddress, deployment, client);
    const trackedAddress = analysis.likelyDevWallet ?? deployment.deploymentInitiator;
    const trackingFallback = analysis.likelyDevWallet === null;
    logger.info(
      {
        contract: collection.contractAddress,
        likelyDevWallet: analysis.likelyDevWallet,
        confidence: analysis.confidence,
        fallback: trackingFallback,
      },
      "completed dev wallet analysis",
    );

    const [user, storedCollection] = await Promise.all([
      this.repositories.users.ensure(telegramId),
      this.repositories.collections.upsert(collection),
    ]);

    for (const candidate of analysis.candidates) {
      const wallet = await this.repositories.wallets.upsert(collection.chainId, candidate.address);
      for (const item of candidate.evidence) {
        const relationship = EVIDENCE_RELATIONSHIP[item];
        if (relationship) {
          await this.repositories.wallets.linkCollection(
            storedCollection.id,
            wallet.id,
            relationship,
            candidate.score,
            candidate.evidence,
          );
        }
      }
    }

    const watchedWallet = await this.repositories.wallets.upsert(collection.chainId, trackedAddress);
    await this.repositories.wallets.linkCollection(
      storedCollection.id,
      watchedWallet.id,
      trackingFallback ? "tracked_fallback" : "likely_dev",
      analysis.confidence,
      analysis.candidates.find((candidate) => candidate.address === trackedAddress)?.evidence ?? [],
    );
    const subscription = await this.repositories.subscriptions.subscribe(user.id, storedCollection.id);

    return {
      collection,
      deployment,
      analysis,
      trackedAddress,
      trackingFallback,
      alreadyActive: subscription.alreadyActive,
    };
  }
}
