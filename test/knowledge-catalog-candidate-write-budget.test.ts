import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { ScoredKnowledgeCatalogCandidate } from "../src/catalog/types.js";
import { knowledgeCatalogCandidateWrites } from "../src/db/knowledge-catalog-review-repository.js";
import { recordCostSample } from "../scripts/harness/cost.js";
import { AT, NEXT, database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

for (const size of [100, 1_000, 10_000]) {
  test(`candidate publication costs at ${size} rows preserve content and exact observation times`, async () => {
    const { db, dispose } = await database();
    try {
      const candidates: ScoredKnowledgeCatalogCandidate[] = Array.from(
        { length: size },
        (_, i) => ({
          manufacturerId: "luxman",
          normalizedModel: `COST-${i}`,
          observedManufacturer: "LUXMAN",
          observedModel: `COST-${i}`,
          sampleTitle: `LUXMAN COST-${i}`,
          categoryIds: ["AMP.PRE"],
          rawModelVariants: [`COST-${i}`],
          sourceUrls: [`https://example.test/${i}`],
          identityRejectionReason: "missing_resolution",
          listingCount: 1,
          shopCount: 1,
          unclassifiedCount: 0,
          otherCount: 0,
          unresolvedIdentityCount: 1,
          priorityScore: 1,
          firstSeenAt: AT,
          lastSeenAt: AT,
        }),
      );
      await db.batch(knowledgeCatalogCandidateWrites(db, candidates, new Map(), AT));
      await db
        .prepare("UPDATE knowledge_catalog_candidates SET review_status='ignored' WHERE id%2=0")
        .run();
      for (const scenario of ["unchanged", "timestamps", "few-changes", "many-changes"] as const) {
        const desired = candidates.map((c, i) => ({
          ...c,
          lastSeenAt: scenario === "unchanged" ? AT : NEXT,
          sampleTitle:
            scenario === "many-changes" || (scenario === "few-changes" && i % 100 === 0)
              ? `${c.sampleTitle} changed`
              : c.sampleTitle,
        }));
        const measured = measureD1Cost(db);
        const started = performance.now();
        const results = await measured.db.batch(
          knowledgeCatalogCandidateWrites(measured.db, desired, new Map(), NEXT),
        );
        const elapsedMs = performance.now() - started;
        const sqlDurationMs = results.every((r) => typeof r.meta?.duration === "number")
          ? results.reduce((sum, r) => sum + r.meta.duration, 0)
          : null;
        const metrics = { ...measured.metrics(), d1Calls: 1 };
        if (scenario === "unchanged") assert.equal(metrics.rowsWritten, 0);
        const content = await db
          .prepare(`SELECT COUNT(*) n,
          SUM(review_status='ignored') ignored, SUM(first_seen_at=?) first_seen,
          SUM(last_seen_at=?) last_seen, SUM(sample_title LIKE '% changed') changed
          FROM knowledge_catalog_candidates`)
          .bind(AT, desired[0].lastSeenAt)
          .all<{
            n: number;
            ignored: number;
            first_seen: number;
            last_seen: number;
            changed: number;
          }>();
        const row = content.results[0];
        assert.deepEqual(row, {
          n: size,
          ignored: size / 2,
          first_seen: size,
          last_seen: size,
          changed: scenario === "many-changes" ? size : scenario === "few-changes" ? size / 100 : 0,
        });
        await recordCostSample(
          `candidate-publication-${scenario}-${size}`,
          "local-workerd",
          metrics,
          ["test/knowledge-catalog-candidate-write-budget.test.ts"],
          [
            "Same ordered candidates; setup excluded; manual ignore and original first_seen retained; timestamp precision preserved.",
          ],
        );
        console.log(
          JSON.stringify({
            event: "candidate_publication_cost",
            size,
            scenario,
            ...metrics,
            sqlDurationMs,
            elapsedMs,
          }),
        );
      }
    } finally {
      await dispose();
    }
  }, 120_000);
}
