import type { AdminExtractionResult } from "../src/api/admin-listing-contracts.js";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { parseAdminManufacturerCommand } from "../src/http/admin-manufacturer-registry.js";
import {
  applyManufacturerRegistry,
  manufacturerRevision,
  registryVersion,
  readManufacturerRegistry,
  scanManufacturerImpact,
} from "../src/db/admin-manufacturer-management.js";
import { administerManufacturerRegistry } from "../src/admin/manufacturer-registry.js";
import { createManufacturerResolver } from "../src/catalog/manufacturer-resolver.js";
import { listManufacturerAliasEvidence } from "../src/db/manufacturer-repository.js";
import type {
  AdminManufacturerEdit,
  AdminManufacturerPreview,
} from "../src/api/admin-manufacturer-contracts.js";
const edit: AdminManufacturerEdit = {
  manufacturerId: "luxman",
  canonicalName: "LUXMAN",
  nameJa: "ラックスマン",
  nameEn: "Luxman",
  alias: { alias: "デモラボ", shopKey: "audiounion", enabled: true },
};

test("registry commits are guarded against ABA and lost-response retries cannot repeat writes", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const revision = await manufacturerRevision(await registryVersion(db), edit);
    const id = crypto.randomUUID();
    const receipt = await applyManufacturerRegistry(db, edit, revision, id);
    assert.equal(receipt.status, "applied");
    const changes = sqlite.prepare("SELECT total_changes() n").get()?.n;
    assert.deepEqual(await applyManufacturerRegistry(db, edit, revision, id), receipt);
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, changes);
    const detail = await readManufacturerRegistry(db, "luxman");
    assert.equal(detail.profile.nameJa, "ラックスマン");
    assert.equal(detail.history[0].operationId, id);
    const resolver = createManufacturerResolver(await listManufacturerAliasEvidence(db));
    assert.equal(
      resolver({ rawManufacturer: "デモラボ", shopKey: "audiounion" }).canonicalManufacturerId,
      "luxman",
    );
    assert.equal(
      resolver({ rawManufacturer: "デモラボ", shopKey: "hifido" }).canonicalManufacturerId,
      "",
    );
    const future = { ...edit, alias: { ...edit.alias!, enabled: false } };
    const stale = await manufacturerRevision(await registryVersion(db), future);
    sqlite.exec(
      "UPDATE knowledge_catalog_manufacturers SET canonical_name='Temporary' WHERE id='luxman'; UPDATE knowledge_catalog_manufacturers SET canonical_name='LUXMAN' WHERE id='luxman';",
    );
    await assert.rejects(
      applyManufacturerRegistry(db, future, stale, crypto.randomUUID()),
      /別の変更/,
    );
    await assert.rejects(applyManufacturerRegistry(db, future, revision, id), /異なる内容/);
  } finally {
    sqlite.close();
  }
});

test("unrelated alias edits do not re-enable explicitly rejected formal spellings", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const apply = async (e: AdminManufacturerEdit) =>
      applyManufacturerRegistry(
        db,
        e,
        await manufacturerRevision(await registryVersion(db), e),
        crypto.randomUUID(),
      );
    await apply(edit);
    await apply({ ...edit, alias: { alias: "ラックスマン", shopKey: "", enabled: false } });
    await apply({ ...edit, alias: { alias: "別の表記", shopKey: "hifido", enabled: true } });
    const resolver = createManufacturerResolver(await listManufacturerAliasEvidence(db));
    assert.equal(resolver({ rawManufacturer: "ラックスマン" }).canonicalManufacturerId, "");
    assert.equal(
      resolver({ rawManufacturer: "別の表記", shopKey: "hifido" }).canonicalManufacturerId,
      "luxman",
    );
  } finally {
    sqlite.close();
  }
});

test("preview identifies collisions and preserves manual values without mutating records", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "INSERT INTO products(id,shop_key,source_id,title,raw_manufacturer,raw_model,source_url,first_seen_at,last_seen_at,last_changed_at,model,normalized_model) VALUES(100001,'audiounion','brand-preview','デモラボ L-505','デモラボ','デモラボ L-505','https://example.test/','','','','手動型番','MANUAL'); INSERT INTO product_admin_overrides(listing_product_id,model,normalized_model,created_at,updated_at) VALUES(100001,'手動型番','MANUAL','','');",
    );
    const changes = sqlite.prepare("SELECT total_changes() n").get()?.n;
    const result = (await administerManufacturerRegistry({ DB: db } as Env, {
      action: "preview",
      edit,
      afterId: 0,
    })) as AdminManufacturerPreview<AdminExtractionResult>;
    assert.equal(result.samples.items[0].current?.manufacturerId, "");
    assert.equal(result.samples.items[0].proposed?.manufacturerId, "luxman");
    assert.equal(result.samples.items[0].withOverrides?.model, "手動型番");
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, changes);
    const collision = (await administerManufacturerRegistry({ DB: db } as Env, {
      action: "preview",
      edit: { ...edit, alias: { alias: "Accuphase", shopKey: "", enabled: true } },
      afterId: 0,
    })) as AdminManufacturerPreview<AdminExtractionResult>;
    assert.ok(collision.collisions.some((row) => row.manufacturerId === "accuphase"));
  } finally {
    sqlite.close();
  }
});

test("impact scans continue through empty windows and interleaved inactive listings", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<100250) INSERT INTO products(id,shop_key,is_active,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at) SELECT id,'audiounion',id%2,'scan-'||id,CASE WHEN id=100230 THEN 'デモラボ L-505' ELSE 'Other' END,'https://example.test/','','','' FROM n",
    );
    const matcher = { manufacturerId: "luxman", shopKey: "audiounion", keys: ["デモラボ"] };
    const first = await scanManufacturerImpact(db, matcher, 0, 100250);
    assert.equal(first.scanned, 200);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.ids, []);
    const second = await scanManufacturerImpact(db, matcher, first.nextAfterId, 100250);
    assert.deepEqual(second.ids, [100230]);
    assert.equal(second.hasMore, false);
  } finally {
    sqlite.close();
  }
});

test("registry boundaries reject invalid scopes, values and changed edit payloads", () => {
  assert.equal(
    parseAdminManufacturerCommand({
      action: "preview",
      edit: { ...edit, alias: { ...edit.alias, shopKey: "not-a-shop" } },
      afterId: 0,
    }),
    null,
  );
  assert.equal(
    parseAdminManufacturerCommand({
      action: "preview",
      edit: { ...edit, nameJa: "x\n" },
      afterId: 0,
    }),
    null,
  );
  assert.equal(
    parseAdminManufacturerCommand({
      action: "apply",
      edit,
      revision: "fake",
      operationId: crypto.randomUUID(),
    }),
    null,
  );
});

test("a dictionary change racing after preview reads cannot enter the atomic write batch", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const revision = await manufacturerRevision(await registryVersion(db), edit);
    const raced = {
      ...db,
      async batch<T>(statements: D1PreparedStatement[]) {
        sqlite.exec("UPDATE admin_manufacturer_registry_clock SET version=version+1 WHERE id=1");
        return db.batch<T>(statements);
      },
    };
    await assert.rejects(
      applyManufacturerRegistry(raced, edit, revision, crypto.randomUUID()),
      /別の変更/,
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM admin_manufacturer_changes").get()?.n, 0);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM knowledge_catalog_shop_manufacturer_aliases").get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("failed job acceptance remains applied and can be retried from history without another dictionary write", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const id = crypto.randomUUID();
    const failed = await administerManufacturerRegistry({ DB: db } as Env, {
      action: "apply",
      edit,
      revision: await manufacturerRevision(await registryVersion(db), edit),
      operationId: id,
    });
    assert.ok("applied" in failed && failed.applied && failed.replay === "pending");
    const before = sqlite.prepare("SELECT total_changes() n").get()?.n;
    const commands: unknown[] = [];
    const env = {
      DB: db,
      ADMIN_JOBS: {
        idFromName: () => "jobs",
        get: () => ({
          fetch: async (_url: string, input: RequestInit) => {
            commands.push(JSON.parse(String(input.body)));
            return Response.json({ job: { status: "uploading" } });
          },
        }),
      },
    } as unknown as Env;
    const retried = await administerManufacturerRegistry(env, {
      action: "replay",
      operationId: id,
    });
    assert.ok("applied" in retried && retried.replay === "queued");
    assert.equal(commands.length, 2);
    assert.equal(sqlite.prepare("SELECT total_changes() n").get()?.n, before);
  } finally {
    sqlite.close();
  }
});
