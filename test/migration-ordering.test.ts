import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "vite-plus/test";

/**
 * The migration directory's own invariants.
 *
 * Migrations are applied in filename order, by both D1 and `migratedSqlite`, so the numeric prefix
 * is the schema's total order. Two files sharing a prefix are ordered only by whatever follows it,
 * which nobody chose — the collision happens when two branches both take the next free number and
 * neither rebases before merging, so it is invisible on each branch and only real once both land.
 *
 * Today's collisions are harmless: the pairs touch unrelated tables. The next one may not be, and
 * by then both files are applied in production, where renaming is not available — D1 tracks applied
 * migrations by filename, so a rename re-runs the migration under its new name and leaves the old
 * name recorded forever. That asymmetry is why this is a merge-time check rather than a cleanup.
 */

const MIGRATION_DIRECTORY = new URL("../migrations/", import.meta.url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATION_DIRECTORY)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/**
 * Collisions already in `main`, by the exact files that collide.
 *
 * These are applied in production and cannot be renamed, so they are recorded rather than fixed.
 *
 * Recording filenames rather than the bare prefix is what makes the allowance narrow: an allowance
 * held per prefix would excuse `0063` itself, so a *third* migration numbered `0063` would inherit
 * the exemption and land the very collision this file exists to stop. Each group has to match
 * exactly, so the only edit this list ever accepts is a group leaving it.
 */
const KNOWN_DUPLICATES: readonly (readonly string[])[] = [
  ["0058_crawl_run_progress.sql", "0058_product_correction_reports.sql"],
  [
    "0063_drop_redundant_products_shop_active_index.sql",
    "0063_knowledge_catalog_price_index_deal_score.sql",
  ],
];

test("a new migration takes a number no other migration has", () => {
  const byPrefix = new Map<string, string[]>();
  for (const file of migrationFiles()) {
    const prefix = /^(\d{4})_/.exec(file)?.[1];
    assert.ok(prefix, `migration ${file} does not start with a four-digit ordering prefix`);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) || []), file]);
  }

  // Comparing the whole set of colliding groups at once covers every way this can go wrong with one
  // assertion: a new collision adds a group, a third file under an existing prefix reshapes one, and
  // a collision that stopped being real removes one — which is the reminder to drop it from the list.
  const duplicates = [...byPrefix.values()]
    .filter((files) => files.length > 1)
    .map((files) => [...files].sort());

  assert.deepEqual(
    duplicates,
    KNOWN_DUPLICATES.map((group) => [...group].sort()),
    "the set of migrations sharing an ordering prefix changed; renumber the unmerged one before it reaches production",
  );
});

test("migration prefixes are contiguous, so a gap means a lost file", () => {
  const prefixes = [...new Set(migrationFiles().map((file) => Number(file.slice(0, 4))))].sort(
    (a, b) => a - b,
  );

  const missing = [];
  for (let expected = prefixes[0] ?? 0; expected <= (prefixes.at(-1) ?? 0); expected += 1) {
    if (!prefixes.includes(expected)) missing.push(expected);
  }

  // A hole is either a deleted migration — which production has already applied and will not
  // un-apply — or a file that never got committed. Both are worth failing on.
  assert.deepEqual(missing, [], "migration numbering has a gap");
});
