import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Cache only generated schema documentation; migration safety tests always use a fresh D1. */
export function schemaDocumentationFingerprint(root: string): string {
  const files = [
    ...readdirSync(join(root, "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => `migrations/${name}`),
    "wrangler.jsonc",
    "package.json",
    "package-lock.json",
    "scripts/docs/generate-db-docs.sh",
    "scripts/docs/find-d1-database.ts",
    "scripts/docs/hifiscout-sqlite.properties",
    "scripts/docs/db-docs-cache.ts",
  ].sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(root, file)))
      .update("\0");
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(schemaDocumentationFingerprint(process.cwd()));
}
