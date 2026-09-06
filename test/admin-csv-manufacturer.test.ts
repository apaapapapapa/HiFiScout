import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { adminCsvNewCatalog, type AdminCsvChange } from "../src/api/admin-csv-contracts.js";
import {
  applyAdminCsvChange,
  previewAdminCsvChange,
} from "../src/db/admin-csv-import-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const change = (manufacturerId = "accuphase", model = "CSV-BOOTSTRAP-100"): AdminCsvChange => ({
  line: 401,
  original: adminCsvNewCatalog(),
  values: {
    manufacturer_id: manufacturerId,
    canonical_model: model,
    canonical_name: model,
    primary_category_id: "AMP.POWER",
    lifecycle_status: "unknown",
  },
});
const at = "2026-09-06T00:00:00.000Z";

test("catalog CSV accepts missing trusted manufacturers without writing during preview", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const manufacturer = () =>
      sqlite.prepare("SELECT * FROM knowledge_catalog_manufacturers WHERE id='accuphase'").get();
    assert.equal(manufacturer(), undefined, "fixture must reproduce the missing operational row");
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    const preview = await previewAdminCsvChange(db, change());
    assert.equal(preview.status, "ready", preview.message);
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
    const input = {
      change: change(),
      revision: preview.revision || "",
      operationId: crypto.randomUUID(),
    };
    const result = await applyAdminCsvChange(db, input);
    assert.equal(result.status, "applied", result.message);
    const row = manufacturer();
    assert.equal(row?.canonical_name, "Accuphase");
    assert.equal(row?.verification_status, "verified");
    assert.equal(row?.source, "code_bootstrap");
    assert.equal(JSON.parse(String(row?.provenance_json)).operationId, input.operationId);
    assert.equal(JSON.parse(String(row?.provenance_json)).reason, "catalog_csv_creation");
    const applied = sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.equal((await applyAdminCsvChange(db, input)).status, "applied");
    assert.equal((await previewAdminCsvChange(db, change())).status, "unchanged");
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, applied);

    // Later product additions must not replace operational corrections with the code spelling.
    sqlite.exec(`UPDATE knowledge_catalog_manufacturers SET canonical_name='Reviewed name',
      source='manual_verified', provenance_json='{"reviewed":true}', updated_at='${at}'
      WHERE id='accuphase'`);
    const reviewed = manufacturer();
    const next = change("accuphase", "CSV-BOOTSTRAP-200");
    const nextPreview = await previewAdminCsvChange(db, next);
    assert.equal(nextPreview.status, "ready", nextPreview.message);
    assert.equal(
      (
        await applyAdminCsvChange(db, {
          change: next,
          revision: nextPreview.revision || "",
          operationId: crypto.randomUUID(),
        })
      ).status,
      "applied",
    );
    assert.deepEqual(manufacturer(), reviewed);
  } finally {
    sqlite.close();
  }
});

test("CSV bootstrap fallback never verifies unknown IDs, seller spellings, or rejected manufacturers", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`INSERT INTO knowledge_catalog_products(
      manufacturer_id,canonical_model,normalized_model,created_at,updated_at
    ) VALUES('unknown-maker','EXISTING','EXISTING','${at}','${at}')`);
    for (const id of ["unknown-maker", "accuphase-ltd", "ac-cuphase", "msb"])
      assert.equal((await previewAdminCsvChange(db, change(id))).status, "invalid", id);
    for (const status of ["pending", "rejected"]) {
      sqlite
        .prepare(`INSERT INTO knowledge_catalog_manufacturers(
        id,canonical_name,verification_status,source,created_at,updated_at
      ) VALUES('accuphase','Reviewed Accuphase',?,'manual_verified','${at}','${at}')
      ON CONFLICT(id) DO UPDATE SET verification_status=excluded.verification_status`)
        .run(status);
      assert.equal((await previewAdminCsvChange(db, change())).status, "invalid", status);
    }
    sqlite.exec(`INSERT INTO knowledge_catalog_manufacturers(
      id,canonical_name,verification_status,created_at,updated_at
    ) VALUES('custom-maker','Verified Custom Maker','verified','${at}','${at}')`);
    const custom = change("custom-maker");
    const preview = await previewAdminCsvChange(db, custom);
    assert.equal(preview.status, "ready", preview.message);
    assert.equal(
      (
        await applyAdminCsvChange(db, {
          change: custom,
          revision: preview.revision || "",
          operationId: crypto.randomUUID(),
        })
      ).status,
      "applied",
    );
  } finally {
    sqlite.close();
  }
});

test("concurrent manufacturer rejection and source failures cannot leave a verified manufacturer or product", async () => {
  for (const failure of ["pending", "rejected", "source"]) {
    const { db, sqlite } = migratedSqlite();
    try {
      const preview = await previewAdminCsvChange(db, change());
      assert.equal(preview.status, "ready", preview.message);
      if (failure === "source")
        sqlite.exec(`CREATE TEMP TRIGGER fail_csv_source BEFORE INSERT ON knowledge_catalog_sources
          BEGIN SELECT RAISE(ABORT,'injected source failure'); END;`);
      const racing = {
        prepare: db.prepare.bind(db),
        async batch<T = unknown>(statements: D1PreparedStatement[]) {
          if (failure !== "source")
            sqlite
              .prepare(`INSERT INTO knowledge_catalog_manufacturers(
              id,canonical_name,verification_status,source,created_at,updated_at
            ) VALUES('accuphase','Review decision',?,'manual_verified','${at}','${at}')`)
              .run(failure);
          return db.batch<T>(statements);
        },
      };
      const result = await applyAdminCsvChange(racing, {
        change: change(),
        revision: preview.revision || "",
        operationId: crypto.randomUUID(),
      });
      assert.equal(result.status, "failed", result.message);
      const maker = sqlite
        .prepare(
          "SELECT verification_status FROM knowledge_catalog_manufacturers WHERE id='accuphase'",
        )
        .get();
      assert.equal(maker?.verification_status, failure === "source" ? undefined : failure);
      assert.equal(
        sqlite
          .prepare(
            "SELECT COUNT(*) n FROM knowledge_catalog_products WHERE canonical_model='CSV-BOOTSTRAP-100'",
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
