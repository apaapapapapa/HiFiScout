import {
  ADMIN_CSV_FIELDS,
  type AdminCsvApplyInput,
  type AdminCsvChange,
  type AdminCsvKind,
  type AdminCsvResult,
  type AdminCsvValues,
} from "../api/admin-csv-contracts.js";
import { categoryIdForClassification, getCategory } from "../catalog/categories.js";
import { normalizeCatalogModel } from "../catalog/knowledge-catalog.js";
import { normalizeIdentityModel } from "../catalog/product-identity.js";
import { updateListingAdminProduct } from "./listing-admin-repository.js";
import { refreshListingProjections } from "./listing-projection-refresh.js";
import { reclassifyAdminCsvListings } from "./knowledge-catalog-repository.js";
import { replayAdminCsvListings } from "./data-quality-remediation-service.js";
import { loadCatalogRemediationTarget } from "./knowledge-catalog-remediation-repository.js";
import {
  catalogAdminCategoryIds,
  propagateCatalogCategoryToMatchedListings,
} from "./knowledge-catalog-admin-repository.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";

const REPLAY_PAGE_SIZE = 10;
const CATALOG_PRIMARY =
  "(SELECT category_id FROM knowledge_catalog_product_categories WHERE product_id = p.id AND is_primary = 1 LIMIT 1)";
const STATE_SQL: Record<AdminCsvKind, string> = {
  listing: `
    SELECT json_object('manufacturer_id', p.canonical_manufacturer_id, 'model', p.model,
                       'primary_category_id', p.primary_category_id) AS values_json,
           json_array(p.canonical_manufacturer_id, p.manufacturer_id, p.manufacturer, p.model,
             p.normalized_model, p.primary_category_id, p.category_ids, p.direct_category_ids,
             p.classification_status, p.presentation_color, p.raw_manufacturer, p.raw_model,
             p.raw_category, p.title, COALESCE(o.updated_at, '')) AS revision,
           p.shop_key, p.source_id, p.remediation_projection_required AS pending,
           '' AS verification_status
    FROM products p LEFT JOIN product_admin_overrides o ON o.listing_product_id = p.id
    WHERE p.id = ?
  `,
  catalog: `
    SELECT json_object('manufacturer_id', p.manufacturer_id, 'canonical_model', p.canonical_model,
             'canonical_name', p.canonical_name, 'primary_category_id', COALESCE(${CATALOG_PRIMARY}, ''),
             'lifecycle_status', p.lifecycle_status) AS values_json,
           json_array(p.manufacturer_id, p.canonical_model, p.normalized_model, p.canonical_name,
             p.lifecycle_status, p.verification_status, p.updated_at,
             (SELECT json_group_array(json_array(category_id, is_primary))
              FROM (SELECT category_id, is_primary FROM knowledge_catalog_product_categories
                    WHERE product_id = p.id ORDER BY category_id))) AS revision,
           '' AS shop_key, '' AS source_id, 0 AS pending, p.verification_status
    FROM knowledge_catalog_products p WHERE p.id = ?
  `,
};

interface State {
  values_json: string;
  revision: string;
  shop_key: string;
  source_id: string;
  pending: number;
  verification_status: string;
}

interface Receipt {
  operation_id: string;
  target_kind: AdminCsvKind;
  target_id: number;
  before_json: string;
  after_json: string;
  revision: string;
  status: "pending" | "applied";
  phase: number;
  after_listing_id: number;
}

function valuesFor(change: AdminCsvChange): AdminCsvValues {
  return Object.fromEntries(
    ADMIN_CSV_FIELDS[change.original.kind].map((field) => [
      field,
      change.values[field] === change.original.values[field]
        ? change.values[field]
        : change.values[field].trim(),
    ]),
  );
}

function same(kind: AdminCsvKind, left: AdminCsvValues, right: AdminCsvValues): boolean {
  return ADMIN_CSV_FIELDS[kind].every((field) => left[field] === right[field]);
}

function result(
  change: AdminCsvChange,
  status: AdminCsvResult["status"],
  message: string,
  extra: Partial<AdminCsvResult> = {},
): AdminCsvResult {
  return {
    line: change.line,
    id: change.original.id,
    kind: change.original.kind,
    status,
    message,
    ...extra,
  };
}

async function loadState(
  db: ReadableDatabase,
  kind: AdminCsvKind,
  id: number,
): Promise<State | null> {
  return firstMeasured<State>(db.prepare(STATE_SQL[kind]).bind(id));
}

async function revisionToken(revision: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(revision));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function transactionGuard(
  db: QueryableDatabase,
  kind: AdminCsvKind,
  id: number,
  revision: string,
): D1PreparedStatement {
  // This statement is inside the SAME D1 batch as the changes and receipt. An absent/changed row
  // produces malformed JSON, aborting the entire transaction, including override deletion.
  return db
    .prepare(`SELECT json(CASE WHEN
    (SELECT revision FROM (${STATE_SQL[kind]})) = ?
    THEN 'true' ELSE 'csv_import_conflict' END)`)
    .bind(id, revision);
}

async function pendingReceipt(
  db: ReadableDatabase,
  change: AdminCsvChange,
  values: AdminCsvValues,
): Promise<Receipt | null> {
  return firstMeasured<Receipt>(
    db
      .prepare(`SELECT * FROM admin_csv_import_changes
    WHERE target_kind = ? AND target_id = ? AND status = 'pending' AND after_json = ?
    LIMIT 1`)
      .bind(change.original.kind, change.original.id, JSON.stringify(values)),
  );
}

async function invalidReason(
  db: ReadableDatabase,
  change: AdminCsvChange,
  values: AdminCsvValues,
): Promise<string | null> {
  const before = change.original.values;
  const kind = change.original.kind;
  for (const field of ADMIN_CSV_FIELDS[kind]) {
    if (values[field] === before[field]) continue;
    const value = values[field];
    if (value.includes("[truncated]"))
      return "省略された値は更新できません。元情報を確認してください。";
    if (field === "manufacturer_id") {
      if (!value && kind === "listing") continue;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 100) {
        return "メーカーは検証済みのメーカーIDを指定してください。";
      }
      const manufacturer = await firstMeasured(
        db
          .prepare(`SELECT id FROM knowledge_catalog_manufacturers
        WHERE id = ? AND verification_status = 'verified'`)
          .bind(value),
      );
      if (!manufacturer) return "指定したメーカーIDは未登録、または未検証です。";
    } else if (field === "primary_category_id") {
      if (!getCategory(value)?.classifiable || categoryIdForClassification(value) !== value) {
        return "カテゴリは分類可能な現在のカテゴリIDを指定してください。";
      }
    } else if (field === "lifecycle_status") {
      if (!["unknown", "active", "discontinued"].includes(value)) return "製品状態の値が不正です。";
    } else if (field === "canonical_name") {
      if (!value || value.length > 300) return "正式名称は1〜300文字で入力してください。";
    } else if (
      value.length > 200 ||
      (value && !normalizeIdentityModel(value)) ||
      (kind === "catalog" && !normalizeCatalogModel(value))
    ) {
      return "型番は有効な文字列を200文字以内で入力してください。";
    }
  }
  if (
    kind === "catalog" &&
    (values.manufacturer_id !== before.manufacturer_id ||
      values.canonical_model !== before.canonical_model)
  ) {
    const duplicate = await firstMeasured<{ id: number }>(
      db
        .prepare(`SELECT id FROM knowledge_catalog_products
      WHERE manufacturer_id = ? AND normalized_model = ? AND id <> ? LIMIT 1`)
        .bind(
          values.manufacturer_id,
          normalizeCatalogModel(values.canonical_model),
          change.original.id,
        ),
    );
    if (duplicate)
      return (
        "同じメーカー・型番のカタログ #" +
        duplicate.id +
        " が存在します。統合画面で確認してください。"
      );
  }
  return null;
}

export async function previewAdminCsvChange(
  db: ReadableDatabase,
  change: AdminCsvChange,
): Promise<AdminCsvResult> {
  const state = await loadState(db, change.original.kind, change.original.id);
  if (!state) return result(change, "invalid", "対象IDが存在しません。");
  const values = valuesFor(change);
  const current = JSON.parse(state.values_json) as AdminCsvValues;
  if (same(change.original.kind, current, values)) {
    const pending = await pendingReceipt(db, change, values);
    if (pending)
      return result(change, "pending", "データは更新済みです。関連商品の反映を再開できます。", {
        operationId: pending.operation_id,
        revision: pending.revision,
      });
    return result(change, "unchanged", "現在のデータと一致しています。");
  }
  if (!same(change.original.kind, current, change.original.values)) {
    return result(
      change,
      "conflict",
      "CSV出力後にデータが変更されています。最新のCSVで再確認してください。",
    );
  }
  const invalid = await invalidReason(db, change, values);
  if (invalid) return result(change, "invalid", invalid);
  return result(change, "ready", "更新できます。", {
    revision: await revisionToken(state.revision),
  });
}

function receiptStatement(
  db: QueryableDatabase,
  input: AdminCsvApplyInput,
  values: AdminCsvValues,
  now: string,
): D1PreparedStatement {
  const { original } = input.change;
  // Preserve removed alias/source evidence with the before-image, inside the atomic write.
  const before =
    original.kind === "catalog"
      ? `json_object('values', json(?),
        'aliases', (SELECT json_group_array(json_object('alias', alias, 'normalized_alias',
          normalized_alias, 'alias_type', alias_type)) FROM knowledge_catalog_aliases WHERE product_id = ?),
        'sources', (SELECT json_group_array(json_object('source_type', source_type, 'source_url',
          source_url, 'status', status)) FROM knowledge_catalog_sources WHERE product_id = ?))`
      : "json_object('values', json(?))";
  const parameters: (string | number)[] = [
    input.operationId,
    original.kind,
    original.id,
    JSON.stringify(original.values),
  ];
  if (original.kind === "catalog") parameters.push(original.id, original.id);
  parameters.push(JSON.stringify(values), input.revision, now, now);
  return db
    .prepare(`INSERT INTO admin_csv_import_changes(
    operation_id, target_kind, target_id, before_json, after_json, revision, status, created_at, updated_at
  ) VALUES (?, ?, ?, ${before}, ?, ?, 'pending', ?, ?)`)
    .bind(...parameters);
}

async function updateCatalog(
  db: QueryableDatabase,
  input: AdminCsvApplyInput,
  values: AdminCsvValues,
  now: string,
  revision: string,
): Promise<void> {
  const { original } = input.change;
  const id = original.id;
  const before = original.values;
  const identityChanged =
    before.manufacturer_id !== values.manufacturer_id ||
    normalizeCatalogModel(before.canonical_model) !== normalizeCatalogModel(values.canonical_model);
  const statements = [
    transactionGuard(db, "catalog", id, revision),
    receiptStatement(db, input, values, now),
    db
      .prepare(`UPDATE knowledge_catalog_products
      SET manufacturer_id = ?, canonical_model = ?, normalized_model = ?, canonical_name = ?,
          lifecycle_status = ?, review_status = 'current', last_reviewed_at = ?, updated_at = ?
      WHERE id = ?`)
      .bind(
        values.manufacturer_id,
        values.canonical_model,
        normalizeCatalogModel(values.canonical_model),
        values.canonical_name,
        values.lifecycle_status,
        now,
        now,
        id,
      ),
  ];
  if (before.primary_category_id !== values.primary_category_id) {
    statements.push(
      db.prepare("DELETE FROM knowledge_catalog_product_categories WHERE product_id = ?").bind(id),
    );
    for (const category of catalogAdminCategoryIds(values.primary_category_id)) {
      statements.push(
        db
          .prepare(`INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
        VALUES (?, ?, ?)`)
          .bind(id, category, category === values.primary_category_id ? 1 : 0),
      );
    }
  }
  if (identityChanged) {
    statements.push(
      db.prepare("DELETE FROM knowledge_catalog_aliases WHERE product_id = ?").bind(id),
      db
        .prepare(`UPDATE knowledge_catalog_sources SET status = 'error', updated_at = ?
        WHERE product_id = ? AND status = 'active'`)
        .bind(now, id),
      db
        .prepare(`UPDATE knowledge_catalog_candidates
        SET catalog_product_id = NULL, review_status = 'pending', updated_at = ?
        WHERE catalog_product_id = ?`)
        .bind(now, id),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO knowledge_catalog_sources(
    product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
  ) VALUES (?, 'manual_verified', ?, ?, '', 'active', ?, ?)`)
      .bind(id, "manual://csv-import/" + input.operationId, now, now, now),
  );
  await db.batch(statements);
}

async function resumeReceipt(
  db: QueryableDatabase,
  input: AdminCsvApplyInput,
  receipt: Receipt,
  now: string,
): Promise<AdminCsvResult> {
  const { change } = input;
  const state = await loadState(db, receipt.target_kind, receipt.target_id);
  const desired = JSON.parse(receipt.after_json) as AdminCsvValues;
  if (
    !state ||
    !same(receipt.target_kind, JSON.parse(state.values_json) as AdminCsvValues, desired)
  ) {
    return result(
      change,
      "conflict",
      "適用後に別の変更がありました。最新データを再確認してください。",
    );
  }
  if (receipt.status === "applied") return result(change, "applied", "適用済みです。");
  if (receipt.target_kind === "listing") {
    await refreshListingProjections(
      db,
      [
        {
          id: receipt.target_id,
          shop_key: state.shop_key,
          source_id: state.source_id,
        },
      ],
      now,
    );
  } else if (receipt.phase < 3) {
    let selected: { id: number; shop_key: string; source_id: string }[] = [];
    if (receipt.phase < 2) {
      const column = receipt.phase === 0 ? "catalog_product_id" : "candidate_catalog_product_id";
      const rows = await db
        .prepare(`
        SELECT p.id, p.shop_key, p.source_id FROM product_identity_resolutions r
        JOIN products p ON p.id = r.listing_product_id
        WHERE r.${column} = ? AND r.listing_product_id > ?
        ORDER BY r.listing_product_id LIMIT ?`)
        .bind(receipt.target_id, receipt.after_listing_id, REPLAY_PAGE_SIZE)
        .all<{ id: number; shop_key: string; source_id: string }>();
      selected = rows.results || [];
    } else {
      const target = await loadCatalogRemediationTarget(db, receipt.target_id);
      if (target?.identityModels.length) {
        const rows = await db
          .prepare(`SELECT id, shop_key, source_id FROM products
          WHERE canonical_manufacturer_id = ? AND normalized_model IN (${target.identityModels.map(() => "?").join(",")})
            AND id > ? ORDER BY id LIMIT ?`)
          .bind(
            target.manufacturerId,
            ...target.identityModels,
            receipt.after_listing_id,
            REPLAY_PAGE_SIZE,
          )
          .all<{ id: number; shop_key: string; source_id: string }>();
        selected = rows.results || [];
      }
    }
    const before = (JSON.parse(receipt.before_json) as { values: AdminCsvValues }).values;
    const identityChanged =
      before.manufacturer_id !== desired.manufacturer_id ||
      normalizeCatalogModel(before.canonical_model) !==
        normalizeCatalogModel(desired.canonical_model);
    if (
      !identityChanged &&
      receipt.phase === 0 &&
      before.primary_category_id !== desired.primary_category_id
    ) {
      await propagateCatalogCategoryToMatchedListings(
        db,
        receipt.target_id,
        catalogAdminCategoryIds(desired.primary_category_id),
        now,
        selected.map((row) => row.id),
      );
    } else if (identityChanged) {
      await replayAdminCsvListings(
        db,
        selected.map((row) => row.id),
        now,
      );
    } else {
      await refreshListingProjections(db, selected, now);
    }
    await reclassifyAdminCsvListings(
      db,
      selected.map((row) => row.id),
      now,
    );
    const phase = selected.length < REPLAY_PAGE_SIZE ? receipt.phase + 1 : receipt.phase;
    const cursor = phase === receipt.phase ? selected.at(-1)?.id || 0 : 0;
    // A retry/concurrent tab can only advance the cursor it actually observed.
    await db
      .prepare(`UPDATE admin_csv_import_changes SET phase = ?, after_listing_id = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending' AND phase = ? AND after_listing_id = ?`)
      .bind(phase, cursor, now, receipt.operation_id, receipt.phase, receipt.after_listing_id)
      .run();
    return result(change, "pending", "関連商品と検索表示を反映しています。", {
      operationId: receipt.operation_id,
    });
  }
  await db
    .prepare(`UPDATE admin_csv_import_changes SET status = 'applied', updated_at = ?
    WHERE operation_id = ? AND status = 'pending'`)
    .bind(now, receipt.operation_id)
    .run();
  return result(change, "applied", "更新と検索表示への反映が完了しました。", {
    operationId: receipt.operation_id,
  });
}

export async function applyAdminCsvChange(
  db: QueryableDatabase,
  input: AdminCsvApplyInput,
): Promise<AdminCsvResult> {
  const { change } = input;
  const values = valuesFor(change);
  const now = new Date().toISOString();
  try {
    let receipt = await firstMeasured<Receipt>(
      db
        .prepare("SELECT * FROM admin_csv_import_changes WHERE operation_id = ?")
        .bind(input.operationId),
    );
    if (receipt) {
      if (
        receipt.target_kind !== change.original.kind ||
        receipt.target_id !== change.original.id ||
        receipt.after_json !== JSON.stringify(values)
      ) {
        return result(change, "invalid", "操作IDと修正内容が一致しません。");
      }
    } else {
      const preview = await previewAdminCsvChange(db, change);
      if (preview.status !== "ready") return preview;
      if (preview.revision !== input.revision) {
        return result(
          change,
          "conflict",
          "差分確認後にデータが変更されました。再確認してください。",
        );
      }
      const state = await loadState(db, change.original.kind, change.original.id);
      if (!state || (await revisionToken(state.revision)) !== input.revision) {
        return result(
          change,
          "conflict",
          "差分確認後にデータが変更されました。再確認してください。",
        );
      }
      if (change.original.kind === "listing") {
        const before = change.original.values;
        await updateListingAdminProduct(
          db,
          change.original.id,
          {
            ...(values.manufacturer_id !== before.manufacturer_id
              ? { manufacturerId: values.manufacturer_id }
              : {}),
            ...(values.model !== before.model ? { model: values.model } : {}),
            ...(values.primary_category_id !== before.primary_category_id
              ? { primaryCategoryId: values.primary_category_id }
              : {}),
          },
          now,
          [
            transactionGuard(db, "listing", change.original.id, state.revision),
            receiptStatement(db, input, values, now),
          ],
        );
        // The existing listing path has already completed all projections. Only recovery
        // after a partial failure needs to replay them via resumeReceipt.
        await db
          .prepare(`UPDATE admin_csv_import_changes SET status = 'applied', updated_at = ?
          WHERE operation_id = ? AND status = 'pending'`)
          .bind(now, input.operationId)
          .run();
        return result(change, "applied", "更新と検索表示への反映が完了しました。", {
          operationId: input.operationId,
        });
      } else {
        await updateCatalog(db, input, values, now, state.revision);
      }
      receipt = await firstMeasured<Receipt>(
        db
          .prepare("SELECT * FROM admin_csv_import_changes WHERE operation_id = ?")
          .bind(input.operationId),
      );
    }
    if (!receipt) return result(change, "failed", "更新結果を確認できません。再試行してください。");
    return await resumeReceipt(db, input, receipt, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "admin_csv_import_failed",
        operationId: input.operationId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const receipt = await firstMeasured(
      db
        .prepare("SELECT operation_id FROM admin_csv_import_changes WHERE operation_id = ?")
        .bind(input.operationId),
    );
    if (receipt)
      return result(
        change,
        "failed",
        "一部反映済みです。同じCSVで再試行すると続きから再開します。",
        {
          operationId: input.operationId,
        },
      );
    return result(
      change,
      "failed",
      "更新できませんでした。データ競合または利用上限の可能性があります。再確認してください。",
    );
  }
}
