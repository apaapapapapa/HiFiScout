import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  PRODUCT_CORRECTION_REPORT_MAX_EXPLANATION_BYTES,
  parseProductCorrectionReportRequest,
} from "../src/api/product-correction-report-contract.js";
import {
  cleanupProductCorrectionReports,
  createProductCorrectionReport,
  listProductCorrectionReports,
  updateProductCorrectionReport,
} from "../src/db/product-correction-report-repository.js";
import {
  parseProductCorrectionReportAction,
  parseProductCorrectionReportListQuery,
} from "../src/http/product-correction-report-admin.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const SNAPSHOT = {
  productKey: "c-42",
  listingProductId: 123,
  reason: "wrong_model" as const,
  explanation: "MK2 ではなく MK3 と表示されています",
  manufacturer: "LUXMAN",
  model: "D-1000",
  category: "CD/SACDプレーヤー",
  shopKey: "example-shop",
};

test("public correction report contract accepts only bounded factual input", () => {
  assert.deepEqual(
    parseProductCorrectionReportRequest({
      productKey: "c-42",
      listingProductId: 123,
      reason: "wrong_model",
      explanation: " MK2 ではなく MK3 ",
    }),
    {
      productKey: "c-42",
      listingProductId: 123,
      reason: "wrong_model",
      explanation: "MK2 ではなく MK3",
    },
  );
  assert.equal(
    parseProductCorrectionReportRequest({
      productKey: "c-42",
      reason: "wrong_model",
      explanation: "<b>wrong</b>",
    }),
    null,
  );
  assert.equal(
    parseProductCorrectionReportRequest({
      productKey: "not-a-key",
      reason: "wrong_model",
    }),
    null,
  );
  assert.equal(
    parseProductCorrectionReportRequest({
      productKey: "c-42",
      reason: "wrong_model",
      unexpected: true,
    }),
    null,
  );
  assert.equal(
    parseProductCorrectionReportRequest({
      productKey: "c-42",
      reason: "wrong_model",
      explanation: "あ".repeat(Math.ceil(PRODUCT_CORRECTION_REPORT_MAX_EXPLANATION_BYTES / 3) + 1),
    }),
    null,
  );
});

test("admin correction report queries and actions are bounded", () => {
  assert.deepEqual(
    parseProductCorrectionReportListQuery(
      new URL("https://admin.example/api/admin/correction-reports?status=open&reason=wrong_model&shopKey=Example-Shop&maxAgeDays=30&limit=25"),
    ),
    {
      status: "open",
      reason: "wrong_model",
      shopKey: "example-shop",
      maxAgeDays: 30,
      beforeId: null,
      limit: 25,
    },
  );
  assert.equal(
    parseProductCorrectionReportListQuery(
      new URL("https://admin.example/api/admin/correction-reports?status=unknown"),
    ),
    null,
  );
  assert.deepEqual(parseProductCorrectionReportAction({ action: "accepted", note: "override event #9" }), {
    action: "accepted",
    note: "override event #9",
  });
  assert.equal(parseProductCorrectionReportAction({ action: "accepted", note: "<script>" }), null);
  assert.equal(parseProductCorrectionReportAction({ action: "delete", note: "x" }), null);
});

test("duplicate open correction reports collapse inside the bounded window", async () => {
  const { sqlite, db } = migratedSqlite();
  const now = new Date("2026-08-27T10:00:00.000Z");
  try {
    assert.deepEqual(await createProductCorrectionReport(db, SNAPSHOT, now), {
      accepted: true,
      deduplicated: false,
    });
    assert.deepEqual(await createProductCorrectionReport(db, SNAPSHOT, now), {
      accepted: true,
      deduplicated: true,
    });
    const count = sqlite.prepare("SELECT COUNT(*) AS count FROM product_correction_reports").get() as {
      count: number;
    };
    assert.equal(Number(count.count), 1);
  } finally {
    sqlite.close();
  }
});

test("review transitions are audited and acceptance requires a correction reference", async () => {
  const { sqlite, db } = migratedSqlite();
  const now = new Date("2026-08-27T10:00:00.000Z");
  try {
    await createProductCorrectionReport(db, SNAPSHOT, now);
    const listed = await listProductCorrectionReports(db, {
      status: "open",
      reason: "",
      shopKey: "",
      maxAgeDays: null,
      beforeId: null,
      limit: 10,
    }, now);
    assert.equal(listed.items.length, 1);
    const reportId = listed.items[0].id;

    const reviewing = await updateProductCorrectionReport(
      db,
      reportId,
      "review_started",
      "",
      new Date("2026-08-27T10:01:00.000Z"),
    );
    assert.equal(reviewing?.status, "in_review");
    await assert.rejects(
      updateProductCorrectionReport(db, reportId, "accepted", "", now),
      /correction_report_resolution_reference_required/,
    );
    const accepted = await updateProductCorrectionReport(
      db,
      reportId,
      "accepted",
      "listing admin override completed",
      new Date("2026-08-27T10:02:00.000Z"),
    );
    assert.equal(accepted?.status, "accepted");
    assert.equal(accepted?.resolutionNote, "listing admin override completed");

    const events = sqlite
      .prepare("SELECT action FROM product_correction_report_events WHERE report_id = ? ORDER BY id")
      .all(reportId) as Array<{ action: string }>;
    assert.deepEqual(events.map((event) => event.action), ["review_started", "accepted"]);
  } finally {
    sqlite.close();
  }
});

test("correction report cleanup is retention-aware and batch bounded", async () => {
  const { sqlite, db } = migratedSqlite();
  const now = new Date("2026-08-27T10:00:00.000Z");
  try {
    await createProductCorrectionReport(db, SNAPSHOT, new Date("2025-01-01T00:00:00.000Z"));
    await createProductCorrectionReport(
      db,
      { ...SNAPSHOT, productKey: "c-43" },
      new Date("2025-01-02T00:00:00.000Z"),
    );
    assert.equal(await cleanupProductCorrectionReports(db, 1, now), 1);
    const afterFirst = sqlite.prepare("SELECT COUNT(*) AS count FROM product_correction_reports").get() as {
      count: number;
    };
    assert.equal(Number(afterFirst.count), 1);
    assert.equal(await cleanupProductCorrectionReports(db, 10, now), 1);
  } finally {
    sqlite.close();
  }
});

test("migration rejects unrecognised report vocabulary", () => {
  const { sqlite } = migratedSqlite();
  try {
    assert.throws(() =>
      sqlite.prepare(`
        INSERT INTO product_correction_reports(
          product_key, listing_product_id, reason, explanation,
          snapshot_manufacturer, snapshot_model, snapshot_category, snapshot_shop_key,
          status, resolution_note, created_at, updated_at, resolved_at
        ) VALUES ('c-1', NULL, 'made_up', '', '', '', '', '', 'open', '', '2026-01-01', '2026-01-01', NULL)
      `).run(),
    );
  } finally {
    sqlite.close();
  }
});
