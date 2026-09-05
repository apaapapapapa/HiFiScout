import { migrationSources } from "./migrations.js";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { normalizeCatalogProduct } from "../../src/catalog/product-normalizer.js";
import { asQueryableDatabase } from "./d1.js";

const AT = "2026-09-05T00:00:00.000Z";
const NEXT = "2026-09-05T01:00:00.000Z";

/** Real workerd rows_written includes indexes, triggers and AUTOINCREMENT's sqlite_sequence. */
async function database() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('test'); } }",
      compatibilityDate: "2026-01-01",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = asQueryableDatabase(await mf.getD1Database("DB"));
    for (const migration of migrationSources) {
      const sql = migration.sql.replace(/^\s*--[^\n]*$/gm, "").trim();
      if (sql) await db.prepare(sql).run();
    }
    await db.prepare("DELETE FROM knowledge_catalog_products").run();
    return { db, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

const listing = (sourceId: string) =>
  normalizeCatalogProduct({
    sourceId,
    manufacturer: "LUXMAN",
    model: "C10",
    title: "LUXMAN C10",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: `https://example.test/${sourceId}`,
  });

export { AT, NEXT, database, listing };
