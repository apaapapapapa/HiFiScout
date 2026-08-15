import test from "node:test";
import assert from "node:assert/strict";

import type { VerifiedKnowledgeSource } from "../src/catalog/knowledge-verification/types.js";
import {
  promoteVerifiedKnowledgeCatalogCandidate,
  recordKnowledgeCatalogProductRecheckFailure,
  recordKnowledgeCatalogProductRecheckSuccess,
} from "../src/db/knowledge-catalog-verification-repository.js";
import type {
  DueKnowledgeCatalogProduct,
  PendingKnowledgeCatalogCandidate,
} from "../src/db/types.js";
import { asQueryableDatabase } from "./helpers/d1.js";

interface CapturedStatement {
  sql: string;
  binds: unknown[];
  bind(...binds: unknown[]): CapturedStatement;
  first(): Promise<null>;
  run(): Promise<{ meta: { last_row_id: number } }>;
}

function captureDb() {
  const batches: CapturedStatement[][] = [];
  return asQueryableDatabase({
    batches,
    prepare(sql: string): CapturedStatement {
      const statement: CapturedStatement = {
        sql,
        binds: [],
        bind(...binds: unknown[]) {
          statement.binds = binds;
          return statement;
        },
        async first() {
          return null;
        },
        async run() {
          return {
            meta: {
              last_row_id: sql.includes("INSERT INTO knowledge_catalog_products") ? 41 : 0,
            },
          };
        },
      };
      return statement;
    },
    async batch(statements: CapturedStatement[]) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  });
}

const contentHash = "a".repeat(64);

const candidate: PendingKnowledgeCatalogCandidate = {
  id: 7,
  manufacturerId: "example",
  normalizedModel: "MODEL1",
  observedManufacturer: "Example",
  observedModel: "Model 1",
  sampleTitle: "Example Model 1",
  priorityScore: 100,
  verificationStatus: "unverified",
  lastVerificationAt: null,
};

const verification: VerifiedKnowledgeSource = {
  status: "verified",
  sourceUrl: "https://example.test/model-1",
  sourceType: "manufacturer_official",
  httpStatus: 200,
  canonicalModel: "MODEL1",
  canonicalName: "Example Model 1",
  categoryIds: ["power_amp"],
  primaryCategoryId: "power_amp",
  contentHash,
  message: "verified",
};

const dueProduct: DueKnowledgeCatalogProduct = {
  id: 41,
  manufacturerId: "example",
  canonicalModel: "MODEL1",
  normalizedModel: "MODEL1",
  canonicalName: "Example Model 1",
  primaryCategoryId: "power_amp",
  categoryIds: ["power_amp"],
  sourceId: 9,
  sourceType: "manufacturer_official",
  sourceUrl: "https://example.test/model-1",
};

test("new catalog promotions retain the fetched content hash in verification history", async () => {
  const db = captureDb();

  await promoteVerifiedKnowledgeCatalogCandidate(
    db,
    candidate,
    verification,
    "2026-08-14T00:00:00.000Z",
  );

  const attempt = db.batches
    .flat()
    .find((statement) => statement.sql.includes("knowledge_catalog_verification_attempts"));
  assert.ok(attempt);
  assert.equal(attempt.binds[9], contentHash);
});

test("category-change rechecks retain the fetched content hash in verification history", async () => {
  const db = captureDb();
  await recordKnowledgeCatalogProductRecheckFailure(
    db,
    dueProduct,
    {
      status: "ambiguous",
      sourceUrl: verification.sourceUrl,
      sourceType: verification.sourceType,
      httpStatus: verification.httpStatus,
      contentHash,
      message: "official_category_changed_since_last_verification",
    },
    "2026-08-14T00:00:00.000Z",
  );

  const attempt = db.batches
    .flat()
    .find((statement) => statement.sql.includes("knowledge_catalog_verification_attempts"));
  assert.ok(attempt);
  assert.equal(attempt.binds[9], contentHash);
});

test("re-verification restarts catalog remediation from the first listing", async () => {
  const db = captureDb();

  await recordKnowledgeCatalogProductRecheckSuccess(
    db,
    dueProduct,
    verification,
    "2026-08-14T00:00:00.000Z",
  );

  const productUpdate = db.batches
    .flat()
    .find((statement) => statement.sql.includes("UPDATE knowledge_catalog_products"));
  assert.ok(productUpdate);
  assert.match(productUpdate.sql, /remediation_after_listing_id = 0/);
});
