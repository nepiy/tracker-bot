import type { Address, Hash } from "viem";

export interface ExplorerDeployment {
  contractCreator: Address;
  creationTxHash: Hash;
}

export interface ExplorerCreatedContract {
  address: Address;
  creationTxHash: Hash;
  createdAt: Date | null;
}

export interface ExplorerCreatedContracts {
  contracts: ExplorerCreatedContract[];
  complete: boolean;
}

export interface ExplorerAdapter {
  getContractDeployment(address: Address): Promise<ExplorerDeployment>;
  getCreatedContracts?(deployer: Address): Promise<ExplorerCreatedContracts>;
}
