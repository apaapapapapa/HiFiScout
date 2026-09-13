import type { AiEvaluationCase } from "../../src/ai-suggestions/evaluation.js";

export const AI_HOLDOUT_VERSION = 1;
export interface AiHoldoutCase extends AiEvaluationCase {
  family: string;
  provenance: { sourceFile: string; rationale: string; labelReview: "pending" };
}

// Distinct product families from the TAD/LS50 development canary. Positive spellings are adapted
// from repository regressions; negatives deliberately mutate the candidate, not real seller data.
// These labels need independent review before they can support a live-model approval.
const families = [
  [
    "yamaha",
    "CD-S3000",
    "CD-S3000",
    "YAMAHA CD-S3000 リモコン付",
    "CD-S2000",
    "test/decision-quality.test.ts",
  ],
  [
    "mcintosh",
    "MC275/MK6",
    "MC275MK6",
    "MC275/MK6 【売約済】",
    "MC275",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  ["luxman", "C-10X", "C-10X", "C-10X", "C-10", "test/model-resolver-shop-inputs.test.ts"],
  [
    "accuphase",
    "E-800",
    "E-800",
    "E-800 ※商談中",
    "E-800 SE",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  [
    "bowers-wilkins",
    "805 D4 Signature",
    "805D4 Signature",
    "805 D4 Signature 展示処分品",
    "805D4",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  [
    "mark-levinson",
    "No.326S",
    "No.326S",
    "マークレビンソン No.326S",
    "No.326",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  [
    "luxman",
    "L-507Z",
    "L-507Z",
    "ラックスマン L-507Z 元箱付",
    "L-509Z",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  [
    "denon",
    "DP-200USB-K",
    "DP-200USB-K",
    "DENON DP-200USB-K",
    "DP-200USB",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  [
    "marantz",
    "SA-10 SE",
    "SA-10 SE",
    "MARANTZ SA-10 SE",
    "SA-10",
    "test/model-resolver-shop-inputs.test.ts",
  ],
  [
    "esoteric",
    "N-01XD SE",
    "N-01XD SE",
    "ESOTERIC N-01XD SE",
    "N-01XD",
    "test/model-resolver-shop-inputs.test.ts",
  ],
] as const;

export const aiCatalogHoldoutCases: AiHoldoutCase[] = families.flatMap(
  ([manufacturerId, model, canonical, title, negative, sourceFile], index) =>
    [false, true].map((counterexample) => ({
      id: `holdout-${index + 1}-${counterexample ? "distinct" : "same"}`,
      family: `${manufacturerId}/${canonical}`,
      expectedCatalogProductId: counterexample ? null : 1001 + index,
      provenance: {
        sourceFile,
        labelReview: "pending" as const,
        rationale: counterexample
          ? "Candidate changes a product number or identity-bearing suffix; abstention is expected"
          : "Same product spelling with seller presentation retained",
      },
      snapshot: {
        kind: "catalog_model_lead" as const,
        target: {
          candidateId: index + 1,
          manufacturerId,
          model,
          title,
          rawModels: [model],
          categoryIds: [],
          rejectedBy: ["unresolved_model"],
          revision: "holdout-v1",
        },
        candidates: [
          {
            id: 1001 + index,
            manufacturerId,
            model: counterexample ? negative : canonical,
            categoryIds: [],
            revision: "holdout-v1",
          },
        ],
      },
    })),
);
