/**
 * Cross-domain primitives.
 *
 * Deliberately tiny: only shapes and narrowing helpers that every domain needs.
 * Domain vocabulary lives in `src/catalog/types.ts`, `src/crawler/types.ts` and
 * `src/db/types.ts`.
 */

/** A value that survives `JSON.parse`/`JSON.stringify` unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];

/**
 * Narrows an untrusted value (JSON blob, D1 column, queue body) to a plain keyed object.
 *
 * Arrays are rejected, so this is a STRICTER guard than a bare `typeof value === "object"`.
 * Check each substitution individually: several existing guards in `src/` omit the array test
 * (e.g. the `categoryClassification` block in `product-normalizer.applyCategoryClassification`),
 * and swapping `isRecord` in there would change runtime behaviour.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `catch (error)` binds `unknown` under `strict`. This reproduces the existing
 * `error?.message || String(error)` behaviour without an assertion.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message;
  return String(error);
}
