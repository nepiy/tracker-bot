import type { Address, Hash } from "viem";
import type { ChainClient } from "./clients.js";
import type { DeploymentInfo } from "../types/index.js";
import type { ExplorerAdapter } from "../explorers/types.js";
import { normalizeAddress } from "../utils/address.js";

export interface DeploymentClient {
  getTransaction(args: { hash: Hash }): Promise<{ from: Address }>;
  getBytecode(args: { address: Address }): Promise<`0x${string}` | undefined>;
}

export async function resolveContractDeployment(
  contractAddress: Address,
  explorer: ExplorerAdapter,
  client: DeploymentClient | ChainClient,
): Promise<DeploymentInfo> {
  const deployment = await explorer.getContractDeployment(contractAddress);
  const [transaction, creatorBytecode] = await Promise.all([
    client.getTransaction({ hash: deployment.creationTxHash }),
    client.getBytecode({ address: deployment.contractCreator }),
  ]);

  return {
    contractCreator: deployment.contractCreator,
    deploymentInitiator: normalizeAddress(transaction.from),
    creationTxHash: deployment.creationTxHash,
    creatorIsContract: Boolean(creatorBytecode && creatorBytecode !== "0x"),
  };
}
