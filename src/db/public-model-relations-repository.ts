import type { CatalogRelationProof, ProductModelRelations, RelatedCatalogModel } from "../catalog/types.js";
import { listFamilyModelFacts, listModelFacts } from "./model-relation-repository.js";
import type { ReviewedModelFact } from "./model-relation-repository.js";
import type { ReadableDatabase } from "./types.js";

function proof(row: ReviewedModelFact): CatalogRelationProof {
  let sourceUrl: string | null = null;
  try {
    const url = new URL(row.source_url);
    if (url.protocol === "https:" || url.protocol === "http:") sourceUrl = url.href;
  } catch { /* A manual audit may have no public URL. */ }
  return { kind: row.evidence_kind, sourceUrl: row.evidence_kind === "source" ? sourceUrl : null, verifiedAt: row.verified_at! };
}

function model(row: ReviewedModelFact, inverse = false): RelatedCatalogModel {
  return { key: `c-${inverse ? row.related_product_id : row.product_id}`, manufacturer: (inverse ? row.related_manufacturer : row.manufacturer) || "", model: (inverse ? row.related_product_name : row.product_name) || "", proof: proof(row) };
}

function publishable(fact: ReviewedModelFact): boolean {
  return fact.review_state === "verified" && fact.verified_at !== null &&
    (fact.evidence_kind === "manual" || proof(fact).sourceUrl !== null);
}

/** Explicit projection: private reviewer subjects, notes, source IDs and audit JSON never leave D1. */
export async function publicModelRelations(db: ReadableDatabase, productId: number, now = new Date().toISOString()): Promise<ProductModelRelations | undefined> {
  const verified = (await listModelFacts(db, productId, now)).filter(publishable);
  if (!verified.length) return undefined;
  const memberships = verified.filter((fact) => fact.family_id !== null);
  const familyIds = memberships.map((fact) => fact.family_id!);
  const familyMembers = (await listFamilyModelFacts(db, familyIds, now)).filter(publishable);
  return { links: verified.filter((fact) => fact.related_product_id !== null).map((fact) => ({
    ...model(fact, fact.product_id === productId), kind: fact.relation_type === "variant" ? "variant" : fact.product_id === productId ? "successor" : "predecessor",
  })), families: memberships.map((membership) => ({ name: membership.family_name!, position: membership.position, proof: proof(membership), members: familyMembers.filter((member) => member.family_id === membership.family_id).map((member) => ({ ...model(member), position: member.position })) })) };
}
