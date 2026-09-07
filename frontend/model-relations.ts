import type { CatalogRelationProof, ProductModelRelations, RelatedCatalogModel } from "../src/api/contracts.js";
import { validProductKey } from "./product-permalink.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCatalogRelationProof(value: unknown): value is CatalogRelationProof {
  if (!record(value) || (value.kind !== "source" && value.kind !== "manual") ||
      typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt))) return false;
  if (value.sourceUrl === null) return value.kind === "manual";
  if (value.kind !== "source" || typeof value.sourceUrl !== "string") return false;
  try {
    const url = new URL(value.sourceUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function related(value: unknown): value is RelatedCatalogModel {
  return record(value) && typeof value.key === "string" && value.key.startsWith("c-") &&
    validProductKey(value.key) && typeof value.manufacturer === "string" &&
    typeof value.model === "string" && isCatalogRelationProof(value.proof);
}

function position(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000);
}

/** Optional detail data is untrusted too, including old local favorite snapshots. */
export function isProductModelRelations(value: unknown): value is ProductModelRelations {
  return record(value) && Array.isArray(value.links) && value.links.length <= 40 &&
    value.links.every((link) => related(link) && record(link) && ["predecessor", "successor", "variant"].includes(String(link.kind))) &&
    Array.isArray(value.families) && value.families.length <= 40 && value.families.every((family) =>
      record(family) && typeof family.name === "string" && position(family.position) && isCatalogRelationProof(family.proof) &&
      Array.isArray(family.members) && family.members.length <= 40 && family.members.every((member) =>
        related(member) && record(member) && position(member.position)));
}

export const MODEL_RELATION_LABELS = { predecessor: "前モデル", successor: "後継モデル", variant: "別仕様モデル" } as const;
