import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  ADMIN_CSV_FIELDS,
  adminCsvCell,
  adminCsvEditHeader,
  adminCsvEditRow,
  adminCsvNewCatalog,
  adminCsvOriginal,
  adminCsvPreviewBatches,
  adminCsvPreviewResults,
  type AdminCsvChange,
} from "../src/api/admin-csv-contracts.js";
import { parseCsv, readAdminCsv } from "../frontend/admin-csv-parser.js";
import { resultCsv } from "../frontend/admin-csv-import.js";
import { parseAdminCsvApply, parseAdminCsvPreview } from "../src/http/admin-csv-import.js";
import {
  applyAdminCsvChange,
  previewAdminCsvChange,
} from "../src/db/admin-csv-import-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase, queryPlan } from "./helpers/query-plan.js";

const values = {
  manufacturer_id: "luxman",
  canonical_model: "CSV-NEW100",
  canonical_name: "LUXMAN CSV-NEW100",
  primary_category_id: "AMP.PRE",
  lifecycle_status: "unknown",
};
const create = (patch = {}): AdminCsvChange => ({
  line: 2,
  original: adminCsvNewCatalog(),
  values: { ...values, ...patch },
});
const newRow = (patch = {}) =>
  ["", "", ...Object.values({ ...values, ...patch })].map(adminCsvCell).join(",");
const header = "catalog_product_id," + adminCsvEditHeader("catalog");
const at = "2026-09-06T00:00:00.000Z";

function database() {
  const setup = migratedSqlite();
  setup.sqlite
    .exec(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
    VALUES('luxman','LUXMAN','${at}','${at}');`);
  return setup;
}

async function inputFor(db: ReturnType<typeof database>["db"], change = create()) {
  const preview = await previewAdminCsvChange(db, change);
  assert.equal(preview.status, "ready", preview.message);
  return { change, revision: preview.revision || "", operationId: crypto.randomUUID() };
}

test("one edit CSV supports updates and blank-ID catalog additions without weakening existing snapshots", () => {
  const original = adminCsvOriginal("catalog", 1, { ...values, canonical_model: "OLD100" });
  const edited = adminCsvEditRow(original).replace(/,"OLD100",/u, ',"OLD101",');
  const parsed = readAdminCsv(header + "\n1," + edited + "\n" + newRow());
  assert.equal(parsed.totalRows, 2);
  assert.equal(parsed.unchangedRows, 0);
  assert.equal(parsed.changes[0].original.id, 1);
  assert.equal(parsed.changes[0].values.canonical_model, "OLD101");
  assert.deepEqual(parsed.changes[1], { ...create(), line: 3 });
  assert.throws(
    () => readAdminCsv(header + "\n" + newRow().replace(/^""/u, '"1"')),
    /csv_original/u,
  );
  assert.throws(() => readAdminCsv(header + "\n," + adminCsvEditRow(original)), /対象ID/u);
  assert.throws(
    () => readAdminCsv("listing_id," + adminCsvEditHeader("listing") + "\n,,luxman,C10,AMP.PRE"),
    /csv_original/u,
  );
  assert.throws(
    () =>
      readAdminCsv(header.replace(",edit_canonical_name", "") + "\n,,luxman,C10,AMP.PRE,unknown"),
    /edit_canonical_name/u,
  );
});

test("CSV rejects duplicate new identities across preview batches and against unchanged existing rows", () => {
  const rows = Array.from({ length: 22 }, (_, index) => newRow({ canonical_model: "NEW" + index }));
  const parsed = readAdminCsv([header, ...rows].join("\n"));
  assert.equal([...adminCsvPreviewBatches(parsed.changes)].length, 2);
  assert.throws(
    () => readAdminCsv([header, ...rows, newRow({ canonical_model: "NEW0" })].join("\n")),
    /重複/u,
  );
  const original = adminCsvOriginal("catalog", 1, values);
  for (const ordered of [
    ["1," + adminCsvEditRow(original), newRow()],
    [newRow(), "1," + adminCsvEditRow(original)],
  ])
    assert.throws(() => readAdminCsv([header, ...ordered].join("\n")), /重複/u);
});

test("API accepts only an empty catalog before-image for creation and rejects duplicate identities", () => {
  assert.deepEqual(
    parseAdminCsvPreview({ changes: [create(), create({ canonical_model: "NEW200" })] }),
    [create(), create({ canonical_model: "NEW200" })],
  );
  assert.equal(
    parseAdminCsvPreview({ changes: [create(), create({ canonical_model: "CSVNEW100" })] }),
    null,
  );
  for (const original of [
    { ...adminCsvNewCatalog(), kind: "listing" },
    { ...adminCsvNewCatalog(), values },
    { ...adminCsvNewCatalog(), id: 0 },
  ])
    assert.equal(parseAdminCsvPreview({ changes: [{ ...create(), original }] }), null);
  assert.equal(parseAdminCsvPreview({ changes: [create({ canonical_name: "bad\nname" })] }), null);
  assert.ok(
    parseAdminCsvApply({ change: create(), revision: "token", operationId: crypto.randomUUID() }),
  );
});

test("server identity keys reject logical duplicates across all browser preview batches", async () => {
  const { db, sqlite } = database();
  try {
    const rows = Array.from({ length: 22 }, (_, index) =>
      newRow({ canonical_model: "NEW" + index }),
    );
    const parsed = readAdminCsv([header, ...rows, newRow({ canonical_model: "NEW-0" })].join("\n"));
    const results = [];
    for (const batch of adminCsvPreviewBatches(parsed.changes)) {
      assert.ok(parseAdminCsvPreview({ changes: batch }));
      for (const change of batch) results.push(await previewAdminCsvChange(db, change));
    }
    assert.ok(results.every((row) => row.status === "ready"));
    const checked = adminCsvPreviewResults(parsed.changes, results);
    assert.equal(checked[0].status, "invalid");
    assert.equal(checked[22].status, "invalid");
    assert.equal(checked.filter((row) => row.status === "ready").length, 21);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 0);
  } finally {
    sqlite.close();
  }
});

test("catalog insertion is atomic, verified, auditable, round-trippable and idempotent", async () => {
  const { db, sqlite } = database();
  try {
    const input = await inputFor(db);
    const result = await applyAdminCsvChange(db, input);
    assert.equal(result.status, "applied", result.message);
    assert.ok(result.id);
    const id = result.id;
    const row = sqlite
      .prepare(
        "SELECT manufacturer_id,canonical_model,canonical_name,verification_status FROM knowledge_catalog_products WHERE id=?",
      )
      .get(id);
    assert.deepEqual(
      { ...row },
      {
        manufacturer_id: "luxman",
        canonical_model: values.canonical_model,
        canonical_name: values.canonical_name,
        verification_status: "verified",
      },
    );
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT category_id,is_primary FROM knowledge_catalog_product_categories WHERE product_id=? ORDER BY category_id",
        )
        .all(id)
        .map((row) => ({ ...row })),
      [
        { category_id: "AMP", is_primary: 0 },
        { category_id: "AMP.PRE", is_primary: 1 },
      ],
    );
    assert.equal(
      sqlite.prepare("SELECT product_id FROM knowledge_catalog_aliases WHERE product_id=?").get(id)
        ?.product_id,
      id,
    );
    assert.equal(
      sqlite.prepare("SELECT source_type FROM knowledge_catalog_sources WHERE product_id=?").get(id)
        ?.source_type,
      "manual_verified",
    );
    assert.equal(
      sqlite
        .prepare("SELECT target_id FROM admin_csv_import_changes WHERE operation_id=?")
        .get(input.operationId)?.target_id,
      id,
    );
    const output = resultCsv([input.change], [result]);
    const rows = [...parseCsv(output)];
    assert.equal(rows[1].cells[rows[0].cells.indexOf("result_target_id")], String(id));
    const retry = readAdminCsv(output).changes[0];
    assert.deepEqual(retry, input.change);
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.equal((await previewAdminCsvChange(db, retry)).status, "unchanged");
    assert.equal((await applyAdminCsvChange(db, input)).id, id);
    assert.equal(
      (await applyAdminCsvChange(db, { ...input, operationId: crypto.randomUUID() })).status,
      "unchanged",
    );
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);

    const edit = {
      line: 2,
      original: adminCsvOriginal("catalog", id, values),
      values: { ...values, canonical_name: "Corrected name" },
    };
    assert.equal((await applyAdminCsvChange(db, await inputFor(db, edit))).status, "applied");
    assert.equal(
      (await previewAdminCsvChange(db, input.change)).status,
      "invalid",
      "an old addition cannot overwrite a later correction",
    );
  } finally {
    sqlite.close();
  }
});

test("creation requires every field and blocks existing, rejected and logical duplicate identities", async () => {
  const { db, sqlite } = database();
  try {
    for (const field of ADMIN_CSV_FIELDS.catalog)
      assert.equal(
        (await previewAdminCsvChange(db, create({ [field]: "" }))).status,
        "invalid",
        field,
      );
    for (const patch of [
      { manufacturer_id: "missing-brand" },
      { primary_category_id: "unclassified" },
      { canonical_model: "!" },
      { lifecycle_status: "invalid" },
      { canonical_name: "a".repeat(301) },
    ])
      assert.equal((await previewAdminCsvChange(db, create(patch))).status, "invalid");
    const input = await inputFor(db);
    const inserted = await applyAdminCsvChange(db, input);
    assert.equal(
      (await previewAdminCsvChange(db, create({ canonical_model: "CSVNEW100" }))).status,
      "invalid",
    );
    sqlite
      .prepare("UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=?")
      .run(inserted.id);
    assert.equal((await previewAdminCsvChange(db, create())).status, "invalid");
    assert.equal((await applyAdminCsvChange(db, input)).status, "conflict");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 1);
  } finally {
    sqlite.close();
  }
});

test("a concurrent spelling variant or source failure rolls back the new product and its receipt", async () => {
  for (const failure of ["race", "source"] as const) {
    const { db, sqlite } = database();
    try {
      const input = await inputFor(db);
      if (failure === "source")
        sqlite.exec(`CREATE TEMP TRIGGER fail_csv_source BEFORE INSERT ON knowledge_catalog_sources
        BEGIN SELECT RAISE(ABORT,'injected source failure'); END;`);
      const racing = {
        prepare: db.prepare.bind(db),
        async batch<T = unknown>(statements: D1PreparedStatement[]) {
          if (failure === "race")
            sqlite.exec(`INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
            VALUES('luxman','CSVNEW100','CSVNEW100','${at}','${at}')`);
          return db.batch<T>(statements);
        },
      };
      assert.equal((await applyAdminCsvChange(racing, input)).status, "failed");
      assert.equal(
        sqlite
          .prepare(
            "SELECT COUNT(*) n FROM knowledge_catalog_products WHERE canonical_model='CSV-NEW100'",
          )
          .get()?.n,
        0,
      );
      assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 0);
    } finally {
      sqlite.close();
    }
  }
});

test("creation resumes ten-listing discovery pages after a lost response and preserves explicit overrides", async () => {
  const { db, sqlite } = database();
  try {
    sqlite.exec(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<12)
      INSERT INTO products(id,shop_key,source_id,title,manufacturer,manufacturer_id,canonical_manufacturer_id,
        model,normalized_model,raw_model,raw_manufacturer,manufacturer_resolution_status,model_resolution_status,
        primary_category_id,category_ids,direct_category_ids,classification_status,source_url,
        first_seen_at,last_seen_at,last_changed_at,is_active)
      SELECT 90000+id,'hifido','csv-new-'||id,'LUXMAN CSV-NEW100','LUXMAN','luxman','luxman',
        'CSV-NEW100','CSVNEW100','CSV-NEW100','LUXMAN','resolved','resolved','AMP.PRE','["AMP.PRE","AMP"]',
        '["AMP.PRE"]','classified','https://example.test/'||id,'${at}','${at}','${at}',CASE WHEN id=12 THEN 0 ELSE 1 END FROM n;
      INSERT INTO product_admin_overrides(listing_product_id,primary_category_id,created_at,updated_at)
      VALUES(90012,'AMP.PRE','${at}','${at}');`);
    const change = create({ primary_category_id: "PRC.DAC" });
    const input = await inputFor(db, change);
    const first = await applyAdminCsvChange(db, input);
    assert.equal(first.status, "pending", first.message);
    assert.equal(
      sqlite.prepare("SELECT after_listing_id FROM admin_csv_import_changes").get()
        ?.after_listing_id,
      90010,
    );
    const pending = await previewAdminCsvChange(db, change);
    assert.equal(pending.status, "pending");
    assert.equal(pending.operationId, input.operationId);
    assert.equal(pending.id, first.id);
    const resumed = await applyAdminCsvChange(db, {
      change,
      revision: pending.revision || "",
      operationId: pending.operationId!,
    });
    assert.equal(resumed.status, "applied", resumed.message);
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) n FROM product_identity_resolutions WHERE catalog_product_id=?")
        .get(first.id)?.n,
      12,
    );
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=90012").get()
        ?.primary_category_id,
      "AMP.PRE",
    );
    assert.equal(
      sqlite.prepare("SELECT primary_category_id FROM products WHERE id=90001").get()
        ?.primary_category_id,
      "PRC.DAC",
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 1);
  } finally {
    sqlite.close();
  }
});

test("catalog insertion duplicate probes use the identity expression index", async () => {
  const { db, sqlite } = database();
  try {
    const recorded = recordingDatabase(db);
    assert.equal((await previewAdminCsvChange(recorded.db, create())).status, "ready");
    const query = recorded.executed.find(({ sql }) => sql.includes("AS snapshot"));
    assert.ok(query);
    const plan = queryPlan(sqlite, query);
    assert.ok(
      plan.some(({ detail }) =>
        /SEARCH knowledge_catalog_products USING INDEX idx_catalog_products_identity_bucket/u.test(
          detail,
        ),
      ),
      JSON.stringify(plan),
    );
    assert.ok(
      !plan.some(({ detail }) => /USE TEMP B-TREE FOR ORDER BY/u.test(detail)),
      JSON.stringify(plan),
    );
  } finally {
    sqlite.close();
  }
});
