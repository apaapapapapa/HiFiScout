/** Changing any inference setting requires a new evaluation approval. */
export const AI_CATALOG_POLICY = Object.freeze({
  model: "@cf/qwen/qwen3-30b-a3b-fp8",
  kind: "catalog_model_lead" as const,
  promptVersion: 1,
  schemaVersion: 1,
  maxJobsPerDay: 25,
  maxAttempts: 2,
  maxInputTokens: 2000,
  maxRequestBytes: 1744,
  maxOutputTokens: 300,
  maxResponseBytes: 4096,
  maxCandidates: 5,
  maxNeuronsPerDay: 1000,
  inputNeuronsPerMillion: 4625,
  outputNeuronsPerMillion: 30475,
  retentionDays: 180,
});

/** Round upwards; never release reservations after timeouts or unknown usage. */
export function aiReservationMilliNeurons(): number {
  return Math.ceil(
    (AI_CATALOG_POLICY.maxInputTokens * AI_CATALOG_POLICY.inputNeuronsPerMillion +
      AI_CATALOG_POLICY.maxOutputTokens * AI_CATALOG_POLICY.outputNeuronsPerMillion) /
      1000,
  );
}

export function aiUsageMilliNeurons(inputTokens: number, outputTokens: number): number | null {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  )
    return null;
  return Math.ceil(
    (inputTokens * AI_CATALOG_POLICY.inputNeuronsPerMillion +
      outputTokens * AI_CATALOG_POLICY.outputNeuronsPerMillion) /
      1000,
  );
}

export function aiBudgetDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export const AI_CATALOG_POLICY_KEY = JSON.stringify(AI_CATALOG_POLICY);
