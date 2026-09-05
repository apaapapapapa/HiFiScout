import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface MigrationSource {
  name: string;
  sql: string;
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

/** Freeze the baseline bytes and filenames; even deleting the last migration must fail. */
export function checkMigrationHistory(root: string, ref: string) {
  const baseSha = resolveMigrationBase(root, ref);
  const baseline = migrationsAt(root, baseSha);
  if (!baseline.length) throw new Error(`No migrations found at baseline ${baseSha}`);
  const changed = gitText(root, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=DMRTUXB",
    baseSha,
    "--",
    "migrations/*.sql",
  ]).trim();
  if (changed)
    throw new Error(
      `Frozen migration changed, deleted or renamed: ${changed}. Add a forward migration instead.`,
    );
  const current = workingMigrations(root);
  const currentByName = new Map(current.map((migration) => [migration.name, migration.sql]));
  for (const migration of baseline) {
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
