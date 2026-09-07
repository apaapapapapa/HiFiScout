export interface ModelFactInput {
  kind: "successor" | "variant" | "family";
  relatedProductId: number | null;
  familyName: string;
  position: number | null;
  state: "candidate" | "verified" | "rejected" | "removed";
  sourceId: number | null;
  manualNote: string;
  manufacturerJustification: string;
}

export function parseModelFactInput(value: unknown): ModelFactInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "kind",
          "relatedProductId",
          "familyName",
          "position",
          "state",
          "sourceId",
          "manualNote",
          "manufacturerJustification",
        ].includes(key),
    )
  )
    return null;
  const positiveId = (id: unknown): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  if (input.kind !== "family" && input.kind !== "successor" && input.kind !== "variant")
    return null;
  if (
    input.state !== "candidate" &&
    input.state !== "verified" &&
    input.state !== "rejected" &&
    input.state !== "removed"
  )
    return null;
  if (input.sourceId !== null && !positiveId(input.sourceId)) return null;
  if (
    typeof input.manualNote !== "string" ||
    input.manualNote.length > 1000 ||
    typeof input.manufacturerJustification !== "string" ||
    input.manufacturerJustification.length > 1000
  )
    return null;
  if (typeof input.familyName !== "string" || input.familyName.length > 100) return null;
  if (input.kind === "family") {
    if (
      !input.familyName.trim() ||
      input.relatedProductId !== null ||
      (input.position !== null &&
        (!Number.isInteger(input.position) ||
          Number(input.position) < 0 ||
          Number(input.position) > 1000))
    )
      return null;
  } else if (
    !positiveId(input.relatedProductId) ||
    input.position !== null ||
    input.familyName !== ""
  )
    return null;
  const manualNote = input.manualNote.trim();
  if (input.state === "verified" && input.sourceId === null && manualNote.length < 10) return null;
  return {
    kind: input.kind,
    relatedProductId: input.relatedProductId as number | null,
    familyName: input.familyName.normalize("NFKC").trim(),
    position: input.position as number | null,
    state: input.state,
    sourceId: input.sourceId as number | null,
    manualNote,
    manufacturerJustification: input.manufacturerJustification.trim(),
  };
}
