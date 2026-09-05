import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { schemaDocumentationFingerprint } from "../scripts/docs/db-docs-cache.js";

test("schema documentation cache follows schema and generator inputs, independent of application edits", () => {
  const root = mkdtempSync(join(tmpdir(), "schema-docs-cache-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    for (const path of [
      "migrations/0001.sql",
      "wrangler.jsonc",
      "package.json",
      "package-lock.json",
      "scripts/docs/generate-db-docs.sh",
      "scripts/docs/find-d1-database.ts",
      "scripts/docs/hifiscout-sqlite.properties",
      "scripts/docs/db-docs-cache.ts",
    ])
      write(path, "fixture");
    const baseline = schemaDocumentationFingerprint(root);
    write("src/worker.ts", "new application code");
    write("docs/guide.md", "new prose");
    assert.equal(schemaDocumentationFingerprint(root), baseline);
    write("migrations/0002.sql", "ALTER TABLE products ADD COLUMN fixture TEXT;");
    const schemaChange = schemaDocumentationFingerprint(root);
    assert.notEqual(schemaChange, baseline);
    write("scripts/docs/hifiscout-sqlite.properties", "new JDBC configuration");
    assert.notEqual(schemaDocumentationFingerprint(root), schemaChange);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
