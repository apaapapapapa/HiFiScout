import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  aiCatalogEvaluationCases,
  AI_EVALUATION_CORPUS_VERSION,
} from "../test/fixtures/ai-catalog-evaluation.js";
import { evaluateAiResponses } from "../src/ai-suggestions/evaluation.js";
import { AI_CATALOG_POLICY } from "../src/ai-suggestions/policy.js";
import { isRecord } from "../src/types.js";

/** Analyze explicitly recorded responses; this command never contacts a model. */
export async function evaluateRecordedAiResponses(path: string) {
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(input) || !Array.isArray(input.cases))
    throw new Error("invalid_ai_evaluation_file");
  const responses = new Map<string, unknown>();
  for (const item of input.cases) {
    if (!isRecord(item) || typeof item.id !== "string" || responses.has(item.id))
      throw new Error("invalid_ai_evaluation_case");
    responses.set(item.id, item.response);
  }
  if (
    responses.size !== aiCatalogEvaluationCases.length ||
    aiCatalogEvaluationCases.some((item) => !responses.has(item.id))
  )
    throw new Error("incomplete_ai_evaluation");
  return {
    expectedModel: AI_CATALOG_POLICY.model,
    responseProvenanceVerified: false,
    policy: AI_CATALOG_POLICY,
    corpusVersion: AI_EVALUATION_CORPUS_VERSION,
    recordedAt: new Date().toISOString(),
    inferenceExecuted: false,
    metrics: evaluateAiResponses(
      aiCatalogEvaluationCases,
      aiCatalogEvaluationCases.map((item) => responses.get(item.id)),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2])
    throw new Error("usage: vp exec tsx scripts/evaluate-ai-catalog.ts responses.json");
  const report = await evaluateRecordedAiResponses(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
  if (!report.metrics.passed) process.exitCode = 1;
}
