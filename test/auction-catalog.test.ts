import { describe, it, expect } from "vite-plus/test";
import {
  auctionCatalogIdentity,
  auctionCatalogInput,
  AUCTION_CATALOG_RULE,
} from "../src/auctions/catalog.js";
import { readAuctionCatalog } from "../src/db/auction-catalog-repository.js";
import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import { localD1 } from "./helpers/local-d1.js";
import { migrationSources } from "./helpers/migrations.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { recordCostSample } from "../scripts/harness/cost.js";

const item = () => ({
  ...auctionSnapshot().item,
  title: "DENON PMA-1700NE",
  rawManufacturer: "DENON",
  rawModel: "PMA-1700NE",
  saleSubject: "main_unit" as const,
  saleUnit: "single" as const,
});
const entry = () => ({
  input: auctionCatalogInput(item()),
  manufacturerId: "denon",
  manufacturerName: "DENON",
  model: "PMA-1700NE",
  candidates: [
    {
      id: 900001,
      manufacturerId: "denon",
      canonicalModel: "PMA-1700NE",
      canonicalName: "PMA-1700NE",
      categoryIds: ["AMP.INTEGRATED"],
    },
  ],
  revision: "revision-1",
  rule: AUCTION_CATALOG_RULE,
});
describe("auction catalog identity", () => {
  it("shares candidates, never a listing verdict", () => {
    expect(auctionCatalogIdentity(item(), entry()).catalogProductId).toBe(900001);
    for (const subject of ["empty_box", "parts", "accessory", "bundle"] as const) {
      const other = { ...item(), saleSubject: subject };
      expect(auctionCatalogInput(other).key).toBe(auctionCatalogInput(item()).key);
      expect(auctionCatalogIdentity(other, entry()).catalogProductId).toBeNull();
    }
    expect(
      auctionCatalogIdentity({ ...item(), saleUnit: "set" }, entry()).catalogProductId,
    ).toBeNull();
    expect(
      auctionCatalogIdentity(
        { ...item(), title: "DENON PMA-1700NE 対応 電源ケーブル", saleSubject: "unknown" },
        entry(),
      ).catalogProductId,
    ).toBeNull();
    expect(
      auctionCatalogIdentity({ ...item(), rawModel: "PMA-1700NE SE" }, entry()).catalogProductId,
    ).toBeNull();
    expect(auctionCatalogIdentity(item(), { ...entry(), rule: "old" }).catalogProductId).toBeNull();
    expect(
      auctionCatalogIdentity({ ...item(), title: "DENON PMA-1700NE 対応 電源ケーブル" }, entry())
        .catalogProductId,
    ).toBeNull();
  });
  it("deduplicates candidate reads and detects edits, additions, deletion and verification withdrawal", async () => {
    const { db, dispose } = await localD1();
    try {
      for (const { sql } of migrationSources)
        await db.prepare(sql.replace(/^\s*--[^\n]*$/gm, "")).run();
      await db
        .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,verification_status,created_at,updated_at)
        VALUES('denon','DENON','verified','2026-09-22','2026-09-22');
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,verification_status,created_at,updated_at)
        VALUES(900001,'denon','PMA-1700NE','PMA-1700NE','PMA-1700NE','verified','2026-09-22','2026-09-22');
        INSERT INTO knowledge_catalog_product_categories VALUES(900001,'AMP.INTEGRATED',1);`)
        .run();
      const input = auctionCatalogInput(item());
      const one = measureD1Cost(db);
      const first = await readAuctionCatalog(one.db, [input]);
      expect(first).toHaveLength(1);
      expect(first[0].candidates.map((row) => row.id)).toEqual([900001]);
      const many = measureD1Cost(db);
      expect(
        await readAuctionCatalog(
          many.db,
          Array.from({ length: 2000 }, () => input),
        ),
      ).toEqual(first);
      expect(many.metrics()).toEqual(one.metrics());
      expect(many.metrics().rowsWritten).toBe(0);
      await db
        .prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<1000)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,verification_status,created_at,updated_at)
        SELECT 910000+i,'denon','OTHER-'||i,'OTHER-'||i,'OTHER-'||i,'verified','','' FROM seq`)
        .run();
      const grown = measureD1Cost(db);
      expect(await readAuctionCatalog(grown.db, [input])).toEqual(first);
      expect(grown.metrics()).toEqual(one.metrics());
      await recordCostSample(
        "auction-catalog-shared",
        "local-workerd",
        many.metrics(),
        ["test/auction-catalog.test.ts"],
        [
          "2,000 duplicate listing inputs cause the same bounded read-only candidate lookup as one input; no auction D1 writes.",
        ],
      );
      await db
        .prepare("UPDATE knowledge_catalog_products SET canonical_name='renamed' WHERE id=900001")
        .run();
      const renamed = await readAuctionCatalog(db, [input]);
      expect(renamed[0].revision).not.toBe(first[0].revision);
      await db
        .prepare(
          "UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=900001",
        )
        .run();
      expect((await readAuctionCatalog(db, [input]))[0].candidates).toEqual([]);

      await db
        .prepare(
          "UPDATE knowledge_catalog_products SET verification_status='verified' WHERE id=900001",
        )
        .run();
      expect((await readAuctionCatalog(db, [input]))[0].candidates).toHaveLength(1);
      await db.prepare("DELETE FROM knowledge_catalog_products WHERE id=900001").run();
      expect((await readAuctionCatalog(db, [input]))[0].candidates).toEqual([]);
      await db
        .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,verification_status,created_at,updated_at)
        VALUES(900002,'denon','PMA-1700NE','PMA-1700NE','PMA-1700NE','verified','','')`)
        .run();
      expect((await readAuctionCatalog(db, [input]))[0].candidates.map((row) => row.id)).toEqual([
        900002,
      ]);
    } finally {
      await dispose();
    }
  }, 30_000);
});
