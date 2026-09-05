import { readdirSync, readFileSync } from "node:fs";

const directory = new URL("../../migrations/", import.meta.url);

/** Immutable SQL is loaded once per test module; database state is always created per test. */
export const migrationSources = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, directory), "utf8") }));
