import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseCatalogPhoto, safePhotoUrl } from "../src/api/catalog-photo-contracts.js";
import { readCatalogPhoto, updateCatalogPhoto } from "../src/db/catalog-photo-repository.js";
import {
  extractPhotoCandidates,
  fetchPhotoCandidates,
} from "../src/catalog/knowledge-verification/photo-candidates.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productSearchDetail } from "../src/db/product-search-repository.js";
import { toProductSearchItem } from "../src/db/product-search-entity-mapper.js";
import { mergeKnowledgeCatalogProductReferences } from "../src/db/knowledge-catalog-admin-operations.js";
import { entityRow } from "./helpers/product-search.js";
import { isProductSearchItem } from "../frontend/api-client.js";
import { renderProductPermalinkHtml } from "../src/http/product-permalink.js";
import { isCompleteExportTable } from "../src/export/complete-csv.js";

const photo = {
  imageUrl: "https://www.luxman.co.jp/images/L-507Z.jpg",
  sourceUrl: "https://www.luxman.co.jp/product/l-507z",
  credit: "LUXMAN",
};
function products(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  sqlite.exec(`INSERT INTO knowledge_catalog_products (id, manufacturer_id, canonical_model, normalized_model, created_at, updated_at)
    VALUES (9000001, 'luxman', 'photo1', 'PHOTO1', '2026-09-22', '2026-09-22'), (9000002, 'luxman', 'photo2', 'PHOTO2', '2026-09-22', '2026-09-22')`);
}

test("photo URLs reject active, credentialed and private-network sources", () => {
  assert.deepEqual(parseCatalogPhoto(photo), photo);
  for (const url of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "//example.com/a.jpg",
    "http://example.com/a.jpg",
    "https://user:secret@example.com/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://localhost/a",
    "https://device.local/a",
    "https://example.com:8443/a",
    "https://example.com/" + "a".repeat(2048),
  ]) {
    assert.equal(safePhotoUrl(url), null, url);
    assert.equal(parseCatalogPhoto({ ...photo, imageUrl: url }), null);
    assert.equal(parseCatalogPhoto({ ...photo, sourceUrl: url }), null);
  }
});

test("catalog photo publication is idempotent, revision guarded, removable and model scoped", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    products(sqlite);
    assert.equal(await readCatalogPhoto(db, 99999999), null);
    const first = await updateCatalogPhoto(db, 9000001, { photo, expectedRevision: 0 });
    assert.equal(first?.revision, 1);
    const before = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
    assert.deepEqual(await updateCatalogPhoto(db, 9000001, { photo, expectedRevision: 0 }), first);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.deepEqual((await productSearchDetail(db, "c-9000001"))?.product.photo, photo);
    assert.equal((await productSearchDetail(db, "c-9000002"))?.product.photo, null);
    await assert.rejects(
      updateCatalogPhoto(db, 9000001, { photo: null, expectedRevision: 0 }),
      /conflict/,
    );
    assert.equal(
      (await updateCatalogPhoto(db, 9000001, { photo: null, expectedRevision: 1 }))?.revision,
      2,
    );
    assert.equal((await productSearchDetail(db, "c-9000001"))?.product.photo, null);
    await assert.rejects(
      updateCatalogPhoto(db, 9000001, { photo, expectedRevision: 1 }),
      /conflict/,
    );
    assert.equal(
      (await updateCatalogPhoto(db, 9000001, { photo, expectedRevision: 2 }))?.revision,
      3,
    );
    assert.equal(isCompleteExportTable("catalog_product_photos"), true);
  } finally {
    sqlite.close();
  }
});

test("concurrent photo editors cannot overwrite each other", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    products(sqlite);
    const results = await Promise.allSettled([
      updateCatalogPhoto(db, 9000001, { photo, expectedRevision: 0 }),
      updateCatalogPhoto(db, 9000001, {
        photo: { ...photo, credit: "another" },
        expectedRevision: 0,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await readCatalogPhoto(db, 9000001))?.revision, 1);
  } finally {
    sqlite.close();
  }
});

test("catalog merges retain photos and atomically reject conflicting photos", async () => {
  for (const conflict of [false, true]) {
    const { db, sqlite } = migratedSqlite();
    try {
      products(sqlite);
      await updateCatalogPhoto(db, 9000002, { photo, expectedRevision: 0 });
      if (conflict)
        await updateCatalogPhoto(db, 9000001, {
          photo: { ...photo, credit: "different" },
          expectedRevision: 0,
        });
      const merge = () =>
        mergeKnowledgeCatalogProductReferences(
          db,
          9000001,
          { id: 9000002, canonicalModel: "photo2", canonicalName: "photo2" },
          new Date().toISOString(),
        );
      if (conflict) {
        await assert.rejects(merge(), /catalog_admin_merge_photos_conflict/);
        assert.deepEqual((await readCatalogPhoto(db, 9000002))?.photo, photo);
      } else {
        await merge();
        assert.equal(await readCatalogPhoto(db, 9000002), null);
        assert.deepEqual((await readCatalogPhoto(db, 9000001))?.photo, photo);
      }
    } finally {
      sqlite.close();
    }
  }
});

test("public DTOs and permalink HTML keep manufacturer photos separate from unresolved offers", () => {
  const item = toProductSearchItem({ ...entityRow(), catalog_photo_json: JSON.stringify(photo) });
  assert.deepEqual(item.photo, photo);
  assert.equal(isProductSearchItem(item), true);
  assert.equal(
    isProductSearchItem({ ...item, photo: { ...photo, sourceUrl: "javascript:alert(1)" } }),
    false,
  );
  const fallback = toProductSearchItem({
    ...entityRow({ entity_kind: "unresolved_listing" }),
    catalog_photo_json: JSON.stringify(photo),
  });
  assert.equal(fallback.photo, null);
  const html = renderProductPermalinkHtml(
    { product: { ...item, photo: { ...photo, credit: '<script>"bad"</script>' } }, offers: [] },
    "https://hifiscout.example.com",
  );
  assert.ok(html.includes('referrerpolicy="no-referrer"'));
  assert.ok(html.includes("&lt;script&gt;&quot;bad&quot;&lt;/script&gt;"));
  assert.ok(!html.includes('<script>"bad"</script>'));
});

test("photo candidates are bounded, deduplicated and retain only product metadata and HTTPS URLs", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","image":["/one.jpg", {"contentUrl":"https://cdn.example.com/two.jpg"}, "javascript:alert(1)"]}</script>
    <meta property="og:image" content="/one.jpg"><meta name="twitter:image" content="/three.jpg"><img src="/unrelated.jpg">`;
  assert.deepEqual(extractPhotoCandidates(html, photo.sourceUrl), [
    "https://www.luxman.co.jp/one.jpg",
    "https://cdn.example.com/two.jpg",
    "https://www.luxman.co.jp/three.jpg",
  ]);
  assert.equal(
    extractPhotoCandidates(
      Array.from({ length: 20 }, (_, i) => `<meta property="og:image" content="/${i}.jpg">`).join(
        "",
      ),
      photo.sourceUrl,
    ).length,
    8,
  );
});

test("candidate fetching rejects foreign origins before fetching and checks every redirect", async () => {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } });
  }) as typeof fetch;
  await assert.rejects(
    fetchPhotoCandidates("luxman", "https://attacker.example.com/", {}, fetchFn),
    /not_official/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(fetchPhotoCandidates("luxman", photo.sourceUrl, {}, fetchFn));
  assert.deepEqual(calls, [photo.sourceUrl]);
  const result = await fetchPhotoCandidates(
    "luxman",
    photo.sourceUrl,
    {},
    (async () =>
      new Response('<meta property="og:image" content="/a.jpg">', {
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
  );
  assert.deepEqual(result.imageUrls, ["https://www.luxman.co.jp/a.jpg"]);
});
