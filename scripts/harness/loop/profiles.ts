import type { LoopKind, LoopSpec } from "./contract.js";

export interface LoopProfile {
  kind: LoopKind;
  allowedPaths: string[];
  comparisons: LoopSpec["comparisons"];
  constraints: string[];
  nextActions: string[];
  maxDurationMs: number;
}

export const loopProfiles: Record<LoopKind, LoopProfile> = {
  ci: {
    kind: "ci",
    allowedPaths: ["src", "frontend", "test"],
    comparisons: [],
    constraints: ["Do not weaken tests, CI configuration or source acceptance machinery"],
    nextActions: [
      "Confirm the failed job still fails on the selected source; inspect its first owning failure",
    ],
    maxDurationMs: 3_600_000,
  },
  product: {
    kind: "product",
    allowedPaths: ["src/catalog", "src/crawler", "src/db", "test"],
    comparisons: ["replay"],
    constraints: [
      "Preserve seller facts and manual corrections; a code repair does not replay production data",
    ],
    nextActions: [
      "Trace the incorrect classification to retained evidence and verify labels with primary sources",
    ],
    maxDurationMs: 3_600_000,
  },
  cost: {
    kind: "cost",
    allowedPaths: ["src/db", "src/crawler", "src/knowledge-catalog", "src/maintenance.ts", "test"],
    comparisons: ["cost"],
    constraints: [
      "Use bounded local fixtures; local cost comparisons do not establish production billing or CPU savings",
    ],
    nextActions: [
      "Identify the owning query or workload and compare frozen baseline and candidate with the same fixture",
    ],
    maxDurationMs: 3_600_000,
  },
  ai: {
    kind: "ai",
    allowedPaths: [
      "src/ai-suggestions",
      "src/db/ai-catalog-repository.ts",
      "src/db/ai-catalog-snapshot.ts",
      "src/db/ai-catalog-verification.ts",
      "test",
    ],
    comparisons: [],
    constraints: [
      "Use candidate-bound recorded responses offline; do not call providers, activate inference or consume regression lessons as fresh holdout data",
    ],
    nextActions: [
      "Separate model quality from runtime validation; preserve invalid responses and unavailable usage as observed",
    ],
    maxDurationMs: 3_600_000,
  },
};
