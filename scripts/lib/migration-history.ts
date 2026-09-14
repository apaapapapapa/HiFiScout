import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface MigrationSource {
  name: string;
  sql: string;
}

/** Keep the unchanged migration and Wrangler-compatible history entry in one transaction. */
export function migrationQuery(migration: MigrationSource): string {
  return `${migration.sql}\nINSERT INTO d1_migrations(name) VALUES ('${migration.name.replace(/'/g, "''")}');\n`;
}

export function gitText(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function resolveMigrationBase(root: string, ref: string): string {
  if (!ref || /^0+$/u.test(ref)) throw new Error("A real migration baseline commit is required");
  return gitText(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
}

export function migrationsAt(root: string, sha: string): MigrationSource[] {
  return gitText(root, ["ls-tree", "-r", "--name-only", sha, "--", "migrations/"])
    .trim()
    .split("\n")
    .filter((path) => /^migrations\/[^/]+\.sql$/u.test(path))
    .sort()
    .map((path) => ({
      name: path.slice("migrations/".length),
      sql: gitText(root, ["show", `${sha}:${path}`]),
    }));
}

export function workingMigrations(root: string): MigrationSource[] {
  return readdirSync(join(root, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const path = join(root, "migrations", name);
      if (!lstatSync(path).isFile()) throw new Error(`Migration must be a regular file: ${name}`);
      return { name, sql: readFileSync(path, "utf8") };
    });
}

// #680 and #681 merged the same next number concurrently. D1 history was checked before
// renumbering: neither 0127 migration was applied. Keep this exception bound to exact filenames
// AND bytes; it cannot permit another rename or SQL edit. applyRemoteMigrations independently
// rejects a checkout missing any applied filename, so an unexpectedly applied old name still
// stops deployment before importing SQL. Do not add a general rename exemption.
const UNDEPLOYED_RENUMBERING = {
  from: "0127_taket_ws_catalog.sql",
  to: "0128_taket_ws_catalog.sql",
  sha256: "12e10121ff558127806b7406b97ff99a9696671ee6bb043a054526aac7336fca",
};

/** Freeze baseline bytes and filenames, except the recorded byte-identical, unapplied repair. */
export function checkMigrationHistory(root: string, ref: string) {
  const baseSha = resolveMigrationBase(root, ref);
  const baseline = migrationsAt(root, baseSha);
  if (!baseline.length) throw new Error(`No migrations found at baseline ${baseSha}`);
  const current = workingMigrations(root);
  const currentByName = new Map(current.map((migration) => [migration.name, migration.sql]));
  const old = baseline.find(({ name }) => name === UNDEPLOYED_RENUMBERING.from);
  const replacement = currentByName.get(UNDEPLOYED_RENUMBERING.to);
  const renumbered =
    old &&
    !currentByName.has(old.name) &&
    replacement === old.sql &&
    createHash("sha256").update(old.sql).digest("hex") === UNDEPLOYED_RENUMBERING.sha256;
  const changed = gitText(root, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=DMRTUXB",
    baseSha,
    "--",
    "migrations/*.sql",
  ])
    .trim()
    .split("\n")
    .filter((path) => path && !(renumbered && path === `migrations/${old.name}`))
    .join("\n");
  if (changed)
    throw new Error(
      `Frozen migration changed, deleted or renamed: ${changed}. Add a forward migration instead.`,
    );
  for (const migration of baseline) {
    if (renumbered && migration.name === old.name) continue;
    if (currentByName.get(migration.name) !== migration.sql) {
      throw new Error(
        `Frozen migration changed, deleted or renamed: ${migration.name}. Add a forward migration instead.`,
      );
    }
  }
  const baselineNames = new Set(baseline.map(({ name }) => name));
  const additions = current.filter(({ name }) => !baselineNames.has(name));
  let lastPrefix = Math.max(...baseline.map(({ name }) => Number(name.slice(0, 4))));
  for (const migration of additions) {
    if (
      !/^\d{4}_[a-z0-9_]+\.sql$/u.test(migration.name) ||
      Number(migration.name.slice(0, 4)) !== lastPrefix + 1
    ) {
      throw new Error(
        `New migrations must append unique consecutive numbers after ${lastPrefix}: ${migration.name}`,
      );
    }
    lastPrefix += 1;
  }
  return { baseSha, baseline, current, additions };
}
