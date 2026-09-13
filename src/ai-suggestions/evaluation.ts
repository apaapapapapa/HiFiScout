import type { AiCatalogSnapshot, AiEvaluationMetrics } from "../api/admin-ai-contracts.js";
import { validateAiSuggestion } from "./contract.js";

export interface AiEvaluationCase {
  id: string;
  snapshot: AiCatalogSnapshot;
  expectedCatalogProductId: number | null;
}

export function evaluateAiResponses(
  cases: readonly AiEvaluationCase[],
  responses: readonly unknown[],
): AiEvaluationMetrics {
  if (!cases.length || cases.length !== responses.length)
    throw new Error("incomplete_ai_evaluation");
  let correctSuggestions = 0,
    falseSuggestions = 0,
    correctAbstentions = 0,
    missedSuggestions = 0,
    invalidResponses = 0;
  cases.forEach((item, index) => {
    try {
      const result = validateAiSuggestion(item.snapshot, responses[index]);
      if (result.catalogProductId === null) {
        if (item.expectedCatalogProductId === null) correctAbstentions++;
        else missedSuggestions++;
      } else if (result.catalogProductId === item.expectedCatalogProductId) correctSuggestions++;
      else falseSuggestions++;
    } catch {
      invalidResponses++;
    }
  });
  const positive = cases.filter((item) => item.expectedCatalogProductId !== null).length;
  const precision =
    correctSuggestions + falseSuggestions
      ? correctSuggestions / (correctSuggestions + falseSuggestions)
      : null;
  const suggestionRecall = positive ? correctSuggestions / positive : null;
  return {
    total: cases.length,
    correctSuggestions,
    falseSuggestions,
    correctAbstentions,
    missedSuggestions,
    invalidResponses,
    precision,
    suggestionRecall,
    passed:
      positive > 0 &&
      positive < cases.length &&
      falseSuggestions === 0 &&
      invalidResponses === 0 &&
      precision === 1 &&
      suggestionRecall !== null &&
      suggestionRecall >= 0.8,
  };
}
