import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { findCatalogAdminWorkerId } from "../scripts/lib/catalog-admin-worker.js";

test("admin bootstrap detection preserves a live Worker even when it appears after the first page", async () => {
  const seen: number[] = [];
  const id = await findCatalogAdminWorkerId("hifiscout-admin", async (page) => {
    seen.push(page);
    return page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `another-${i}` }))
      : [{ id: "admin-id", name: "hifiscout-admin" }];
  });
  assert.equal(id, "admin-id");
  assert.deepEqual(seen, [1, 2]);
  assert.equal(await findCatalogAdminWorkerId("hifiscout-admin", async () => []), null);
});

test("admin bootstrap detection never interprets API failures, malformed IDs or exhausted pages as absence", async () => {
  await assert.rejects(
    findCatalogAdminWorkerId("admin", async () => {
      throw new Error("HTTP 403");
    }),
    /HTTP 403/u,
  );
  await assert.rejects(
    findCatalogAdminWorkerId("admin", async () => [{ name: "admin" }]),
    /no id/u,
  );
  await assert.rejects(
    findCatalogAdminWorkerId("admin", async () =>
      Array.from({ length: 100 }, () => ({ name: "other" })),
    ),
    /page budget/u,
  );
});
