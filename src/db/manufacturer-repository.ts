import {
  createManufacturerResolver,
  MANUFACTURER_RESOLVER_VERSION,
  resolveManufacturer,
} from "../catalog/manufacturer-resolver.js";
import { normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { createModelResolver, MODEL_RESOLVER_VERSION } from "../catalog/model-resolver.js";
import type {
  ManufacturerAliasEvidence,
  ManufacturerVerificationStatus,
} from "../catalog/types.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { remediationEventStatement } from "./remediation-event-repository.js";
import type {
  KnowledgeCatalogManufacturerAliasRow,
  QueryableDatabase,
  ReadableDatabase,
} from "./types.js";

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 250;

export interface SaveManufacturerAliasInput {
  manufacturerId: string;
  canonicalName: string;
  alias: string;
  verificationStatus: ManufacturerVerificationStatus;
  source: string;
  provenance?: Record<string, unknown>;
  ruleVersion?: number;
  updatedAt?: string;
}

export interface ManufacturerAliasReplayOptions {
  afterId?: number;
  limit?: number;
  evaluatedAt?: string;
}

export interface ManufacturerAliasReplayResult {
  processedCount: number;
  changedCount: number;
  nextAfterId: number | null;
  hasMore: boolean;
}

export interface UnresolvedManufacturerGroup {
  normalizedRawManufacturer: string;
  sampleRawManufacturer: string;
  listingCount: number;
  shopCount: number;
}

interface ManufacturerReplayListingRow {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer: string;
  raw_manufacturer: string;
  manufacturer_id: string;
  canonical_manufacturer_id: string;
  manufacturer_resolution_status: string;
  manufacturer_resolution_method: string;
  manufacturer_resolution_confidence: string;
  manufacturer_resolver_version: number;
  model: string;
  raw_model: string;
  normalized_model: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  title: string;
  metadata_json: string;
}

interface UnresolvedManufacturerGroupRow {
  normalized_raw_manufacturer: string;
  sample_raw_manufacturer: string;
  listing_count: number;
  shop_count: number;
}

function clean(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedLimit(value: number | undefined): number {
  return Math.min(MAX_REPLAY_LIMIT, Math.max(1, Number(value) || DEFAULT_REPLAY_LIMIT));
}

function jsonObject(value: unknown): string {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Title selector for listings with no explicit manufacturer field.
 *
 * The resolver accepts any separator between brand words (`Example Audio`, `Example-Audio`,
 * `ExampleAudio`), which no single `LIKE` can express, so this deliberately over-selects on the
 * first brand token and lets the resolver decide per row — a replay that skipped those spellings
 * would silently miss listings the crawler does correct. Over-selection is bounded: only listings
 * with an empty `raw_manufacturer` reach this branch, the page limit still applies, and rows whose
 * resolution is unchanged are skipped without a write.
 */
function titlePrefixPattern(alias: string): string {
  const [firstToken = ""] = clean(alias)
    .split(/[\s・･_\-/&+.,'"()（）]+/u)
    .filter(Boolean);
  return likePrefix(firstToken || alias);
}

export async function listManufacturerAliasEvidence(
  db: ReadableDatabase,
): Promise<ManufacturerAliasEvidence[]> {
  const result = await db
    .prepare(`
      SELECT a.id, a.manufacturer_id, m.canonical_name, a.alias, a.normalized_alias,
             a.verification_status, a.source, a.provenance_json, a.rule_version,
             a.created_at, a.updated_at
      FROM knowledge_catalog_manufacturer_aliases a
      JOIN knowledge_catalog_manufacturers m ON m.id = a.manufacturer_id
      WHERE m.verification_status = 'verified'
        AND a.verification_status IN ('pending', 'verified')
      ORDER BY a.normalized_alias, a.manufacturer_id, a.id
    `)
    .all<KnowledgeCatalogManufacturerAliasRow>();
  return (result.results || []).map((row) => ({
    manufacturerId: row.manufacturer_id,
    canonicalName: row.canonical_name,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    verificationStatus: row.verification_status,
    source: row.source,
    ruleVersion: Number(row.rule_version) || 1,
  }));
}

/** Persist canonical manufacturer plus alias evidence atomically. Pending aliases never resolve. */
export async function saveManufacturerAlias(
  db: QueryableDatabase,
  input: SaveManufacturerAliasInput,
): Promise<ManufacturerAliasEvidence> {
  const manufacturerId = clean(input.manufacturerId).toLowerCase();
  const canonicalName = clean(input.canonicalName);
  const alias = clean(input.alias);
  const normalizedAlias = normalizeManufacturerKey(alias);
  const source = clean(input.source);
  const updatedAt = input.updatedAt || new Date().toISOString();
  const ruleVersion = Math.max(1, Math.trunc(input.ruleVersion || MANUFACTURER_RESOLVER_VERSION));
  if (!manufacturerId || !canonicalName || !alias || !normalizedAlias) {
    throw new Error("manufacturer id, canonical name and alias are required");
  }
  if (!source) throw new Error("manufacturer alias source is required");

  await db.batch([
    db
      .prepare(`
        INSERT INTO knowledge_catalog_manufacturers(
          id, canonical_name, verification_status, source, provenance_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          verification_status = excluded.verification_status,
          source = excluded.source,
          provenance_json = excluded.provenance_json,
          updated_at = excluded.updated_at
      `)
      .bind(
        manufacturerId,
        canonicalName,
        "verified",
        source,
        jsonObject(input.provenance),
        updatedAt,
        updatedAt,
      ),
    db
      .prepare(`
        INSERT INTO knowledge_catalog_manufacturer_aliases(
          manufacturer_id, alias, normalized_alias, verification_status, source,
          provenance_json, rule_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(manufacturer_id, normalized_alias) DO UPDATE SET
          alias = excluded.alias,
          verification_status = excluded.verification_status,
          source = excluded.source,
          provenance_json = excluded.provenance_json,
          rule_version = excluded.rule_version,
          updated_at = excluded.updated_at
      `)
      .bind(
        manufacturerId,
        alias,
        normalizedAlias,
        input.verificationStatus,
        source,
        jsonObject(input.provenance),
        ruleVersion,
        updatedAt,
        updatedAt,
      ),
  ]);

  return {
    manufacturerId,
    canonicalName,
    alias,
    normalizedAlias,
    verificationStatus: input.verificationStatus,
    source,
    ruleVersion,
  };
}

export async function selectListingsAffectedByManufacturerAlias(
  db: ReadableDatabase,
  alias: Pick<ManufacturerAliasEvidence, "alias" | "normalizedAlias">,
  { afterId = 0, limit }: ManufacturerAliasReplayOptions = {},
): Promise<{ rows: ManufacturerReplayListingRow[]; hasMore: boolean }> {
  const take = boundedLimit(limit);
  const result = await db
    .prepare(`
      SELECT id, shop_key, source_id, manufacturer, raw_manufacturer, manufacturer_id,
             canonical_manufacturer_id, manufacturer_resolution_status,
             manufacturer_resolution_method, manufacturer_resolution_confidence,
             manufacturer_resolver_version, model, raw_model, normalized_model,
             model_resolution_status, model_resolution_method, model_resolution_confidence,
             title, metadata_json
      FROM products
      WHERE is_active = 1 AND id > ? AND (
        normalized_raw_manufacturer = ?
        OR lower(trim(raw_manufacturer)) = lower(trim(?))
        OR (raw_manufacturer = '' AND title LIKE ? ESCAPE '\\' COLLATE NOCASE)
      )
      ORDER BY id
      LIMIT ?
    `)
    .bind(afterId, alias.normalizedAlias, alias.alias, titlePrefixPattern(alias.alias), take + 1)
    .all<ManufacturerReplayListingRow>();
  const rows = result.results || [];
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

function sameManufacturerResolution(
  row: ManufacturerReplayListingRow,
  next: ReturnType<typeof resolveManufacturer>,
): boolean {
  return (
    row.canonical_manufacturer_id === next.canonicalManufacturerId &&
    row.manufacturer_resolution_status === next.status &&
    row.manufacturer_resolution_method === next.method &&
    row.manufacturer_resolution_confidence === next.confidence &&
    Number(row.manufacturer_resolver_version) === MANUFACTURER_RESOLVER_VERSION &&
    row.manufacturer === (next.displayName || row.manufacturer)
  );
}

/**
 * Bounded, cursor-restartable replay for one alias. It changes only derived manufacturer and model
 * fields, then refreshes the existing identity and Phase 4 search projections without fetching a
 * shop. Model Resolution is re-run in the same page because it depends on the canonical
 * manufacturer this replay may have just corrected.
 */
export async function reprocessManufacturerAliasListings(
  db: QueryableDatabase,
  alias: ManufacturerAliasEvidence,
  options: ManufacturerAliasReplayOptions = {},
): Promise<ManufacturerAliasReplayResult> {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const selected = await selectListingsAffectedByManufacturerAlias(db, alias, options);
  const aliases = await listManufacturerAliasEvidence(db);
  const resolver = createManufacturerResolver(aliases);
  const modelResolver = createModelResolver(aliases);
  const changed: ManufacturerReplayListingRow[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const row of selected.rows) {
    const resolution = resolver({
      rawManufacturer: row.raw_manufacturer,
      manufacturerCandidate: row.raw_manufacturer ? row.manufacturer : "",
      title: row.title,
    });
    if (sameManufacturerResolution(row, resolution)) continue;
    const metadata = {
      version: MANUFACTURER_RESOLVER_VERSION,
      matchedAlias: resolution.matchedAlias,
      status: resolution.status,
      method: resolution.method,
      confidence: resolution.confidence,
      normalizedRawManufacturer: resolution.normalizedRawManufacturer,
      candidateManufacturerIds: resolution.candidateManufacturerIds,
    };
    const model = modelResolver({
      rawModel: row.raw_model || row.model,
      title: row.title,
      manufacturerId: resolution.canonicalManufacturerId,
    });
    const modelMetadata = {
      version: MODEL_RESOLVER_VERSION,
      status: model.status,
      method: model.method,
      confidence: model.confidence,
      normalizedModel: model.normalizedModel,
      removedAnnotations: model.removedAnnotations,
      unclassifiedTokens: model.unclassifiedTokens,
    };
    statements.push(
      db
        .prepare(`
          UPDATE products SET
            manufacturer = ?, manufacturer_id = ?, normalized_raw_manufacturer = ?,
            canonical_manufacturer_id = ?, manufacturer_resolution_status = ?,
            manufacturer_resolution_method = ?, manufacturer_resolution_confidence = ?,
            manufacturer_resolver_version = ?,
            model = ?, raw_model = ?, normalized_model = ?, model_resolution_status = ?,
            model_resolution_method = ?, model_resolution_confidence = ?,
            model_resolver_version = ?,
            metadata_json = json_set(
              json_set(
                CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                '$.manufacturerNormalization', json(?)
              ),
              '$.modelNormalization', json(?)
            ),
            last_changed_at = ?
          WHERE id = ?
        `)
        .bind(
          resolution.displayName || row.manufacturer,
          resolution.canonicalManufacturerId || row.manufacturer_id,
          resolution.normalizedRawManufacturer,
          resolution.canonicalManufacturerId,
          resolution.status,
          resolution.method,
          resolution.confidence,
          MANUFACTURER_RESOLVER_VERSION,
          model.model || row.model,
          model.rawModel || row.raw_model || row.model,
          model.normalizedModel,
          model.status,
          model.method,
          model.confidence,
          MODEL_RESOLVER_VERSION,
          JSON.stringify(metadata),
          JSON.stringify(modelMetadata),
          evaluatedAt,
          row.id,
        ),
    );
    // Provenance for the fields that actually moved, so alias-driven corrections are auditable
    // alongside the model and identity replays rather than being the one silent path.
    statements.push(
      remediationEventStatement(db, {
        listingProductId: Number(row.id),
        shopKey: row.shop_key,
        sourceId: row.source_id,
        field: "manufacturer",
        previousValue: `${row.canonical_manufacturer_id || "-"} (${row.manufacturer_resolution_status})`,
        newValue: `${resolution.canonicalManufacturerId || "-"} (${resolution.status})`,
        reason: `verified_manufacturer_alias:${alias.normalizedAlias}`,
        resolverMethod: resolution.method,
        resolverConfidence: resolution.confidence,
        resolverVersion: MANUFACTURER_RESOLVER_VERSION,
        processedAt: evaluatedAt,
      }),
    );
    if (
      row.model !== model.model ||
      row.normalized_model !== model.normalizedModel ||
      row.model_resolution_status !== model.status
    ) {
      statements.push(
        remediationEventStatement(db, {
          listingProductId: Number(row.id),
          shopKey: row.shop_key,
          sourceId: row.source_id,
          field: "model",
          previousValue: `${row.model} (${row.normalized_model || "-"}/${row.model_resolution_status})`,
          newValue: `${model.model} (${model.normalizedModel || "-"}/${model.status})`,
          reason: `verified_manufacturer_alias:${alias.normalizedAlias}`,
          resolverMethod: model.method,
          resolverConfidence: model.confidence,
          resolverVersion: MODEL_RESOLVER_VERSION,
          processedAt: evaluatedAt,
        }),
      );
    }
    changed.push(row);
  }

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  await refreshListingProjections(db, changed, evaluatedAt);

  const last = selected.rows.at(-1);
  return {
    processedCount: selected.rows.length,
    changedCount: changed.length,
    nextAfterId: selected.hasMore && last ? Number(last.id) : null,
    hasMore: selected.hasMore,
  };
}

/** One operational write plus its first replay page; resume with `nextAfterId` when present. */
export async function saveManufacturerAliasAndReprocess(
  db: QueryableDatabase,
  input: SaveManufacturerAliasInput,
  options: ManufacturerAliasReplayOptions = {},
): Promise<{ alias: ManufacturerAliasEvidence; replay: ManufacturerAliasReplayResult | null }> {
  const alias = await saveManufacturerAlias(db, input);
  const replay =
    alias.verificationStatus === "verified"
      ? await reprocessManufacturerAliasListings(db, alias, options)
      : null;
  return { alias, replay };
}

/** Highest-impact unresolved raw spellings for DQ/admin surfaces. */
export async function listUnresolvedManufacturerGroups(
  db: ReadableDatabase,
  limit = 50,
): Promise<UnresolvedManufacturerGroup[]> {
  const result = await db
    .prepare(`
      SELECT normalized_raw_manufacturer,
             MIN(raw_manufacturer) AS sample_raw_manufacturer,
             COUNT(*) AS listing_count,
             COUNT(DISTINCT shop_key) AS shop_count
      FROM products
      WHERE is_active = 1 AND manufacturer_resolution_status <> 'resolved'
      GROUP BY normalized_raw_manufacturer
      ORDER BY listing_count DESC, shop_count DESC, normalized_raw_manufacturer
      LIMIT ?
    `)
    .bind(Math.min(200, Math.max(1, Number(limit) || 50)))
    .all<UnresolvedManufacturerGroupRow>();
  return (result.results || []).map((row) => ({
    normalizedRawManufacturer: row.normalized_raw_manufacturer,
    sampleRawManufacturer: row.sample_raw_manufacturer,
    listingCount: Number(row.listing_count),
    shopCount: Number(row.shop_count),
  }));
}
