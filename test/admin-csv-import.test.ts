import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  adminCsvCell, adminCsvEditHeader, adminCsvEditRow, adminCsvOriginal,
  type AdminCsvChange, type AdminCsvResult,
} from "../src/api/admin-csv-contracts.js";
import { parseCsv, readAdminCsv } from "../frontend/admin-csv-parser.js";
import { parseAdminCsvApply, parseAdminCsvPreview } from "../src/http/admin-csv-import.js";
import { applyAdminCsvChange, previewAdminCsvChange } from "../src/db/admin-csv-import-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { updateListingAdminProduct } from "../src/db/listing-admin-repository.js";

const original = adminCsvOriginal("listing", 90001, {
  manufacturer_id: "luxman", model: "C10", primary_category_id: "AMP.PRE",
});
const change = (model = "C11"): AdminCsvChange => ({
  line: 2, original, values: { ...original.values, model },
});
const fixtureCsv = () => "\uFEFFlisting_id," + adminCsvEditHeader("listing") + "\r\n90001," +
  adminCsvEditRow(original) + "\r\n";

test("CSV handles BOM, CRLF, quoted commas/newlines and reversible formula escaping", () => {
  assert.deepEqual([...parseCsv('\uFEFFa,b\r\n"x,y","one\n""two"""\r\n')], [
    { line: 1, cells: ["a", "b"] }, { line: 2, cells: ["x,y", 'one\n"two"'] },
  ]);
  assert.equal(readAdminCsv(fixtureCsv()).changes.length, 0);
  for (const model of ["-Model", "+Model", "=Model", "@Model", "'Model", "'=Model", " =Model", "\t=Model"]) {
    const row = adminCsvOriginal("listing", 1, { ...original.values, model });
    const text = "listing_id," + adminCsvEditHeader("listing") + "\n1," + adminCsvEditRow(row);
    assert.equal(readAdminCsv(text).changes.length, 0);
  }
  const cells = [...parseCsv(fixtureCsv())];
  cells[1].cells[3] = "C11";
  const edited = cells.map((row) => row.cells.map(adminCsvCell).join(",")).join("\n");
  assert.deepEqual(readAdminCsv(edited).changes, [change()]);
});

test("CSV rejects duplicate IDs, duplicate headers, missing snapshots, malformed quoting and ID edits", () => {
  assert.throws(() => readAdminCsv("listing_id,model\n1,C10"), /再生成/u);
  assert.throws(() => readAdminCsv("a,a\n1,1"), /重複/u);
  assert.throws(() => [...parseCsv('a\n"broken')], /閉じ/u);
  assert.throws(() => [...parseCsv('a\n"x"oops')], /引用符/u);
  assert.throws(() => [...parseCsv("a\nx\0")], /NUL/u);
  const csv = fixtureCsv();
  assert.throws(() => readAdminCsv(csv + csv.split("\r\n")[1] + "\r\n"), /重複/u);
  assert.throws(() => readAdminCsv(csv.replace("\r\n90001,", "\r\n90002,")), /対象ID/u);
});

test("server validates rows independently of the browser and bounds each request", () => {
  assert.deepEqual(parseAdminCsvPreview({ changes: [change()] }), [change()]);
  assert.equal(parseAdminCsvPreview({ changes: [change(), change()] }), null);
  assert.equal(parseAdminCsvPreview({ changes: Array(21).fill(change()) }), null);
  assert.equal(parseAdminCsvPreview({ changes: [{ ...change(), values: { title: "untrusted" } }] }), null);
  assert.equal(parseAdminCsvPreview({ changes: [{ ...change(), original: { ...original, id: "90001" } }] }), null);
  assert.equal(parseAdminCsvApply({ change: change(), revision: "", operationId: "not-a-uuid" }), null);
});

function database() {
  const setup = migratedSqlite();
  setup.sqlite.exec(`
    INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
    VALUES ('luxman','LUXMAN','2026-09-05','2026-09-05');
    INSERT INTO products(id,shop_key,source_id,manufacturer,model,title,category,condition_text,
      price_yen,stock_status,source_url,first_seen_at,last_seen_at,last_changed_at,is_active,
      raw_manufacturer,manufacturer_id,canonical_manufacturer_id,manufacturer_resolution_status,
      raw_model,normalized_model,model_resolution_status,raw_category,primary_category_id,
      category_ids,direct_category_ids,classification_status)
    VALUES (90001,'hifido','csv-test','LUXMAN','C10','LUXMAN C10','プリアンプ','中古',
      100000,'in_stock','https://example.test/csv-test','2026-09-05','2026-09-05','2026-09-05',1,
      'LUXMAN','luxman','luxman','resolved','C10','C10','resolved','プリアンプ','AMP.PRE',
      '["AMP.PRE","AMP"]','["AMP.PRE"]','classified');
  `);
  return setup;
}

async function apply(db: ReturnType<typeof database>["db"], item: AdminCsvChange): Promise<AdminCsvResult> {
  const preview = await previewAdminCsvChange(db, item);
  assert.equal(preview.status, "ready", preview.message);
  const input = { change: item, revision: preview.revision || "", operationId: crypto.randomUUID() };
  let result = await applyAdminCsvChange(db, input);
  for (let count = 0; count < 30 && result.status === "pending"; count += 1) {
    result = await applyAdminCsvChange(db, input);
  }
  return result;
}

test("listing import is no-write on unchanged input and persists overrides without overwriting seller facts", async () => {
  const { db, sqlite } = database();
  try {
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.equal((await previewAdminCsvChange(db, change("C10"))).status, "unchanged");
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
    const result = await apply(db, change());
    assert.equal(result.status, "applied", result.message);
    const row = sqlite.prepare("SELECT model,raw_model,title,price_yen FROM products WHERE id=90001").get();
    assert.deepEqual({ ...row }, { model: "C11", raw_model: "C10", title: "LUXMAN C10", price_yen: 100000 });
    sqlite.exec("UPDATE products SET model='C10', raw_model='C10 seller updated' WHERE id=90001");
    assert.equal(sqlite.prepare("SELECT model FROM products WHERE id=90001").get()?.model, "C11");
    const applied = sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.equal((await previewAdminCsvChange(db, change())).status, "unchanged");
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, applied);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 1);
  } finally { sqlite.close(); }
});

test("conflicts and invalid manufacturer/category IDs cannot mutate the database", async () => {
  const { db, sqlite } = database();
  try {
    const preview = await previewAdminCsvChange(db, change());
    sqlite.exec("UPDATE products SET model='Concurrent' WHERE id=90001");
    const result = await applyAdminCsvChange(db, {
      change: change(), revision: preview.revision || "", operationId: crypto.randomUUID(),
    });
    assert.equal(result.status, "conflict");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 0);
    sqlite.exec("UPDATE products SET model='C10' WHERE id=90001");
    for (const values of [
      { ...original.values, manufacturer_id: "missing-brand" },
      { ...original.values, primary_category_id: "unclassified" },
      { ...original.values, primary_category_id: "amp" },
    ]) {
      assert.equal((await previewAdminCsvChange(db, { line: 2, original, values })).status, "invalid");
    }
  } finally { sqlite.close(); }
});

test("race inside the write transaction rolls back overrides and the import receipt", async () => {
  const { db, sqlite } = database();
  try {
    const preview = await previewAdminCsvChange(db, change());
    const racing = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec("UPDATE products SET model='Race winner' WHERE id=90001");
        return db.batch(statements);
      },
    };
    const result = await applyAdminCsvChange(racing, {
      change: change(), revision: preview.revision || "", operationId: crypto.randomUUID(),
    });
    assert.equal(result.status, "failed");
    assert.equal(sqlite.prepare("SELECT model FROM products WHERE id=90001").get()?.model, "Race winner");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_admin_overrides WHERE listing_product_id=90001").get()?.n, 0);
  } finally { sqlite.close(); }
});

test("a projection failure leaves a durable receipt that another upload resumes", async () => {
  const { db, sqlite } = database();
  try {
    const preview = await previewAdminCsvChange(db, change());
    let committed = false;
    const failing = {
      prepare(sql: string) {
        if (committed && sql.includes("listing_projection_pending")) throw new Error("injected outage");
        return db.prepare(sql);
      },
      async batch(statements: D1PreparedStatement[]) {
        const result = await db.batch(statements);
        committed = true;
        return result;
      },
    };
    const operationId = crypto.randomUUID();
    const first = await applyAdminCsvChange(failing, {
      change: change(), revision: preview.revision || "", operationId,
    });
    assert.equal(first.status, "failed");
    const pending = await previewAdminCsvChange(db, change());
    if (first.status === "failed") {
      assert.equal(pending.status, "pending");
      assert.equal(pending.operationId, operationId);
      const resumed = await applyAdminCsvChange(sqliteD1(sqlite), {
        change: change(), revision: pending.revision || "", operationId,
      });
      assert.equal(resumed.status, "applied");
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").get()?.n, 1);
  } finally { sqlite.close(); }
});

test("catalog import edits identity in place, rejects duplicates and retires old identity evidence", async () => {
  const { db, sqlite } = database();
  try {
    sqlite.exec(`
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
        canonical_name,created_at,updated_at) VALUES (90001,'luxman','CSV-OLD','CSV-OLD','Old name','2026-09-05','2026-09-05');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
        VALUES (90001,'AMP.PRE',1),(90001,'AMP',0),(90001,'PRC.DAC',0),(90001,'PRC',0);
      INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
        VALUES(90001,'wrong-alias','WRONGALIAS','model','2026-09-05');
      INSERT INTO knowledge_catalog_sources(product_id,source_type,source_url,created_at,updated_at)
        VALUES(90001,'manufacturer_official','https://example.test/old','2026-09-05','2026-09-05');
    `);
    const original = adminCsvOriginal("catalog", 90001, {
      manufacturer_id: "luxman", canonical_model: "CSV-OLD", canonical_name: "Old name",
      primary_category_id: "AMP.PRE", lifecycle_status: "unknown",
    });
    const item: AdminCsvChange = {
      line: 2, original, values: { ...original.values, canonical_model: "CSV-NEW", canonical_name: "Correct name" },
    };
    const result = await apply(db, item);
    assert.equal(result.status, "applied", result.message);
    assert.equal(sqlite.prepare("SELECT canonical_model FROM knowledge_catalog_products WHERE id=90001").get()?.canonical_model, "CSV-NEW");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_aliases WHERE product_id=90001").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_product_categories WHERE product_id=90001").get()?.n, 4,
      "identity/name-only edits preserve secondary categories");
    const receipt = sqlite.prepare("SELECT before_json FROM admin_csv_import_changes").get();
    assert.match(String(receipt?.before_json), /wrong-alias/u);
    assert.equal(sqlite.prepare("SELECT status FROM knowledge_catalog_sources WHERE source_url='https://example.test/old'").get()?.status, "error");
    const again: AdminCsvChange = {
      line: 2, original: { ...original, values: item.values },
      values: { ...item.values, canonical_model: "CSV-DUPLICATE" },
    };
    sqlite.exec(`INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
      VALUES('luxman','CSV-DUPLICATE','CSV-DUPLICATE','2026-09-05','2026-09-05')`);
    assert.equal((await previewAdminCsvChange(db, again)).status, "invalid");
  } finally { sqlite.close(); }
});

async function relatedListings(db: ReturnType<typeof database>["db"], sqlite: ReturnType<typeof database>["sqlite"]) {
  sqlite.exec(`
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
      canonical_name,created_at,updated_at) VALUES (90001,'luxman','C10','C10','LUXMAN C10','2026-09-05','2026-09-05');
    INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
      VALUES (90001,'AMP.PRE',1),(90001,'AMP',0);
    INSERT INTO products(id,shop_key,source_id,title,manufacturer,manufacturer_id,canonical_manufacturer_id,
      model,normalized_model,raw_model,raw_manufacturer,primary_category_id,category_ids,
      direct_category_ids,classification_status,source_url,first_seen_at,last_seen_at,last_changed_at,is_active)
    SELECT 90002,shop_key,'csv-inactive',title,manufacturer,manufacturer_id,canonical_manufacturer_id,
      model,normalized_model,raw_model,raw_manufacturer,primary_category_id,category_ids,
      direct_category_ids,classification_status,source_url,first_seen_at,last_seen_at,last_changed_at,0
    FROM products WHERE id=90001;
    INSERT INTO products(id,shop_key,source_id,title,manufacturer,manufacturer_id,canonical_manufacturer_id,
      model,normalized_model,raw_model,raw_manufacturer,primary_category_id,category_ids,
      direct_category_ids,classification_status,source_url,first_seen_at,last_seen_at,last_changed_at,is_active)
    SELECT 90003,shop_key,'csv-manual',title,manufacturer,manufacturer_id,canonical_manufacturer_id,
      model,normalized_model,raw_model,raw_manufacturer,primary_category_id,category_ids,
      direct_category_ids,classification_status,source_url,first_seen_at,last_seen_at,last_changed_at,1
    FROM products WHERE id=90001;
    UPDATE products SET manufacturer_resolution_status='resolved', model_resolution_status='resolved'
      WHERE id IN (90002,90003);
  `);
  const rows = await db.prepare("SELECT id,shop_key,source_id FROM products WHERE id>=90001")
    .all<{ id: number; shop_key: string; source_id: string }>();
  await refreshListingProjections(db, rows.results, "2026-09-05T00:00:00.000Z");
  return adminCsvOriginal("catalog", 90001, {
    manufacturer_id: "luxman", canonical_model: "C10", canonical_name: "LUXMAN C10",
    primary_category_id: "AMP.PRE", lifecycle_status: "unknown",
  });
}

test("catalog category correction updates active and inactive matches but preserves explicit listing overrides", async () => {
  const { db, sqlite } = database();
  try {
    const original = await relatedListings(db, sqlite);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_identity_resolutions WHERE catalog_product_id=90001").get()?.n, 3);
    await updateListingAdminProduct(db, 90003, { primaryCategoryId: "AMP.PRE" });
    const result = await apply(db, {
      line: 2, original, values: { ...original.values, primary_category_id: "PRC.DAC" },
    });
    assert.equal(result.status, "applied", result.message);
    const categories = sqlite.prepare("SELECT primary_category_id FROM products WHERE id>=90001 ORDER BY id").all();
    assert.deepEqual(categories.map((row) => row.primary_category_id), ["PRC.DAC", "PRC.DAC", "AMP.PRE"]);
    assert.equal(sqlite.prepare("SELECT catalog_product_id FROM product_identity_resolutions WHERE listing_product_id=90001").get()?.catalog_product_id, 90001);
    assert.equal(sqlite.prepare("SELECT category_id FROM product_categories WHERE product_id=90003 AND is_direct=1").get()?.category_id, "AMP.PRE");
    assert.equal(sqlite.prepare("SELECT is_active FROM products WHERE id=90002").get()?.is_active, 0);
  } finally { sqlite.close(); }
});

test("catalog identity correction detaches old listings without rewriting their model to the new identity", async () => {
  const { db, sqlite } = database();
  try {
    const original = await relatedListings(db, sqlite);
    const result = await apply(db, {
      line: 2, original, values: { ...original.values, canonical_model: "C11" },
    });
    assert.equal(result.status, "applied", result.message);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_identity_resolutions WHERE catalog_product_id=90001").get()?.n, 0);
    const rows = sqlite.prepare("SELECT model,raw_model FROM products WHERE id>=90001").all();
    assert.ok(rows.every((row) => row.model === "C10" && row.raw_model === "C10"));
  } finally { sqlite.close(); }
});
