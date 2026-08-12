const DEFAULT_MAX_BYTES = 1_500_000;
const RETENTION_DAYS = Object.freeze({ short: 30, medium: 90, long: 365 });
const REASON_RETENTION = Object.freeze({
  parser_failure: 'short',
  temporary_debug_snapshot: 'short',
  unexpected_item_count: 'medium',
  crawl_validation_failure: 'medium',
  unknown_manufacturer: 'medium',
  unknown_category: 'medium',
  html_structure_change: 'medium',
  product_content_changed: 'medium',
  classification_unresolved: 'long',
  knowledge_catalog_verification: 'long',
});

function numericSetting(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redactSensitiveTag(tag) {
  if (!/(?:token|secret|password|passwd|session|cookie|authorization|auth|csrf|xsrf)/iu.test(tag)) {
    return tag;
  }
  return tag
    .replace(/\svalue\s*=\s*(["']).*?\1/giu, ' value="[REDACTED]"')
    .replace(/\scontent\s*=\s*(["']).*?\1/giu, ' content="[REDACTED]"');
}

export function sanitizeEvidenceHtml(value = '') {
  return String(value)
    .replace(/<(?:input|meta)\b[^>]*>/giu, redactSensitiveTag)
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|auth(?:orization)?|session|cookie|csrf|xsrf|password)["']?\s*[:=]\s*)(["'])(.*?)\2/giu,
      '$1$2[REDACTED]$2',
    );
}

function boundedHtml(value, maxBytes) {
  const bytes = new TextEncoder().encode(sanitizeEvidenceHtml(value));
  if (bytes.byteLength <= maxBytes) return { body: bytes, truncated: false };
  return { body: bytes.slice(0, maxBytes), truncated: true };
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function evidenceRetentionClass(reason) {
  return REASON_RETENTION[reason] || '';
}

export function shouldArchiveEvidence(reason) {
  return Boolean(evidenceRetentionClass(reason));
}

function safeSegment(value, fallback = 'unknown') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function objectKey({ shopKey, retentionClass, capturedAt, eventId }) {
  const date = new Date(capturedAt);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const year = safeDate.getUTCFullYear();
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getUTCDate()).padStart(2, '0');
  return `evidence/${retentionClass}/${safeSegment(shopKey)}/${year}/${month}/${day}/${safeSegment(eventId, crypto.randomUUID())}.html`;
}

function expiresAt(capturedAt, retentionClass) {
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime())) return null;
  const days = RETENTION_DAYS[retentionClass];
  return new Date(captured.getTime() + days * 86_400_000).toISOString();
}

async function findDuplicate(db, shopKey, reason, contentHash, capturedAt) {
  const result = await db
    .prepare(`
      SELECT id, r2_object_key
      FROM evidence_archive
      WHERE shop_key = ? AND reason = ? AND content_hash = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY captured_at DESC
      LIMIT 1
    `)
    .bind(shopKey, reason, contentHash, capturedAt)
    .all();
  return result.results?.[0] || null;
}

export async function archiveEvidence({
  env,
  shopKey,
  reason,
  html,
  productId = null,
  crawlRunId = null,
  contentType = 'text/html; charset=utf-8',
  capturedAt = new Date().toISOString(),
  eventId = crypto.randomUUID(),
} = {}) {
  if (!shouldArchiveEvidence(reason) || !html) return { status: 'skipped', reason: 'not_archiveable' };
  if (!env?.DB || !env?.EVIDENCE_BUCKET?.put) {
    console.warn(
      JSON.stringify({
        event: 'evidence_archive_failure',
        shopKey,
        reason,
        evidence_archive_failure_count: 1,
        message: 'evidence_archive_binding_missing',
      }),
    );
    return { status: 'failed', reason: 'binding_missing' };
  }

  try {
    const maxBytes = numericSetting(env.EVIDENCE_MAX_BYTES, DEFAULT_MAX_BYTES);
    const bounded = boundedHtml(html, maxBytes);
    const contentHash = await sha256Hex(bounded.body);
    const duplicate = await findDuplicate(env.DB, shopKey, reason, contentHash, capturedAt);
    if (duplicate) {
      return {
        status: 'deduplicated',
        contentHash,
        objectKey: duplicate.r2_object_key,
      };
    }

    const retentionClass = evidenceRetentionClass(reason);
    const r2ObjectKey = objectKey({ shopKey, retentionClass, capturedAt, eventId });
    const expiry = expiresAt(capturedAt, retentionClass);
    await env.EVIDENCE_BUCKET.put(r2ObjectKey, bounded.body, {
      httpMetadata: { contentType },
      customMetadata: {
        shopKey: safeSegment(shopKey),
        reason,
        contentHash,
        retentionClass,
        truncated: String(bounded.truncated),
      },
    });

    await env.DB
      .prepare(`
        INSERT INTO evidence_archive(
          shop_key, product_id, crawl_run_id, reason, content_hash, r2_object_key,
          content_type, captured_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        shopKey,
        productId,
        crawlRunId,
        reason,
        contentHash,
        r2ObjectKey,
        contentType,
        capturedAt,
        expiry,
      )
      .run();

    console.log(
      JSON.stringify({
        event: 'evidence_archived',
        shopKey,
        reason,
        contentHash,
        retentionClass,
        truncated: bounded.truncated,
        evidence_archived_count: 1,
      }),
    );
    return { status: 'archived', contentHash, objectKey: r2ObjectKey, expiresAt: expiry };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'evidence_archive_failure',
        shopKey,
        reason,
        evidence_archive_failure_count: 1,
        message: error?.message || String(error),
      }),
    );
    return { status: 'failed', reason: 'archive_error', error: error?.message || String(error) };
  }
}

export const EVIDENCE_RETENTION_DAYS = RETENTION_DAYS;
