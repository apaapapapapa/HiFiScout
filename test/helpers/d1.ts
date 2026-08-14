import type { QueryableDatabase } from "../../src/db/types.js";
import type { EvidenceDatabase } from "../../src/evidence/evidence-archive.js";

/**
 * Adapts deliberately small, behavior-focused D1 fakes to the repository boundary.
 * The assertion stays in one test-only location because Cloudflare's generic D1 methods cannot
 * be implemented structurally by fixtures that return a fixed row shape.
 */
export function asQueryableDatabase<T extends object>(database: T): T & QueryableDatabase {
  return database as T & QueryableDatabase;
}

export function asEvidenceDatabase<T extends object>(database: T): T & EvidenceDatabase {
  return database as T & EvidenceDatabase;
}
