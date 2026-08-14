import type { KnowledgeCatalogVerifierStateRow, QueryableDatabase } from "./types.js";

interface KnowledgeCatalogVerifierState {
  version: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
}

function number(value: unknown): number {
  return Number(value || 0);
}

export async function claimKnowledgeCatalogVerifierVersion(
  db: QueryableDatabase,
  version: number,
  startedAt: string,
): Promise<boolean> {
  const normalizedVersion = Math.max(1, Math.trunc(Number(version) || 1));
  const result = await db
    .prepare(`
    INSERT OR IGNORE INTO knowledge_catalog_verifier_state(version, status, started_at)
    VALUES (?, 'running', ?)
  `)
    .bind(normalizedVersion, startedAt)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

export async function finishKnowledgeCatalogVerifierVersionSuccess(
  db: QueryableDatabase,
  version: number,
  finishedAt: string,
  message: unknown = "",
): Promise<void> {
  await db
    .prepare(`
    UPDATE knowledge_catalog_verifier_state
    SET status = 'success', finished_at = ?, message = ?
    WHERE version = ?
  `)
    .bind(finishedAt, String(message || "").slice(0, 1000), version)
    .run();
}

export async function finishKnowledgeCatalogVerifierVersionFailure(
  db: QueryableDatabase,
  version: number,
  finishedAt: string,
  message: unknown = "",
): Promise<void> {
  await db
    .prepare(`
    UPDATE knowledge_catalog_verifier_state
    SET status = 'failed', finished_at = ?, message = ?
    WHERE version = ?
  `)
    .bind(finishedAt, String(message || "").slice(0, 1000), version)
    .run();
}

export async function knowledgeCatalogVerifierState(
  db: QueryableDatabase,
): Promise<KnowledgeCatalogVerifierState | null> {
  const row = await db
    .prepare(`
    SELECT version, status, started_at, finished_at, message
    FROM knowledge_catalog_verifier_state
    ORDER BY version DESC
    LIMIT 1
  `)
    .first<KnowledgeCatalogVerifierStateRow>();
  if (!row) return null;
  return {
    version: number(row.version),
    status: row.status || "",
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    message: row.message || "",
  };
}
