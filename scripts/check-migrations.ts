import { checkMigrationHistory } from "./lib/migration-history.js";

const result = checkMigrationHistory(
  process.cwd(),
  process.env.MIGRATION_BASE_REF || "origin/main",
);
console.log(
  `Migration history verified: ${result.baseline.length} frozen, ${result.additions.length} appended (base ${result.baseSha}).`,
);
