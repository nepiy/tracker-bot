import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import { resolveContractDeployment } from "../src/blockchain/deployment.js";

describe("factory/deployer resolution", () => {
  it("uses the outer transaction sender as deployment initiator", async () => {
    const contract = "0x0000000000000000000000000000000000000010" as Address;
    const factory = "0x0000000000000000000000000000000000000020" as Address;
    const initiator = "0x0000000000000000000000000000000000000030" as Address;
    const txHash = `0x${"3".repeat(64)}` as Hash;
    const result = await resolveContractDeployment(
      contract,
      { getContractDeployment: async () => ({ contractCreator: factory, creationTxHash: txHash }) },
      {
        getTransaction: async () => ({ from: initiator }),
        getBytecode: async () => "0x6000",
      },
    );
    expect(result).toMatchObject({
      contractCreator: factory,
      deploymentInitiator: initiator,
      creatorIsContract: true,
    });
  });
});
