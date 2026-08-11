import type { Address, Hash } from "viem";

export type SupportedChainKey = "ethereum" | "base" | "robinhood";
export type ExplorerType = "etherscan" | "blockscout";

export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  openSeaIdentifiers: readonly string[];
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl: string;
  explorerType: ExplorerType;
  nativeSymbol: string;
}

export interface ResolvedCollection {
  name: string;
  slug: string;
  chain: SupportedChainKey;
  chainId: number;
  contractAddress: Address;
}

export interface DeploymentInfo {
  contractCreator: Address;
  deploymentInitiator: Address;
  creationTxHash: Hash;
  creatorIsContract: boolean;
}

export type WalletEvidence =
  | "contract_deployer"
  | "deployment_initiator"
  | "factory_deployment_initiator"
  | "contract_owner"
  | "royalty_receiver"
  | "mint_proceeds_receiver"
  | "withdrawal_destination"
  | "treasury";

export interface WalletCandidate {
  address: Address;
  score: number;
  evidence: WalletEvidence[];
}

export interface DevWalletAnalysis {
  likelyDevWallet: Address | null;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  candidates: WalletCandidate[];
  insufficientEvidence: boolean;
}

export type ActivityType =
  | "native_transfer"
  | "erc20_transfer"
  | "nft_transfer"
  | "swap"
  | "bridge"
  | "contract_interaction";

export interface DecodedActivity {
  type: ActivityType;
  label: string;
  metadata: Record<string, unknown>;
}
