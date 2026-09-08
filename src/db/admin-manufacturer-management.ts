import type {
  AdminManufacturerAlias,
  AdminManufacturerEdit,
  AdminManufacturerRegistryDetail,
} from "../api/admin-manufacturer-contracts.js";
import type { ManufacturerAliasEvidence } from "../catalog/types.js";
import { bootstrapManufacturers, normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { MANUFACTURER_RESOLVER_VERSION } from "../catalog/manufacturer-resolver.js";
import { readAdminManufacturerAliases } from "./admin-manufacturer-registry.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export class ManufacturerRegistryConflict extends Error {}
export interface ManufacturerMatcher {
  manufacturerId: string;
  shopKey: string;
  keys: string[];
}
export interface ManufacturerChangeReceipt {
  operation_id: string;
  manufacturer_id: string;
  input_json: string;
  before_json: string;
  matcher_json: string;
  max_product_id: number;
  status: "applied" | "applying";
  created_at: string;
}
interface ProfileRow {
  canonical_name: string;
  name_ja: string;
  name_en: string;
  verification_status: string;
}
export async function registryVersion(db: ReadableDatabase): Promise<number> {
  const row = await db
    .prepare("SELECT version FROM admin_manufacturer_registry_clock WHERE id=1")
    .all<{ version: number }>()
    .then((result) => result.results[0] ?? null);
  if (!row) throw new Error("manufacturer_registry_clock_missing");
  return row.version;
}
export async function manufacturerRevision(
  version: number,
  edit: AdminManufacturerEdit,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ version, edit })),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function readManufacturerChange(db: ReadableDatabase, id: string) {
  return db
    .prepare("SELECT * FROM admin_manufacturer_changes WHERE operation_id=?")
    .bind(id)
    .all<ManufacturerChangeReceipt>()
    .then((result) => result.results[0] ?? null);
}
export async function readManufacturerRegistry(
  db: ReadableDatabase,
  manufacturerId: string,
): Promise<AdminManufacturerRegistryDetail> {
  const profile = await db
    .prepare(
      "SELECT canonical_name,name_ja,name_en,verification_status FROM knowledge_catalog_manufacturers WHERE id=?",
    )
    .bind(manufacturerId)
    .all<ProfileRow>()
    .then((result) => result.results[0] ?? null);
  const aliases = await db
    .prepare(`WITH global_page AS MATERIALIZED (
    SELECT alias,normalized_alias AS normalizedAlias,'' AS shopKey,verification_status AS status,source FROM knowledge_catalog_manufacturer_aliases WHERE manufacturer_id=? ORDER BY verification_status,normalized_alias LIMIT 501
  ), shop_page AS MATERIALIZED (
    SELECT alias,normalized_alias AS normalizedAlias,shop_key AS shopKey,verification_status AS status,source FROM knowledge_catalog_shop_manufacturer_aliases WHERE manufacturer_id=? ORDER BY shop_key,normalized_alias LIMIT 501
  ) SELECT * FROM global_page UNION ALL SELECT * FROM shop_page`)
    .bind(manufacturerId, manufacturerId)
    .all<AdminManufacturerAlias>();
  if (aliases.results.length > 500)
    throw new ManufacturerRegistryConflict("このメーカーの別名が管理上限500件を超えています。");
  const rows = [...aliases.results];
  const keys = new Set(rows.filter((row) => !row.shopKey).map((row) => row.normalizedAlias));
  const bundled = bootstrapManufacturers().find((row) => row.id === manufacturerId);
  for (const alias of bundled ? [bundled.name, ...bundled.aliases] : []) {
    const normalizedAlias = normalizeManufacturerKey(alias);
    if (!keys.has(normalizedAlias)) {
      rows.push({
        alias,
        normalizedAlias,
        shopKey: "",
        status: "verified",
        source: "code_bootstrap",
      });
      keys.add(normalizedAlias);
    }
  }
  const history = await db
    .prepare(
      "SELECT operation_id,created_at,input_json FROM admin_manufacturer_changes WHERE manufacturer_id=? AND status='applied' ORDER BY created_at DESC,operation_id DESC LIMIT 25",
    )
    .bind(manufacturerId)
    .all<Pick<ManufacturerChangeReceipt, "operation_id" | "created_at" | "input_json">>();
  return {
    profile: {
      manufacturerId,
      canonicalName: profile?.canonical_name ?? bundled?.name ?? "",
      nameJa: profile?.name_ja ?? "",
      nameEn: profile?.name_en ?? "",
    },
    exists: !!profile,
    aliases: rows,
    history: history.results.map((row) => ({
      operationId: row.operation_id,
      createdAt: row.created_at,
      edit: JSON.parse(row.input_json) as AdminManufacturerEdit,
    })),
    observedAt: new Date().toISOString(),
  };
}
export function plannedManufacturerAliases(
  edit: AdminManufacturerEdit,
  before?: AdminManufacturerRegistryDetail,
): ManufacturerAliasEvidence[] {
  const rows = new Map<string, ManufacturerAliasEvidence>();
  for (const field of ["canonicalName", "nameJa", "nameEn"] as const) {
    const alias = edit[field];
    if (!alias || (before?.exists && before.profile[field] === alias)) continue;
    const normalizedAlias = normalizeManufacturerKey(alias);
    rows.set(`\0${normalizedAlias}`, {
      manufacturerId: edit.manufacturerId,
      canonicalName: edit.canonicalName,
      alias,
      normalizedAlias,
      verificationStatus: "verified",
      source: "admin_alias_control",
      ruleVersion: MANUFACTURER_RESOLVER_VERSION,
    });
  }
  if (edit.alias) {
    const normalizedAlias = normalizeManufacturerKey(edit.alias.alias);
    rows.set(`${edit.alias.shopKey}\0${normalizedAlias}`, {
      manufacturerId: edit.manufacturerId,
      canonicalName: edit.canonicalName,
      alias: edit.alias.alias,
      normalizedAlias,
      shopKey: edit.alias.shopKey,
      verificationStatus: edit.alias.enabled ? "verified" : "rejected",
      source: "admin_alias_control",
      ruleVersion: MANUFACTURER_RESOLVER_VERSION,
    });
  }
  return [...rows.values()];
}
export function applyManufacturerDraft(
  rows: ManufacturerAliasEvidence[],
  edit: AdminManufacturerEdit,
  before: AdminManufacturerRegistryDetail,
) {
  const changes = plannedManufacturerAliases(edit, before);
  const key = (row: ManufacturerAliasEvidence) => `${row.shopKey ?? ""}\0${row.normalizedAlias}`;
  const replaced = new Set(changes.map(key));
  return [
    ...changes,
    ...rows
      .filter((row) => row.manufacturerId !== edit.manufacturerId || !replaced.has(key(row)))
      .map((row) =>
        row.manufacturerId === edit.manufacturerId
          ? { ...row, canonicalName: edit.canonicalName }
          : row,
      ),
  ];
}
export function manufacturerMatcher(
  before: AdminManufacturerRegistryDetail,
  edit: AdminManufacturerEdit,
): ManufacturerMatcher {
  const profileChanged =
    before.profile.canonicalName !== edit.canonicalName ||
    before.profile.nameJa !== edit.nameJa ||
    before.profile.nameEn !== edit.nameEn ||
    !before.exists;
  return {
    manufacturerId: edit.manufacturerId,
    shopKey: profileChanged ? "" : (edit.alias?.shopKey ?? ""),
    keys: [
      ...new Set(
        [
          ...before.aliases.map((row) => row.alias),
          before.profile.canonicalName,
          before.profile.nameJa,
          before.profile.nameEn,
          ...plannedManufacturerAliases(edit, before).map((row) => row.alias),
        ]
          .map(normalizeManufacturerKey)
          .filter(Boolean),
      ),
    ],
  };
}
export async function maxManufacturerListingId(db: ReadableDatabase): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM products ORDER BY id DESC LIMIT 1")
    .all<{ id: number }>()
    .then((result) => result.results[0] ?? null);
  return row?.id ?? 0;
}
interface ScanRow {
  id: number;
  shop_key: string;
  canonical_manufacturer_id: string;
  normalized_raw_manufacturer: string;
  title: string;
}
export async function scanManufacturerImpact(
  db: ReadableDatabase,
  matcher: ManufacturerMatcher,
  afterId: number,
  maxId: number,
  matchLimit = 20,
) {
  const scanLimit = matchLimit <= 5 ? 25 : 200;
  const select =
    "SELECT id,shop_key,canonical_manufacturer_id,normalized_raw_manufacturer,substr(title,1,4096) AS title FROM products";
  const read = async (active?: number) =>
    (
      await db
        .prepare(
          `${select} WHERE ${active === undefined ? "" : "shop_key=? AND is_active=? AND "}id>? AND id<=? ORDER BY id LIMIT ${scanLimit + 1}`,
        )
        .bind(...(active === undefined ? [] : [matcher.shopKey, active]), afterId, maxId)
        .all<ScanRow>()
    ).results;
  // Existing (shop_key,is_active,rowid) index bounds both active and retained inactive windows.
  const rows = matcher.shopKey
    ? [...(await read(0)), ...(await read(1))].sort((a, b) => a.id - b.id).slice(0, scanLimit + 1)
    : await read();
  const ids: number[] = [];
  let scanned = 0;
  let cursor = afterId;
  for (const row of rows.slice(0, scanLimit)) {
    scanned++;
    cursor = row.id;
    const normalizedTitle = normalizeManufacturerKey(row.title);
    if (
      row.canonical_manufacturer_id === matcher.manufacturerId ||
      matcher.keys.includes(row.normalized_raw_manufacturer) ||
      matcher.keys.some((key) => normalizedTitle.includes(key))
    )
      ids.push(row.id);
    if (ids.length >= matchLimit) break;
  }
  const hasMore = rows.length > scanned;
  return { ids, scanned, matched: ids.length, nextAfterId: cursor, hasMore };
}

/** Receipt insertion, all guarded writes and finalization share one D1 transaction. */
export async function applyManufacturerRegistry(
  db: QueryableDatabase,
  edit: AdminManufacturerEdit,
  revision: string,
  operationId: string,
): Promise<ManufacturerChangeReceipt> {
  const input = JSON.stringify(edit);
  const existing = await readManufacturerChange(db, operationId);
  if (existing) {
    if (existing.input_json !== input || existing.status !== "applied")
      throw new ManufacturerRegistryConflict("同じ操作IDに異なる内容が指定されています。");
    return existing;
  }
  const version = await registryVersion(db);
  if ((await manufacturerRevision(version, edit)) !== revision)
    throw new ManufacturerRegistryConflict("別の変更が入っています。影響を再確認してください。");
  const before = await readManufacturerRegistry(db, edit.manufacturerId);
  // Fail closed when the reference dictionary cannot be previewed completely.
  await readAdminManufacturerAliases(db);
  const changes = plannedManufacturerAliases(edit, before);
  if (
    !changes.length &&
    before.exists &&
    before.profile.canonicalName === edit.canonicalName &&
    before.profile.nameJa === edit.nameJa &&
    before.profile.nameEn === edit.nameEn
  )
    throw new ManufacturerRegistryConflict("変更する項目または別名を指定してください。");
  const count = await db
    .prepare(
      `WITH global_page AS MATERIALIZED (SELECT id FROM knowledge_catalog_manufacturer_aliases LIMIT 1001), shop_page AS MATERIALIZED (SELECT id FROM knowledge_catalog_shop_manufacturer_aliases LIMIT 1001) SELECT (SELECT COUNT(*) FROM global_page)+(SELECT COUNT(*) FROM shop_page) AS n`,
    )
    .all<{ n: number }>()
    .then((result) => result.results[0] ?? null);
  let additions = 0;
  for (const row of changes) {
    const table = row.shopKey
      ? "knowledge_catalog_shop_manufacturer_aliases"
      : "knowledge_catalog_manufacturer_aliases";
    const found = await db
      .prepare(
        `SELECT id FROM ${table} WHERE manufacturer_id=? AND normalized_alias=?${row.shopKey ? " AND shop_key=?" : ""}`,
      )
      .bind(row.manufacturerId, row.normalizedAlias, ...(row.shopKey ? [row.shopKey] : []))
      .all()
      .then((result) => result.results[0] ?? null);
    if (!found) additions++;
  }
  if ((count?.n ?? 1001) + additions > 1000)
    throw new ManufacturerRegistryConflict("別名辞書の上限1000件を超えるため追加できません。");
  const at = new Date().toISOString();
  const matcher = manufacturerMatcher(before, edit);
  const guard =
    "EXISTS(SELECT 1 FROM admin_manufacturer_changes WHERE operation_id=? AND status='applying')";
  const statements = [
    db
      .prepare(`INSERT INTO admin_manufacturer_changes(operation_id,manufacturer_id,input_json,before_json,matcher_json,max_product_id,status,created_at)
    SELECT ?,?,?,?,?,COALESCE((SELECT id FROM products ORDER BY id DESC LIMIT 1),0),'applying',? WHERE (SELECT version FROM admin_manufacturer_registry_clock WHERE id=1)=? ON CONFLICT(operation_id) DO NOTHING`)
      .bind(
        operationId,
        edit.manufacturerId,
        input,
        JSON.stringify(before),
        JSON.stringify(matcher),
        at,
        version,
      ),
  ];
  statements.push(
    db
      .prepare(`INSERT INTO knowledge_catalog_manufacturers(id,canonical_name,name_ja,name_en,verification_status,source,created_at,updated_at)
    SELECT ?,?,?,?,'verified','admin_registry',?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM knowledge_catalog_manufacturers WHERE id=?)`)
      .bind(
        edit.manufacturerId,
        edit.canonicalName,
        edit.nameJa,
        edit.nameEn,
        at,
        at,
        operationId,
        edit.manufacturerId,
      ),
  );
  statements.push(
    db
      .prepare(
        `UPDATE knowledge_catalog_manufacturers SET canonical_name=?,name_ja=?,name_en=?,verification_status='verified',updated_at=? WHERE id=? AND ${guard} AND (canonical_name IS NOT ? OR name_ja IS NOT ? OR name_en IS NOT ? OR verification_status!='verified')`,
      )
      .bind(
        edit.canonicalName,
        edit.nameJa,
        edit.nameEn,
        at,
        edit.manufacturerId,
        operationId,
        edit.canonicalName,
        edit.nameJa,
        edit.nameEn,
      ),
  );
  for (const row of plannedManufacturerAliases(edit, before)) {
    const scoped = !!row.shopKey;
    const table = scoped
      ? "knowledge_catalog_shop_manufacturer_aliases"
      : "knowledge_catalog_manufacturer_aliases";
    const where = `manufacturer_id=? AND normalized_alias=?${scoped ? " AND shop_key=?" : ""}`;
    const keys = [row.manufacturerId, row.normalizedAlias, ...(scoped ? [row.shopKey!] : [])];
    statements.push(
      db
        .prepare(
          `INSERT INTO ${table}(manufacturer_id,alias,normalized_alias,verification_status,source,rule_version,created_at,updated_at${scoped ? ",shop_key" : ""}) SELECT ?,?,?,?,'admin_alias_control',?,?,?${scoped ? ",?" : ""} WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM ${table} WHERE ${where})`,
        )
        .bind(
          row.manufacturerId,
          row.alias,
          row.normalizedAlias,
          row.verificationStatus,
          row.ruleVersion,
          at,
          at,
          ...(scoped ? [row.shopKey!] : []),
          operationId,
          ...keys,
        ),
    );
    statements.push(
      db
        .prepare(
          `UPDATE ${table} SET alias=?,verification_status=?,source='admin_alias_control',rule_version=?,updated_at=? WHERE ${where} AND ${guard} AND (alias IS NOT ? OR verification_status IS NOT ? OR source!='admin_alias_control')`,
        )
        .bind(
          row.alias,
          row.verificationStatus,
          row.ruleVersion,
          at,
          ...keys,
          operationId,
          row.alias,
          row.verificationStatus,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        "UPDATE admin_manufacturer_changes SET status='applied' WHERE operation_id=? AND status='applying'",
      )
      .bind(operationId),
  );
  await db.batch(statements);
  const receipt = await readManufacturerChange(db, operationId);
  if (!receipt || receipt.input_json !== input || receipt.status !== "applied")
    throw new ManufacturerRegistryConflict("別の変更が入っています。影響を再確認してください。");
  return receipt;
}
