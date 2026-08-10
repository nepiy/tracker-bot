import type { Address, Hash } from "viem";

export interface ExplorerDeployment {
  contractCreator: Address;
  creationTxHash: Hash;
}

export interface ExplorerAdapter {
  getContractDeployment(address: Address): Promise<ExplorerDeployment>;
}
