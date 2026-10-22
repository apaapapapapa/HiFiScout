import {
  createManufacturerResolver,
  MANUFACTURER_RESOLVER_VERSION,
  resolveManufacturer,
} from "../catalog/manufacturer-resolver.js";
import { manufacturerIdForFilter, normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { presentationColorLabel } from "../catalog/model-presentation-color.js";
import { createModelResolver, MODEL_RESOLVER_VERSION } from "../catalog/model-resolver.js";
import type {
  ManufacturerAliasEvidence,
  ManufacturerVerificationStatus,
  ModelResolutionResult,
} from "../catalog/types.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { InvocationBudgetExceeded } from "./invocation-budget.js";
import { firstMeasured } from "./read-accounting.js";
import { remediationEventStatement } from "./remediation-event-repository.js";
import type {
  KnowledgeCatalogManufacturerAliasRow,
  QueryableDatabase,
  ReadableDatabase,
} from "./types.js";

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 250;

interface ManufacturerAliasRevision {
  generation: string;
  version: number;
}

interface ManufacturerAliasCache extends ManufacturerAliasRevision {
  aliases: ManufacturerAliasEvidence[];
}

let manufacturerAliasCache: ManufacturerAliasCache | null = null;

const ALIAS_EVIDENCE_SQL = `
      WITH aliases AS (
        SELECT a.*, '' AS shop_key FROM knowledge_catalog_manufacturer_aliases a INDEXED BY idx_knowledge_catalog_manufacturer_alias_lookup
        UNION ALL
        SELECT id, manufacturer_id, alias, normalized_alias, verification_status, source,
          provenance_json, rule_version, created_at, updated_at, shop_key
          FROM knowledge_catalog_shop_manufacturer_aliases INDEXED BY idx_shop_alias_lookup
      )
      SELECT a.*, m.canonical_name FROM aliases a
      JOIN knowledge_catalog_manufacturers m ON m.id = a.manufacturer_id
      WHERE m.verification_status = 'verified'
        AND (a.verification_status IN ('pending', 'verified') OR a.source='admin_alias_control')
      ORDER BY a.normalized_alias, a.manufacturer_id, a.id
    `;

/** The only columns evidence is built from; a persisted snapshot keeps exactly these, in order. */
const ALIAS_EVIDENCE_COLUMNS = [
  "manufacturer_id",
  "shop_key",
  "canonical_name",
  "alias",
  "normalized_alias",
  "verification_status",
  "source",
  "rule_version",
] as const satisfies readonly (keyof KnowledgeCatalogManufacturerAliasRow)[];

type AliasEvidenceRow = Pick<
  KnowledgeCatalogManufacturerAliasRow,
  (typeof ALIAS_EVIDENCE_COLUMNS)[number]
>;

/** A larger UTF-8 payload is left uncached rather than approaching D1's 2,000,000-byte row limit. */
const MAX_ALIAS_SNAPSHOT_BYTES = 1_000_000;

/** 32-bit FNV-1a, enough to tell one deployed alias query from another. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The query and columns a persisted snapshot was built from. The registry clock proves that no
 * resolver-visible row moved, not that this code still selects the same rows; a deploy that edits
 * either rebuilds the snapshot once, and an older Worker's rows are never reused.
 */
const ALIAS_EVIDENCE_DEFINITION = `fnv1a:${fnv1a(
  `${ALIAS_EVIDENCE_SQL}\n${JSON.stringify(ALIAS_EVIDENCE_COLUMNS)}`,
)}`;

const VERIFICATION_STATUSES: ReadonlySet<unknown> = new Set(["pending", "verified", "rejected"]);

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

export interface ManufacturerReplayDependencies {
  /** Test seam for deterministic downstream failure injection. */
  refreshListings?: typeof refreshListingProjections;
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
  presentation_color: string;
  model_resolution_status: string;
  model_resolution_method: string;
  model_resolution_confidence: string;
  model_resolver_version: number;
  remediation_projection_required: number;
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

async function manufacturerAliasRevision(
  db: ReadableDatabase,
): Promise<ManufacturerAliasRevision | null> {
  let result: D1Result<{ generation: string; version: number }>;
  try {
    result = await db
      .prepare("SELECT generation,version FROM admin_manufacturer_registry_clock WHERE id=1")
      .all<{ generation: string; version: number }>();
  } catch (error) {
    // Rolling deploys and historical migration tests may briefly use a schema from before the
    // cache generation existed. Preserve the old uncached behavior there; unrelated D1 failures
    // still surface instead of being mistaken for a cache miss.
    if (
      /no such (?:table|column): (?:admin_manufacturer_registry_clock|generation)/u.test(
        String(error),
      )
    ) {
      return null;
    }
    throw error;
  }
  const row = result.results?.[0];
  const generation = String(row?.generation || "");
  const version = Number(row?.version);
  return generation && Number.isSafeInteger(version) && version >= 0
    ? { generation, version }
    : null;
}

function aliasEvidence(row: AliasEvidenceRow): ManufacturerAliasEvidence {
  return {
    manufacturerId: row.manufacturer_id,
    ...(row.shop_key ? { shopKey: row.shop_key } : {}),
    canonicalName: row.canonical_name,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    verificationStatus: row.verification_status,
    source: row.source,
    ruleVersion: Number(row.rule_version) || 1,
  };
}

async function loadManufacturerAliasRows(db: ReadableDatabase): Promise<AliasEvidenceRow[]> {
  const result = await db.prepare(ALIAS_EVIDENCE_SQL).all<KnowledgeCatalogManufacturerAliasRow>();
  return (result.results || []).map((row) => ({
    manufacturer_id: row.manufacturer_id,
    shop_key: row.shop_key,
    canonical_name: row.canonical_name,
    alias: row.alias,
    normalized_alias: row.normalized_alias,
    verification_status: row.verification_status,
    source: row.source,
    rule_version: row.rule_version,
  }));
}

function isSnapshotSchemaMissing(error: unknown): boolean {
  // Historical migration tests and a rollout's first moments may run before migration 0140.
  return /no such table: manufacturer_alias_evidence_snapshot/u.test(String(error));
}

/** Stored tuples are revalidated: a malformed row is a cache miss, never resolver evidence. */
function snapshotRows(rowsJson: unknown): AliasEvidenceRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(rowsJson));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: AliasEvidenceRow[] = [];
  for (const tuple of parsed) {
    if (!Array.isArray(tuple) || tuple.length !== ALIAS_EVIDENCE_COLUMNS.length) return null;
    const [manufacturerId, shopKey, canonicalName, alias, normalizedAlias, status, source, rule] =
      tuple as unknown[];
    if (
      typeof manufacturerId !== "string" ||
      (shopKey !== null && typeof shopKey !== "string") ||
      typeof canonicalName !== "string" ||
      typeof alias !== "string" ||
      typeof normalizedAlias !== "string" ||
      !VERIFICATION_STATUSES.has(status) ||
      typeof source !== "string" ||
      typeof rule !== "number"
    ) {
      return null;
    }
    rows.push({
      manufacturer_id: manufacturerId,
      shop_key: shopKey ?? undefined,
      canonical_name: canonicalName,
      alias,
      normalized_alias: normalizedAlias,
      verification_status: status as AliasEvidenceRow["verification_status"],
      source,
      rule_version: rule,
    });
  }
  return rows;
}

interface AliasEvidenceHead {
  revision: ManufacturerAliasRevision | null;
  /** The persisted rows for `revision`; only read when the isolate's cache is not current. */
  rowsJson: string | null;
}

/**
 * The registry revision and, unless the isolate already holds that revision, its persisted
 * snapshot: one round trip either way. `CASE` skips the snapshot row on a current cache.
 */
async function aliasEvidenceHead(
  db: ReadableDatabase,
  cached: ManufacturerAliasRevision | null,
): Promise<AliasEvidenceHead> {
  type HeadRow = { generation: string; version: number; rows_json: string | null };
  let row: HeadRow | null;
  try {
    row = await firstMeasured<HeadRow>(
      db
        .prepare(`
          SELECT c.generation, c.version,
            CASE WHEN c.generation = ?1 AND c.version = ?2 THEN NULL ELSE (
              SELECT s.rows_json FROM manufacturer_alias_evidence_snapshot s
              WHERE s.id = 1 AND s.generation = c.generation AND s.version = c.version
                AND s.definition = ?3
            ) END AS rows_json
          FROM admin_manufacturer_registry_clock c
          WHERE c.id = 1
        `)
        .bind(cached?.generation ?? "", cached?.version ?? -1, ALIAS_EVIDENCE_DEFINITION),
    );
  } catch (error) {
    // Before migration 0140 (or 0134) the revision alone is read, with its own fallback.
    if (!/no such (?:table|column)/u.test(String(error))) throw error;
    return { revision: await manufacturerAliasRevision(db), rowsJson: null };
  }
  const generation = String(row?.generation || "");
  const version = Number(row?.version);
  return generation && Number.isSafeInteger(version) && version >= 0
    ? { revision: { generation, version }, rowsJson: row?.rows_json ?? null }
    : { revision: null, rowsJson: null };
}

/**
 * Persist rows scanned under `revision`. The write lands only while the clock still shows that
 * revision; the clock only advances, so a landed write also proves that no edit preceded the scan
 * and the rows may be cached. It is skipped when an identical snapshot is already stored and
 * replaces a malformed one. `true` means it landed, `false` that the revision moved or the row
 * was already current, and `null` that no write was attempted or it failed (an exhausted write
 * quota, an oversized payload): persisting is an optimization that never fails the evidence read.
 */
async function persistAliasRows(
  db: ReadableDatabase,
  revision: ManufacturerAliasRevision,
  rows: readonly AliasEvidenceRow[],
): Promise<boolean | null> {
  const rowsJson = JSON.stringify(
    rows.map((row) => ALIAS_EVIDENCE_COLUMNS.map((column) => row[column] ?? null)),
  );
  if (new TextEncoder().encode(rowsJson).byteLength > MAX_ALIAS_SNAPSHOT_BYTES) return null;
  try {
    const result = await db
      .prepare(`
        INSERT INTO manufacturer_alias_evidence_snapshot(
          id, generation, version, definition, rows_json, built_at
        )
        SELECT 1, ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM admin_manufacturer_registry_clock
          WHERE id = 1 AND generation = ?1 AND version = ?2
        )
        ON CONFLICT(id) DO UPDATE SET
          generation = excluded.generation,
          version = excluded.version,
          definition = excluded.definition,
          rows_json = excluded.rows_json,
          built_at = excluded.built_at
        WHERE manufacturer_alias_evidence_snapshot.generation IS NOT excluded.generation
          OR manufacturer_alias_evidence_snapshot.version IS NOT excluded.version
          OR manufacturer_alias_evidence_snapshot.definition IS NOT excluded.definition
          OR manufacturer_alias_evidence_snapshot.rows_json IS NOT excluded.rows_json
      `)
      .bind(
        revision.generation,
        revision.version,
        ALIAS_EVIDENCE_DEFINITION,
        rowsJson,
        new Date().toISOString(),
      )
      .run();
    return Number(result.meta?.changes || 0) > 0;
  } catch (error) {
    // A cooperative budget stop must reach the scheduler, not be mistaken for a lost optimization.
    if (error instanceof InvocationBudgetExceeded) throw error;
    if (!isSnapshotSchemaMissing(error)) {
      console.error(
        JSON.stringify({
          event: "manufacturer_alias_snapshot_persist_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return null;
  }
}

/**
 * Load resolver-visible manufacturer evidence with revision-checked reuse.
 *
 * Alias and canonical-manufacturer edits advance the existing administrative registry clock.
 * Isolate cache hits therefore cost one singleton lookup instead of scanning and returning every
 * alias. An isolate without the current revision -- a fresh one, such as a crawl's Durable
 * Object, or one that saw an edit -- gets the persisted snapshot for that revision in the same
 * round trip. Only while no snapshot of the current revision and query is stored does a load scan;
 * the first conditional write stores it for the isolates that follow, and costs no more round
 * trips than the former confirming revision read. A scan that a concurrent edit may have
 * overtaken is never cached: that invocation still gets the same point-in-time result the old
 * query would have returned, while the next invocation reloads it. The read may therefore issue
 * one best-effort conditional write.
 */
export async function listManufacturerAliasEvidence(
  db: ReadableDatabase,
): Promise<ManufacturerAliasEvidence[]> {
  const cached = manufacturerAliasCache;
  const { revision: before, rowsJson } = await aliasEvidenceHead(db, cached);
  if (before && cached?.generation === before.generation && cached.version === before.version) {
    return cached.aliases.slice();
  }

  const persisted = before && rowsJson !== null ? snapshotRows(rowsJson) : null;
  if (before && persisted) {
    const aliases = persisted.map(aliasEvidence);
    manufacturerAliasCache = { ...before, aliases };
    return aliases.slice();
  }

  const rows = await loadManufacturerAliasRows(db);
  const aliases = rows.map(aliasEvidence);
  if (!before) return aliases.slice();
  const stored = await persistAliasRows(db, before, rows);
  // Without a landed write, confirm the revision as before so a write outage keeps isolate reuse.
  const after = stored === null ? await manufacturerAliasRevision(db) : null;
  if (
    stored === true ||
    (after?.generation === before.generation && after.version === before.version)
  ) {
    manufacturerAliasCache = { ...before, aliases };
  }
  return aliases.slice();
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
             manufacturer_resolver_version, model, raw_model, normalized_model, presentation_color,
             model_resolution_status, model_resolution_method, model_resolution_confidence,
             model_resolver_version, remediation_projection_required, title, metadata_json
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

function manufacturerResolutionMoved(
  row: ManufacturerReplayListingRow,
  next: ReturnType<typeof resolveManufacturer>,
): boolean {
  return (
    row.canonical_manufacturer_id !== next.canonicalManufacturerId ||
    row.manufacturer_resolution_status !== next.status ||
    row.manufacturer_resolution_method !== next.method ||
    row.manufacturer_resolution_confidence !== next.confidence ||
    row.manufacturer !== next.displayName ||
    row.manufacturer_id !== manufacturerIdForFilter(next.displayName)
  );
}

function modelResolutionMoved(
  row: ManufacturerReplayListingRow,
  next: ModelResolutionResult,
  presentationColor: string,
): boolean {
  return (
    row.model !== next.model ||
    row.normalized_model !== next.normalizedModel ||
    (row.presentation_color ?? "") !== presentationColor ||
    row.model_resolution_status !== next.status ||
    row.model_resolution_method !== next.method ||
    row.model_resolution_confidence !== next.confidence
  );
}

function modelAuditValue(
  model: string,
  normalizedModel: string,
  presentationColor: string,
  status: string,
): string {
  return `${model} (${normalizedModel || "-"}/${presentationColor || "-"}/${status})`;
}

export async function selectStaleManufacturerListings(
  db: ReadableDatabase,
  { afterId = 0, limit }: ManufacturerAliasReplayOptions = {},
): Promise<{ rows: ManufacturerReplayListingRow[]; hasMore: boolean }> {
  const take = boundedLimit(limit);
  const result = await db
    .prepare(`
      SELECT id, shop_key, source_id, manufacturer, raw_manufacturer, manufacturer_id,
             canonical_manufacturer_id, manufacturer_resolution_status,
             manufacturer_resolution_method, manufacturer_resolution_confidence,
             manufacturer_resolver_version, model, raw_model, normalized_model, presentation_color,
             model_resolution_status, model_resolution_method, model_resolution_confidence,
             model_resolver_version, remediation_projection_required, title, metadata_json
      FROM products
      WHERE is_active = 1 AND id > ?
        AND (manufacturer_resolver_version < ? OR remediation_projection_required = 1)
      ORDER BY id
      LIMIT ?
    `)
    .bind(afterId, MANUFACTURER_RESOLVER_VERSION, take + 1)
    .all<ManufacturerReplayListingRow>();
  const rows = result.results || [];
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

async function reprocessManufacturerRows(
  db: QueryableDatabase,
  selected: { rows: ManufacturerReplayListingRow[]; hasMore: boolean },
  aliases: readonly ManufacturerAliasEvidence[],
  evaluatedAt: string,
  reason: string,
  dependencies: ManufacturerReplayDependencies,
): Promise<ManufacturerAliasReplayResult> {
  const resolver = createManufacturerResolver(aliases);
  const modelResolver = createModelResolver(aliases);
  const refreshListings = dependencies.refreshListings || refreshListingProjections;
  const replayToken = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  let changedCount = 0;

  for (const row of selected.rows) {
    const resolution = resolver({
      rawManufacturer: row.raw_manufacturer,
      shopKey: row.shop_key,
      manufacturerCandidate: row.raw_manufacturer ? row.manufacturer : "",
      title: row.title,
    });
    const model = modelResolver({
      rawModel: row.raw_model,
      rawManufacturer: row.raw_manufacturer,
      title: row.title,
      manufacturerId: resolution.canonicalManufacturerId,
      shopKey: row.shop_key,
    });
    const presentationColor = presentationColorLabel(model.presentationColors);
    const manufacturerFilterId = manufacturerIdForFilter(resolution.displayName);
    const manufacturerMoved = manufacturerResolutionMoved(row, resolution);
    const modelMoved = modelResolutionMoved(row, model, presentationColor);
    const moved = manufacturerMoved || modelMoved;
    const metadata = {
      version: MANUFACTURER_RESOLVER_VERSION,
      matchedAlias: resolution.matchedAlias,
      status: resolution.status,
      method: resolution.method,
      confidence: resolution.confidence,
      normalizedRawManufacturer: resolution.normalizedRawManufacturer,
      candidateManufacturerIds: resolution.candidateManufacturerIds,
    };
    const modelMetadata = {
      version: MODEL_RESOLVER_VERSION,
      status: model.status,
      method: model.method,
      confidence: model.confidence,
      normalizedModel: model.normalizedModel,
      removedAnnotations: model.removedAnnotations,
      unclassifiedTokens: model.unclassifiedTokens,
      presentationColors: model.presentationColors,
      ...(model.bundleComponents ? { bundleComponents: model.bundleComponents } : {}),
    };
    statements.push(
      db
        .prepare(`
          UPDATE products SET
            manufacturer = ?, manufacturer_id = ?, normalized_raw_manufacturer = ?,
            canonical_manufacturer_id = ?, manufacturer_resolution_status = ?,
            manufacturer_resolution_method = ?, manufacturer_resolution_confidence = ?,
            manufacturer_resolver_version = ?,
            model = ?, normalized_model = ?, presentation_color = ?, model_resolution_status = ?,
            model_resolution_method = ?, model_resolution_confidence = ?,
            model_resolver_version = ?, remediation_projection_required = 1,
            remediation_projection_token = ?,
            metadata_json = json_set(
              json_set(
                CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                '$.manufacturerNormalization', json(?)
              ),
              '$.modelNormalization', json(?)
            ),
            last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END
          WHERE id = ?
        `)
        .bind(
          resolution.displayName,
          manufacturerFilterId,
          resolution.normalizedRawManufacturer,
          resolution.canonicalManufacturerId,
          resolution.status,
          resolution.method,
          resolution.confidence,
          MANUFACTURER_RESOLVER_VERSION,
          model.model,
          model.normalizedModel,
          presentationColor,
          model.status,
          model.method,
          model.confidence,
          MODEL_RESOLVER_VERSION,
          replayToken,
          JSON.stringify(metadata),
          JSON.stringify(modelMetadata),
          moved ? 1 : 0,
          evaluatedAt,
          row.id,
        ),
    );
    if (manufacturerMoved) {
      statements.push(
        remediationEventStatement(db, {
          listingProductId: Number(row.id),
          shopKey: row.shop_key,
          sourceId: row.source_id,
          field: "manufacturer",
          previousValue: `${row.canonical_manufacturer_id || "-"} (${row.manufacturer_resolution_status})`,
          newValue: `${resolution.canonicalManufacturerId || "-"} (${resolution.status})`,
          reason,
          resolverMethod: resolution.method,
          resolverConfidence: resolution.confidence,
          resolverVersion: MANUFACTURER_RESOLVER_VERSION,
          processedAt: evaluatedAt,
        }),
      );
    }
    if (modelMoved) {
      statements.push(
        remediationEventStatement(db, {
          listingProductId: Number(row.id),
          shopKey: row.shop_key,
          sourceId: row.source_id,
          field: "model",
          previousValue: modelAuditValue(
            row.model,
            row.normalized_model,
            row.presentation_color,
            row.model_resolution_status,
          ),
          newValue: modelAuditValue(
            model.model,
            model.normalizedModel,
            presentationColor,
            model.status,
          ),
          reason,
          resolverMethod: model.method,
          resolverConfidence: model.confidence,
          resolverVersion: MODEL_RESOLVER_VERSION,
          processedAt: evaluatedAt,
        }),
      );
    }
    if (moved) changedCount += 1;
  }

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  // Every selected row refreshes. This includes a retry whose canonical fields already match but
  // whose previous downstream pass failed while `remediation_projection_required` stayed set.
  await refreshListings(db, selected.rows, evaluatedAt);
  const completed = selected.rows.map((row) =>
    db
      .prepare(`
        UPDATE products
        SET remediation_projection_required = 0, remediation_projection_token = ''
        WHERE id = ? AND manufacturer_resolver_version = ? AND model_resolver_version = ?
          AND remediation_projection_token = ?
      `)
      .bind(row.id, MANUFACTURER_RESOLVER_VERSION, MODEL_RESOLVER_VERSION, replayToken),
  );
  for (let index = 0; index < completed.length; index += 50) {
    await db.batch(completed.slice(index, index + 50));
  }

  const last = selected.rows.at(-1);
  return {
    processedCount: selected.rows.length,
    changedCount,
    nextAfterId: selected.hasMore && last ? Number(last.id) : null,
    hasMore: selected.hasMore,
  };
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
  dependencies: ManufacturerReplayDependencies = {},
): Promise<ManufacturerAliasReplayResult> {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const selected = await selectListingsAffectedByManufacturerAlias(db, alias, options);
  const aliases = await listManufacturerAliasEvidence(db);
  return reprocessManufacturerRows(
    db,
    selected,
    aliases,
    evaluatedAt,
    `${alias.verificationStatus}_manufacturer_alias:${alias.normalizedAlias}`,
    dependencies,
  );
}

/**
 * Runtime-normalize one bounded page of migration/code-version-stale manufacturer evidence.
 * This is the authoritative repair path for SQL backfill approximations: normalization rules live
 * in TypeScript, while migration rows deliberately remain behind the current resolver version.
 */
export async function reprocessStaleManufacturerListings(
  db: QueryableDatabase,
  options: ManufacturerAliasReplayOptions = {},
  dependencies: ManufacturerReplayDependencies = {},
): Promise<ManufacturerAliasReplayResult> {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const selected = await selectStaleManufacturerListings(db, options);
  if (!selected.rows.length) {
    return {
      processedCount: 0,
      changedCount: 0,
      nextAfterId: null,
      hasMore: false,
    };
  }
  const aliases = await listManufacturerAliasEvidence(db);
  return reprocessManufacturerRows(
    db,
    selected,
    aliases,
    evaluatedAt,
    "manufacturer_resolver_version_replay",
    dependencies,
  );
}

/** One operational write plus its first replay page; resume with `nextAfterId` when present. */
export async function saveManufacturerAliasAndReprocess(
  db: QueryableDatabase,
  input: SaveManufacturerAliasInput,
  options: ManufacturerAliasReplayOptions = {},
): Promise<{ alias: ManufacturerAliasEvidence; replay: ManufacturerAliasReplayResult | null }> {
  const alias = await saveManufacturerAlias(db, input);
  const replay =
    alias.verificationStatus === "verified" ||
    (alias.source === "admin_alias_control" && alias.verificationStatus === "rejected")
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
