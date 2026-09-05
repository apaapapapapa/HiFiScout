import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { checkMigrationHistory, gitText } from "../scripts/lib/migration-history.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "migration-history-"));
  gitText(root, ["init", "--quiet"]);
  gitText(root, ["config", "user.email", "test@example.test"]);
  gitText(root, ["config", "user.name", "Migration test"]);
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "migrations/0001_initial.sql"), "CREATE TABLE example(id INTEGER);\n");
  writeFileSync(
    join(root, "migrations/0002_next.sql"),
    "ALTER TABLE example ADD COLUMN value TEXT;\n",
  );
  gitText(root, ["add", "."]);
  gitText(root, ["commit", "--quiet", "-m", "baseline"]);
  return root;
}

for (const action of ["edit", "delete", "rename", "reuse", "gap"] as const) {
  test(`migration history rejects ${action}, including changes to the newest file`, () => {
    const root = fixture();
    try {
      const last = join(root, "migrations/0002_next.sql");
      if (action === "edit") writeFileSync(last, "-- even a comment changes frozen bytes\n");
      if (action === "delete") rmSync(last);
      if (action === "rename") renameSync(last, join(root, "migrations/0002_renamed.sql"));
      if (action === "reuse") writeFileSync(join(root, "migrations/0002_extra.sql"), "SELECT 1;");
      if (action === "gap") writeFileSync(join(root, "migrations/0004_extra.sql"), "SELECT 1;");
      assert.throws(() => checkMigrationHistory(root, "HEAD"), /Frozen migration|append unique/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("migration history allows forward additions and fails closed without a baseline", () => {
  const root = fixture();
  try {
    assert.equal(checkMigrationHistory(root, "HEAD").additions.length, 0);
    writeFileSync(
      join(root, "migrations/0003_fix.sql"),
      "CREATE INDEX idx_example ON example(value);\n",
    );
    assert.equal(checkMigrationHistory(root, "HEAD").additions.length, 1);
    assert.throws(() => checkMigrationHistory(root, "000000"), /baseline/u);
    assert.throws(() => checkMigrationHistory(root, "absent-branch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
