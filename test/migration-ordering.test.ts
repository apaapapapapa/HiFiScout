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
 * Prefix collisions already in `main`.
 *
 * These are applied in production and cannot be renamed, so they are recorded rather than fixed.
 * The list only ever shrinks — by a migration being deleted, never by a new pair being added. A new
 * collision fails the test below instead of joining this list.
 */
const KNOWN_DUPLICATE_PREFIXES: readonly string[] = ["0058", "0063"];

test("a new migration takes a number no other migration has", () => {
  const byPrefix = new Map<string, string[]>();
  for (const file of migrationFiles()) {
    const prefix = /^(\d{4})_/.exec(file)?.[1];
    assert.ok(prefix, `migration ${file} does not start with a four-digit ordering prefix`);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) || []), file]);
  }

  const duplicates = [...byPrefix.entries()].filter(([, files]) => files.length > 1);
  const unexpected = duplicates.filter(([prefix]) => !KNOWN_DUPLICATE_PREFIXES.includes(prefix));

  assert.deepEqual(
    unexpected.map(([, files]) => files),
    [],
    "two migrations share an ordering prefix; renumber the unmerged one before it reaches production",
  );

  // The recorded pairs have to stay real, or the allowance silently starts excusing a live collision.
  for (const prefix of KNOWN_DUPLICATE_PREFIXES) {
    assert.ok(
      (byPrefix.get(prefix)?.length ?? 0) > 1,
      `${prefix} is no longer a duplicate; drop it from KNOWN_DUPLICATE_PREFIXES`,
    );
  }
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
