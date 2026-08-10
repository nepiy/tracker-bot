import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { analyzeDevWallet, scoreWalletCandidates } from "../src/blockchain/devAnalyzer.js";

const deployer = "0x0000000000000000000000000000000000000001" as Address;
const owner = "0x0000000000000000000000000000000000000002" as Address;

describe("dev wallet confidence scoring", () => {
  it("deduplicates evidence and sorts candidates by score", () => {
    const evidence = new Map<Address, Set<any>>([
      [deployer, new Set(["contract_deployer", "contract_deployer", "contract_owner"])],
      [owner, new Set(["royalty_receiver"])],
    ]);
    const candidates = scoreWalletCandidates(evidence);
    expect(candidates[0]).toMatchObject({ address: deployer, score: 55 });
    expect(candidates[0]?.evidence).toHaveLength(2);
  });

  it("keeps a factory creator separate from its EOA initiator", async () => {
    const contract = "0x0000000000000000000000000000000000000003" as Address;
    const client = {
      readContract: async (args: Record<string, unknown>) => {
        if (args.functionName === "owner") return deployer;
        throw new Error("method unavailable");
      },
    };
    const analysis = await analyzeDevWallet(
      contract,
      {
        contractCreator: owner,
        deploymentInitiator: deployer,
        creationTxHash: `0x${"1".repeat(64)}`,
        creatorIsContract: true,
      },
      client,
    );
    expect(analysis.likelyDevWallet).toBe(deployer);
    expect(analysis.candidates.find((candidate) => candidate.address === owner)?.evidence).toContain("contract_deployer");
    expect(analysis.candidates.find((candidate) => candidate.address === deployer)?.evidence).toContain("factory_deployment_initiator");
  });

  it("returns no likely dev wallet when evidence is weak", async () => {
    const client = { readContract: async () => { throw new Error("missing"); } };
    const analysis = await analyzeDevWallet(
      owner,
      {
        contractCreator: deployer,
        deploymentInitiator: owner,
        creationTxHash: `0x${"2".repeat(64)}`,
        creatorIsContract: false,
      },
      client,
    );
    expect(analysis.insufficientEvidence).toBe(true);
    expect(analysis.likelyDevWallet).toBeNull();
  });
});
