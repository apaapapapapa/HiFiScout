import { parseModelFactInput } from "../catalog/model-relations.js";
import type { ModelFactWriteInput } from "../catalog/types.js";

export function parseModelFactWrite(value: unknown): ModelFactWriteInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["id", "expectedVersion", "reverify", "fact"].includes(key)))
    return null;
  if (
    body.id !== null &&
    (typeof body.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(body.id))
  )
    return null;
  if (
    body.id === null
      ? body.expectedVersion !== null
      : typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
  )
    return null;
  if (typeof body.reverify !== "boolean") return null;
  const fact = parseModelFactInput(body.fact);
  if (!fact || (body.id === null && fact.state === "removed")) return null;
  return {
    id: body.id as string | null,
    expectedVersion: body.expectedVersion as number | null,
    reverify: body.reverify,
    fact,
  };
}
