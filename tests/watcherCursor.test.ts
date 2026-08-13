import { describe, expect, it } from "vitest";
import { selectWatcherResumeBlock, selectWatcherScanBatchSize } from "../src/watcher/watcher.js";

describe("watcher cursor recovery", () => {
  it("keeps a cursor that is within the configured backlog", () => {
    expect(selectWatcherResumeBlock(9_500n, 10_000n, 5_000n, 10n)).toBe(9_500n);
  });

  it("fast-forwards a stale cursor to the recent lookback window", () => {
    expect(selectWatcherResumeBlock(1_000n, 10_000n, 5_000n, 10n)).toBe(9_990n);
  });

  it("clamps a cursor when an RPC head moves backwards", () => {
    expect(selectWatcherResumeBlock(10_001n, 10_000n, 5_000n, 10n)).toBe(10_000n);
  });
});

describe("watcher scan checkpointing", () => {
  it("uses provider-compatible five-block checkpoints while wallet marketplace tracking is active", () => {
    expect(selectWatcherScanBatchSize(250n, true)).toBe(5n);
    expect(selectWatcherScanBatchSize(5n, true)).toBe(5n);
  });

  it("keeps the configured batch size without marketplace wallets", () => {
    expect(selectWatcherScanBatchSize(250n, false)).toBe(250n);
  });
});
