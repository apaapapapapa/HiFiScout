/**
 * Human-remediation backlog ordered by blast radius.
 *
 * Every view counts active seller listings and the Product Search entities they currently occupy.
 * Candidate canonical values are suggestions only: ambiguous evidence is deliberately returned as
 * no candidate, so impact ranking can never become an implicit auto-merge path.
 */

import type { ReadableDatabase } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function boundedLimit(limit: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(limit) || DEFAULT_LIMIT)));
}

export interface UnknownManufacturerImpact {
  normalizedRawManufacturer: string;
  sampleRawManufacturer: string;
  listingCount: number;
  searchEntityCount: number;
  shopCount: number;
  candidateCanonicalManufacturerId: string | null;
  candidateCanonicalManufacturer: string | null;
}

interface UnknownManufacturerImpactRow {
  normalized_raw_manufacturer: string;
  sample_raw_manufacturer: string | null;
  listing_count: number;
  search_entity_count: number;
  shop_count: number;
  candidate_manufacturer_count: number;
  candidate_manufacturer_id: string | null;
  candidate_manufacturer_name: string | null;
}

export interface UnresolvedManufacturerModelImpact {
  normalizedRawManufacturer: string;
  normalizedModel: string;
  sampleRawManufacturer: string;
  sampleRawModel: string;
  listingCount: number;
  searchEntityCount: number;
  shopCount: number;
  candidateCatalogProductId: number | null;
}

interface UnresolvedManufacturerModelImpactRow {
  normalized_raw_manufacturer: string;
  normalized_model: string;
  sample_raw_manufacturer: string | null;
  sample_raw_model: string | null;
  listing_count: number;
  search_entity_count: number;
  shop_count: number;
  candidate_catalog_count: number;
  candidate_catalog_product_id: number | null;
}

export interface CategoryIssueImpact {
  rawCategory: string;
  classificationReason: string;
  listingCount: number;
  searchEntityCount: number;
  shopCount: number;
}

interface CategoryIssueImpactRow {
  raw_category: string;
  classification_reason: string;
  listing_count: number;
  search_entity_count: number;
  shop_count: number;
}

export interface ModelExtractionPatternImpact {
  pattern: string;
  resolutionStatus: string;
  resolutionMethod: string;
  sampleRawModel: string;
  sampleUnclassifiedTokens: string;
  listingCount: number;
  searchEntityCount: number;
  shopCount: number;
}

interface ModelExtractionPatternImpactRow {
  pattern: string;
  model_resolution_status: string;
  model_resolution_method: string;
  sample_raw_model: string | null;
  sample_unclassified_tokens: string | null;
  listing_count: number;
  search_entity_count: number;
  shop_count: number;
}

const VERIFIED_ALIAS_CTE = `
  verified_alias AS (
    SELECT a.normalized_alias, a.manufacturer_id, m.canonical_name
    FROM knowledge_catalog_manufacturer_aliases a
    JOIN knowledge_catalog_manufacturers m ON m.id = a.manufacturer_id
    WHERE a.verification_status = 'verified' AND m.verification_status = 'verified'
  )
`;

export async function listUnknownManufacturerImpact(
  db: ReadableDatabase,
  limit = DEFAULT_LIMIT,
): Promise<UnknownManufacturerImpact[]> {
  const result = await db
    .prepare(`
      WITH ${VERIFIED_ALIAS_CTE}
      SELECT p.normalized_raw_manufacturer,
             MIN(NULLIF(p.raw_manufacturer, '')) AS sample_raw_manufacturer,
             COUNT(DISTINCT p.id) AS listing_count,
             COUNT(DISTINCT e.entity_key) AS search_entity_count,
             COUNT(DISTINCT p.shop_key) AS shop_count,
             COUNT(DISTINCT va.manufacturer_id) AS candidate_manufacturer_count,
             MIN(va.manufacturer_id) AS candidate_manufacturer_id,
             MIN(va.canonical_name) AS candidate_manufacturer_name
      FROM products p
      LEFT JOIN verified_alias va
        ON va.normalized_alias = p.normalized_raw_manufacturer
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1 AND p.manufacturer_resolution_status <> 'resolved'
      GROUP BY p.normalized_raw_manufacturer
      ORDER BY listing_count DESC, search_entity_count DESC, shop_count DESC,
               p.normalized_raw_manufacturer
      LIMIT ?
    `)
    .bind(boundedLimit(limit))
    .all<UnknownManufacturerImpactRow>();

  return (result.results || []).map((row) => ({
    normalizedRawManufacturer: row.normalized_raw_manufacturer || "",
    sampleRawManufacturer: row.sample_raw_manufacturer || "",
    listingCount: Number(row.listing_count || 0),
    searchEntityCount: Number(row.search_entity_count || 0),
    shopCount: Number(row.shop_count || 0),
    candidateCanonicalManufacturerId:
      Number(row.candidate_manufacturer_count || 0) === 1 ? row.candidate_manufacturer_id : null,
    candidateCanonicalManufacturer:
      Number(row.candidate_manufacturer_count || 0) === 1 ? row.candidate_manufacturer_name : null,
  }));
}

export async function listUnresolvedManufacturerModelImpact(
  db: ReadableDatabase,
  limit = DEFAULT_LIMIT,
): Promise<UnresolvedManufacturerModelImpact[]> {
  const result = await db
    .prepare(`
      WITH ${VERIFIED_ALIAS_CTE}
      SELECT p.normalized_raw_manufacturer,
             p.normalized_model,
             MIN(NULLIF(p.raw_manufacturer, '')) AS sample_raw_manufacturer,
             MIN(NULLIF(p.raw_model, '')) AS sample_raw_model,
             COUNT(DISTINCT p.id) AS listing_count,
             COUNT(DISTINCT e.entity_key) AS search_entity_count,
             COUNT(DISTINCT p.shop_key) AS shop_count,
             COUNT(DISTINCT kp.id) AS candidate_catalog_count,
             MIN(kp.id) AS candidate_catalog_product_id
      FROM products p
      LEFT JOIN verified_alias va
        ON va.normalized_alias = p.normalized_raw_manufacturer
      LEFT JOIN knowledge_catalog_products kp
        ON kp.verification_status = 'verified'
       AND kp.manufacturer_id = va.manufacturer_id
       AND kp.normalized_model = p.normalized_model
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1
        AND p.manufacturer_resolution_status <> 'resolved'
        AND p.normalized_model <> ''
      GROUP BY p.normalized_raw_manufacturer, p.normalized_model
      ORDER BY listing_count DESC, search_entity_count DESC, shop_count DESC,
               p.normalized_raw_manufacturer, p.normalized_model
      LIMIT ?
    `)
    .bind(boundedLimit(limit))
    .all<UnresolvedManufacturerModelImpactRow>();

  return (result.results || []).map((row) => ({
    normalizedRawManufacturer: row.normalized_raw_manufacturer || "",
    normalizedModel: row.normalized_model || "",
    sampleRawManufacturer: row.sample_raw_manufacturer || "",
    sampleRawModel: row.sample_raw_model || "",
    listingCount: Number(row.listing_count || 0),
    searchEntityCount: Number(row.search_entity_count || 0),
    shopCount: Number(row.shop_count || 0),
    candidateCatalogProductId:
      Number(row.candidate_catalog_count || 0) === 1
        ? Number(row.candidate_catalog_product_id)
        : null,
  }));
}

export async function listCategoryIssueImpact(
  db: ReadableDatabase,
  limit = DEFAULT_LIMIT,
): Promise<CategoryIssueImpact[]> {
  const result = await db
    .prepare(`
      SELECT p.raw_category,
             CASE
               WHEN json_valid(p.metadata_json)
               THEN COALESCE(json_extract(p.metadata_json, '$.categoryClassification.reason'), '')
               ELSE ''
             END AS classification_reason,
             COUNT(DISTINCT p.id) AS listing_count,
             COUNT(DISTINCT e.entity_key) AS search_entity_count,
             COUNT(DISTINCT p.shop_key) AS shop_count
      FROM products p
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1 AND p.classification_status <> 'classified'
      GROUP BY p.raw_category, classification_reason
      ORDER BY listing_count DESC, search_entity_count DESC, shop_count DESC,
               p.raw_category, classification_reason
      LIMIT ?
    `)
    .bind(boundedLimit(limit))
    .all<CategoryIssueImpactRow>();

  return (result.results || []).map((row) => ({
    rawCategory: row.raw_category || "",
    classificationReason: row.classification_reason || "",
    listingCount: Number(row.listing_count || 0),
    searchEntityCount: Number(row.search_entity_count || 0),
    shopCount: Number(row.shop_count || 0),
  }));
}

export async function listModelExtractionPatternImpact(
  db: ReadableDatabase,
  limit = DEFAULT_LIMIT,
): Promise<ModelExtractionPatternImpact[]> {
  const result = await db
    .prepare(`
      SELECT CASE
               WHEN trim(p.raw_model) = '' THEN 'missing_raw_model'
               WHEN trim(p.normalized_model) = '' THEN 'normalization_empty'
               ELSE p.model_resolution_status || ':' ||
                    COALESCE(NULLIF(p.model_resolution_method, ''), 'unknown')
             END AS pattern,
             p.model_resolution_status,
             p.model_resolution_method,
             MIN(NULLIF(p.raw_model, '')) AS sample_raw_model,
             MIN(CASE
               WHEN json_valid(p.metadata_json)
               THEN COALESCE(json_extract(p.metadata_json, '$.modelNormalization.unclassifiedTokens'), '[]')
               ELSE '[]'
             END) AS sample_unclassified_tokens,
             COUNT(DISTINCT p.id) AS listing_count,
             COUNT(DISTINCT e.entity_key) AS search_entity_count,
             COUNT(DISTINCT p.shop_key) AS shop_count
      FROM products p
      LEFT JOIN product_search_entity_offers o ON o.listing_product_id = p.id
      LEFT JOIN product_search_entities e ON e.id = o.entity_id
      WHERE p.is_active = 1 AND p.model_resolution_status <> 'resolved'
      GROUP BY pattern, p.model_resolution_status, p.model_resolution_method
      ORDER BY listing_count DESC, search_entity_count DESC, shop_count DESC,
               pattern, p.model_resolution_status, p.model_resolution_method
      LIMIT ?
    `)
    .bind(boundedLimit(limit))
    .all<ModelExtractionPatternImpactRow>();

  return (result.results || []).map((row) => ({
    pattern: row.pattern || "unknown",
    resolutionStatus: row.model_resolution_status || "",
    resolutionMethod: row.model_resolution_method || "",
    sampleRawModel: row.sample_raw_model || "",
    sampleUnclassifiedTokens: row.sample_unclassified_tokens || "[]",
    listingCount: Number(row.listing_count || 0),
    searchEntityCount: Number(row.search_entity_count || 0),
    shopCount: Number(row.shop_count || 0),
  }));
}

export async function dataQualityRemediationImpact(
  db: ReadableDatabase,
  limit = DEFAULT_LIMIT,
): Promise<{
  unknownManufacturers: UnknownManufacturerImpact[];
  unresolvedManufacturerModels: UnresolvedManufacturerModelImpact[];
  categoryIssues: CategoryIssueImpact[];
  modelExtractionPatterns: ModelExtractionPatternImpact[];
}> {
  const [unknownManufacturers, unresolvedManufacturerModels, categoryIssues, modelExtractionPatterns] =
    await Promise.all([
      listUnknownManufacturerImpact(db, limit),
      listUnresolvedManufacturerModelImpact(db, limit),
      listCategoryIssueImpact(db, limit),
      listModelExtractionPatternImpact(db, limit),
    ]);
  return {
    unknownManufacturers,
    unresolvedManufacturerModels,
    categoryIssues,
    modelExtractionPatterns,
  };
}
