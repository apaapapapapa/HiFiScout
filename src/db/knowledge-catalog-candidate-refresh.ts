import {
  accumulateKnowledgeCatalogCandidateRows,
  finalizeKnowledgeCatalogCandidateAggregates,
  knowledgeCatalogKey,
} from "../catalog/knowledge-catalog.js";
import type {
  KnowledgeCatalogCandidateAccumulator,
  KnowledgeCatalogListingRow,
} from "../catalog/types.js";
import { firstMeasured } from "./read-accounting.js";
import { withinD1Budget } from "./invocation-budget.js";
import { findVerifiedCatalogMatches } from "./knowledge-catalog-repository.js";
import {
  knowledgeCatalogCandidateStats,
  knowledgeCatalogCandidateWrites,
} from "./knowledge-catalog-review-repository.js";
import type { QueryableDatabase } from "./types.js";

const LISTING_PAGE = 100;
const PUBLISH_PAGE = 20;
const RETIRE_PAGE = 100;

interface RefreshState {
  generation: string;
  request_key: string;
  started_at: string;
  phase: "collect" | "publish" | "retire" | "clean" | "complete";
  listing_horizon: number;
  listing_cursor: number;
  publish_cursor: string;
  retire_cursor: number;
  revision: number;
}
interface GroupRow {
  candidate_key: string;
  accumulator_json: string;
}
type StoredAccumulator = Omit<
  KnowledgeCatalogCandidateAccumulator,
  "shops" | "categories" | "rawModelVariants" | "sourceUrls" | "identityRejectionReasons"
> & {
  shops: string[];
  categories: string[];
  rawModelVariants: string[];
  sourceUrls: string[];
  identityRejectionReasons: [string, number][];
};

function serialize(value: KnowledgeCatalogCandidateAccumulator): string {
  return JSON.stringify({
    ...value,
    shops: [...value.shops],
    categories: [...value.categories],
    rawModelVariants: [...value.rawModelVariants],
    sourceUrls: [...value.sourceUrls],
    identityRejectionReasons: [...value.identityRejectionReasons],
  } satisfies StoredAccumulator);
}

function deserialize(row: GroupRow): KnowledgeCatalogCandidateAccumulator {
  const value = JSON.parse(row.accumulator_json) as StoredAccumulator;
  return {
    ...value,
    shops: new Set(value.shops),
    categories: new Set(value.categories),
    rawModelVariants: new Set(value.rawModelVariants),
    sourceUrls: new Set(value.sourceUrls),
    identityRejectionReasons: new Map(value.identityRejectionReasons),
  };
}

const guardSql = `EXISTS (SELECT 1 FROM knowledge_catalog_candidate_refresh
  WHERE id = 1 AND generation = ? AND revision = ?)`;

/** Cursor and effects commit together. Every write is fenced, including late/concurrent pages. */
async function checkpoint(
  db: QueryableDatabase,
  state: RefreshState,
  next: Partial<RefreshState>,
  writes: D1PreparedStatement[] = [],
): Promise<void> {
  const updated = { ...state, ...next };
  await withinD1Budget(db, 1, () =>
    db.batch([
      ...writes,
      db
        .prepare(`UPDATE knowledge_catalog_candidate_refresh
          SET phase = ?, listing_cursor = ?, publish_cursor = ?, retire_cursor = ?, revision = revision + 1
          WHERE id = 1 AND generation = ? AND revision = ?`)
        .bind(
          updated.phase,
          updated.listing_cursor,
          updated.publish_cursor,
          updated.retire_cursor,
          state.generation,
          state.revision,
        ),
    ]),
  );
}

async function collectPage(db: QueryableDatabase, state: RefreshState): Promise<void> {
  // Page the primary key BEFORE eligibility filtering, so inactive/invalid rows cannot make a
  // LIMIT scan the rest of the catalog. The ID horizon makes even a growing inventory terminate.
  const page = await db
    .prepare(`SELECT p.id, p.is_active, p.shop_key, p.canonical_manufacturer_id AS manufacturer_id,
      p.manufacturer, p.model, p.raw_model, p.title, p.source_url, p.category_ids,
      p.classification_status, p.first_seen_at, p.last_seen_at,
      r.status AS identity_status, r.match_method AS identity_match_method
      FROM (SELECT * FROM products WHERE id > ? AND id <= ? ORDER BY id LIMIT ?) p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id ORDER BY p.id`)
    .bind(state.listing_cursor, state.listing_horizon, LISTING_PAGE)
    .all<KnowledgeCatalogListingRow & { id: number; is_active: number }>();
  const rows = page.results || [];
  const eligible = rows.filter((row) => row.is_active === 1 && row.manufacturer_id && row.model);
  const keys = [
    ...new Set(eligible.map((row) => knowledgeCatalogKey(row.manufacturer_id, row.model))),
  ].filter(Boolean);
  const previous = keys.length
    ? (
        await db
          .prepare(`SELECT candidate_key, accumulator_json
        FROM knowledge_catalog_candidate_refresh_groups WHERE candidate_key IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(keys))
          .all<GroupRow>()
      ).results || []
    : [];
  const grouped = new Map(previous.map((row) => [row.candidate_key, deserialize(row)]));
  accumulateKnowledgeCatalogCandidateRows(grouped, eligible);
  const writes = [...grouped].map(([key, value]) =>
    db
      .prepare(`INSERT INTO knowledge_catalog_candidate_refresh_groups(candidate_key, accumulator_json)
      SELECT ?, ? WHERE ${guardSql}
      ON CONFLICT(candidate_key) DO UPDATE SET accumulator_json = excluded.accumulator_json`)
      .bind(key, serialize(value), state.generation, state.revision),
  );
  const cursor = rows.at(-1)?.id ?? state.listing_horizon;
  await checkpoint(
    db,
    state,
    {
      listing_cursor: cursor,
      phase: rows.length < LISTING_PAGE || cursor >= state.listing_horizon ? "publish" : "collect",
    },
    writes,
  );
}

async function publishPage(db: QueryableDatabase, state: RefreshState): Promise<void> {
  const page = await db
    .prepare(`SELECT candidate_key, accumulator_json
    FROM knowledge_catalog_candidate_refresh_groups WHERE candidate_key > ? ORDER BY candidate_key LIMIT ?`)
    .bind(state.publish_cursor, PUBLISH_PAGE)
    .all<GroupRow>();
  const rows = page.results || [];
  if (!rows.length) {
    await checkpoint(db, state, { phase: "retire" });
    return;
  }
  // Keep lookups within one manufacturer. A page crossing many makers would spend two indexed
  // queries per maker before it could persist any progress.
  const manufacturer = deserialize(rows[0]).manufacturerId;
  const grouped = new Map<string, KnowledgeCatalogCandidateAccumulator>();
  for (const row of rows) {
    const value = deserialize(row);
    if (value.manufacturerId !== manufacturer) break;
    grouped.set(row.candidate_key, value);
  }
  const candidates = finalizeKnowledgeCatalogCandidateAggregates(grouped);
  const matches = await findVerifiedCatalogMatches(
    db,
    candidates.map((candidate) => ({
      manufacturerId: candidate.manufacturerId,
      model: candidate.normalizedModel,
    })),
  );
  const writes = knowledgeCatalogCandidateWrites(db, candidates, matches, state.started_at, {
    sql: guardSql,
    binds: [state.generation, state.revision],
  });
  await checkpoint(db, state, { publish_cursor: [...grouped.keys()].at(-1)! }, writes);
}

async function retirePage(db: QueryableDatabase, state: RefreshState): Promise<void> {
  const page = await db
    .prepare(`SELECT id, manufacturer_id, normalized_model, active_listing_count
    FROM knowledge_catalog_candidates WHERE id > ? ORDER BY id LIMIT ?`)
    .bind(state.retire_cursor, RETIRE_PAGE)
    .all<{
      id: number;
      manufacturer_id: string;
      normalized_model: string;
      active_listing_count: number;
    }>();
  const rows = page.results || [];
  const keys = rows.map((row) => knowledgeCatalogKey(row.manufacturer_id, row.normalized_model));
  const present = keys.length
    ? (
        await db
          .prepare(`SELECT candidate_key FROM knowledge_catalog_candidate_refresh_groups
        WHERE candidate_key IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(keys))
          .all<{ candidate_key: string }>()
      ).results || []
    : [];
  const active = new Set(present.map((row) => row.candidate_key));
  const retired = rows
    .filter((row, index) => row.active_listing_count > 0 && !active.has(keys[index]))
    .map((row) => row.id);
  const writes = retired.length
    ? [
        db
          .prepare(`UPDATE knowledge_catalog_candidates
    SET active_listing_count = 0, shop_count = 0, unclassified_count = 0, other_count = 0,
        unresolved_identity_count = 0, priority_score = 0, last_reviewed_at = ?, updated_at = ?
    WHERE id IN (SELECT value FROM json_each(?)) AND active_listing_count > 0 AND ${guardSql}`)
          .bind(
            state.started_at,
            state.started_at,
            JSON.stringify(retired),
            state.generation,
            state.revision,
          ),
      ]
    : [];
  await checkpoint(
    db,
    state,
    {
      retire_cursor: rows.at(-1)?.id ?? state.retire_cursor,
      phase: rows.length < RETIRE_PAGE ? "clean" : "retire",
    },
    writes,
  );
}

async function cleanPage(db: QueryableDatabase, state: RefreshState): Promise<void> {
  const page = await db
    .prepare(`SELECT candidate_key FROM knowledge_catalog_candidate_refresh_groups
    ORDER BY candidate_key LIMIT ?`)
    .bind(LISTING_PAGE)
    .all<{ candidate_key: string }>();
  const keys = (page.results || []).map((row) => row.candidate_key);
  await checkpoint(
    db,
    state,
    { phase: keys.length < LISTING_PAGE ? "complete" : "clean" },
    keys.length
      ? [
          db
            .prepare(`DELETE FROM knowledge_catalog_candidate_refresh_groups
      WHERE candidate_key IN (SELECT value FROM json_each(?)) AND ${guardSql}`)
            .bind(JSON.stringify(keys), state.generation, state.revision),
        ]
      : [],
  );
}

/** Complete or resume one refresh. A budget yield preserves progress before any review run exists.
 * Scheduled callers share a UTC-day request key; explicit callers can request a fresh generation.
 * As with crawl observations, pages are eventually consistent, not a transaction-wide snapshot.
 */
async function completeCandidateRefresh(
  db: QueryableDatabase,
  reviewedAt: string,
  { requestKey = crypto.randomUUID() }: { requestKey?: string } = {},
) {
  let state = await firstMeasured<RefreshState>(
    db.prepare("SELECT * FROM knowledge_catalog_candidate_refresh WHERE id = 1"),
  );
  if (state?.phase === "complete" && state.request_key === requestKey) return;
  if (!state || state.phase === "complete") {
    await db
      .prepare(`INSERT INTO knowledge_catalog_candidate_refresh
      (id, generation, request_key, started_at, phase, listing_horizon)
      VALUES (1, ?, ?, ?, 'collect', (SELECT COALESCE(MAX(id), 0) FROM products))
      ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, request_key = excluded.request_key,
        started_at = excluded.started_at, phase = 'collect', listing_horizon = excluded.listing_horizon,
        listing_cursor = 0, publish_cursor = '', retire_cursor = 0, revision = 0
      WHERE knowledge_catalog_candidate_refresh.phase = 'complete'
        AND knowledge_catalog_candidate_refresh.request_key <> excluded.request_key`)
      .bind(crypto.randomUUID(), requestKey, reviewedAt)
      .run();
  }
  for (;;) {
    state = await firstMeasured<RefreshState>(
      db.prepare("SELECT * FROM knowledge_catalog_candidate_refresh WHERE id = 1"),
    );
    if (!state) throw new Error("knowledge_catalog_candidate_refresh_missing");
    if (state.phase === "complete") return;
    switch (state.phase) {
      case "collect":
        await collectPage(db, state);
        break;
      case "publish":
        await publishPage(db, state);
        break;
      case "retire":
        await retirePage(db, state);
        break;
      case "clean":
        await cleanPage(db, state);
        break;
    }
  }
}

export async function refreshKnowledgeCatalogCandidates(db: QueryableDatabase, reviewedAt: string) {
  await completeCandidateRefresh(db, reviewedAt);
  return knowledgeCatalogCandidateStats(db);
}

export function prepareScheduledKnowledgeCatalogCandidates(db: QueryableDatabase, now: Date) {
  return completeCandidateRefresh(db, now.toISOString(), {
    requestKey: now.toISOString().slice(0, 10),
  });
}
