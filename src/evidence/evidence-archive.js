const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_DAILY_MAX_OBJECTS = 500;
const DEFAULT_DAILY_MAX_BYTES = 200_000_000;
const DEFAULT_SHOP_DAILY_MAX_OBJECTS = 100;
const DEFAULT_BURST_WINDOW_MINUTES = 15;
const DEFAULT_BURST_MAX_OBJECTS = 20;
const DEFAULT_BURST_SAMPLE_RATE = 10;
const DEFAULT_STORAGE_WARNING_BYTES = 8_000_000_000;
const RETENTION_DAYS = Object.freeze({ short: 30, medium: 90, long: 365 });
const REASON_RETENTION = Object.freeze({
  parser_failure: "short",
  temporary_debug_snapshot: "short",
  unexpected_item_count: "medium",
  crawl_validation_failure: "medium",
  unknown_manufacturer: "medium",
  unknown_category: "medium",
  html_structure_change: "medium",
  product_content_changed: "medium",
  classification_unresolved: "long",
  knowledge_catalog_verification: "long",
});

function numericSetting(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
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

export function sanitizeEvidenceHtml(value = "") {
  return String(value)
    .replace(/<(?:input|meta)\b[^>]*>/giu, redactSensitiveTag)
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|auth(?:orization)?|session|cookie|csrf|xsrf|password)["']?\s*[:=]\s*)(["'])(.*?)\2/giu,
      "$1$2[REDACTED]$2",
    );
}

function boundedHtml(value, maxBytes) {
  const bytes = new TextEncoder().encode(sanitizeEvidenceHtml(value));
  if (bytes.byteLength <= maxBytes) return { body: bytes, truncated: false };
  return { body: bytes.slice(0, maxBytes), truncated: true };
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function evidenceRetentionClass(reason) {
  return REASON_RETENTION[reason] || "";
}

export function shouldArchiveEvidence(reason) {
  return Boolean(evidenceRetentionClass(reason));
}

function safeSegment(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function objectKey({ shopKey, retentionClass, capturedAt, eventId }) {
  const date = new Date(capturedAt);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const year = safeDate.getUTCFullYear();
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  return `evidence/${retentionClass}/${safeSegment(shopKey)}/${year}/${month}/${day}/${safeSegment(eventId, crypto.randomUUID())}.html`;
}

function expiresAt(capturedAt, retentionClass) {
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime())) return null;
  const days = RETENTION_DAYS[retentionClass];
  return new Date(captured.getTime() + days * 86_400_000).toISOString();
}

function utcDayBounds(capturedAt) {
  const date = new Date(capturedAt);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const start = new Date(Date.UTC(safeDate.getUTCFullYear(), safeDate.getUTCMonth(), safeDate.getUTCDate()));
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

async function firstRow(statement) {
  const result = await statement.all();
  return result.results?.[0] || {};
}

async function findDuplicate(db, shopKey, reason, contentHash, capturedAt) {
  return firstRow(
    db
      .prepare(`
        SELECT id, r2_object_key
        FROM evidence_archive
        WHERE shop_key = ? AND reason = ? AND content_hash = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY captured_at DESC
        LIMIT 1
      `)
      .bind(shopKey, reason, contentHash, capturedAt),
  );
}

async function readEvidenceUsage(db, { shopKey, reason, capturedAt, burstWindowMinutes }) {
  const day = utcDayBounds(capturedAt);
  const capturedMs = new Date(capturedAt).getTime();
  const safeCapturedMs = Number.isFinite(capturedMs) ? capturedMs : Date.now();
  const burstStart = new Date(safeCapturedMs - burstWindowMinutes * 60_000).toISOString();

  const daily = await firstRow(
    db
      .prepare(`
        SELECT COUNT(*) AS object_count, COALESCE(SUM(content_bytes), 0) AS byte_count
        FROM evidence_archive
        WHERE captured_at >= ? AND captured_at < ?
      `)
      .bind(day.start, day.end),
  );
  const shopDaily = await firstRow(
    db
      .prepare(`
        SELECT COUNT(*) AS object_count
        FROM evidence_archive
        WHERE shop_key = ? AND captured_at >= ? AND captured_at < ?
      `)
      .bind(shopKey, day.start, day.end),
  );
  const burst = await firstRow(
    db
      .prepare(`
        SELECT COUNT(*) AS object_count
        FROM evidence_archive
        WHERE shop_key = ? AND reason = ? AND captured_at >= ? AND captured_at <= ?
      `)
      .bind(shopKey, reason, burstStart, capturedAt),
  );
  const storage = await firstRow(
    db
      .prepare(`
        SELECT COALESCE(SUM(content_bytes), 0) AS byte_count
        FROM evidence_archive
        WHERE expires_at IS NULL OR expires_at > ?
      `)
      .bind(capturedAt),
  );

  return {
    dailyObjects: Number(daily.object_count || 0),
    dailyBytes: Number(daily.byte_count || 0),
    shopDailyObjects: Number(shopDaily.object_count || 0),
    burstObjects: Number(burst.object_count || 0),
    estimatedStoredBytes: Number(storage.byte_count || 0),
  };
}

function deterministicSample(contentHash, rate) {
  if (rate <= 1) return true;
  const prefix = Number.parseInt(contentHash.slice(0, 8), 16);
  return Number.isFinite(prefix) && prefix % rate === 0;
}

function evidenceSafetySettings(env) {
  return {
    dailyMaxObjects: numericSetting(env.EVIDENCE_DAILY_MAX_OBJECTS, DEFAULT_DAILY_MAX_OBJECTS),
    dailyMaxBytes: numericSetting(env.EVIDENCE_DAILY_MAX_BYTES, DEFAULT_DAILY_MAX_BYTES),
    shopDailyMaxObjects: numericSetting(
      env.EVIDENCE_SHOP_DAILY_MAX_OBJECTS,
      DEFAULT_SHOP_DAILY_MAX_OBJECTS,
    ),
    burstWindowMinutes: numericSetting(
      env.EVIDENCE_BURST_WINDOW_MINUTES,
      DEFAULT_BURST_WINDOW_MINUTES,
    ),
    burstMaxObjects: numericSetting(env.EVIDENCE_BURST_MAX_OBJECTS, DEFAULT_BURST_MAX_OBJECTS),
    burstSampleRate: numericSetting(env.EVIDENCE_BURST_SAMPLE_RATE, DEFAULT_BURST_SAMPLE_RATE),
    storageWarningBytes: numericSetting(
      env.EVIDENCE_STORAGE_WARNING_BYTES,
      DEFAULT_STORAGE_WARNING_BYTES,
    ),
  };
}

function quotaSuppressionReason(usage, settings, incomingBytes) {
  if (usage.dailyObjects >= settings.dailyMaxObjects) return "daily_object_cap";
  if (usage.dailyBytes + incomingBytes > settings.dailyMaxBytes) return "daily_byte_cap";
  if (usage.shopDailyObjects >= settings.shopDailyMaxObjects) return "shop_daily_object_cap";
  return "";
}

function logSuppressed({ shopKey, reason, suppressionReason, usage, settings }) {
  console.warn(
    JSON.stringify({
      event: "evidence_archive_suppressed",
      shopKey,
      reason,
      suppressionReason,
      usage,
      limits: settings,
      evidence_archive_suppressed_count: 1,
    }),
  );
}

export async function archiveEvidence({
  env,
  shopKey,
  reason,
  html,
  productId = null,
  crawlRunId = null,
  contentType = "text/html; charset=utf-8",
  capturedAt = new Date().toISOString(),
  eventId = crypto.randomUUID(),
} = {}) {
  if (!shouldArchiveEvidence(reason) || !html)
    return { status: "skipped", reason: "not_archiveable" };
  if (!env?.DB || !env?.EVIDENCE_BUCKET?.put) {
    console.warn(
      JSON.stringify({
        event: "evidence_archive_failure",
        shopKey,
        reason,
        evidence_archive_failure_count: 1,
        message: "evidence_archive_binding_missing",
      }),
    );
    return { status: "failed", reason: "binding_missing" };
  }

  try {
    const maxBytes = numericSetting(env.EVIDENCE_MAX_BYTES, DEFAULT_MAX_BYTES);
    const bounded = boundedHtml(html, maxBytes);
    const contentHash = await sha256Hex(bounded.body);
    const duplicate = await findDuplicate(env.DB, shopKey, reason, contentHash, capturedAt);
    if (duplicate?.id) {
      return {
        status: "deduplicated",
        contentHash,
        objectKey: duplicate.r2_object_key,
      };
    }

    const settings = evidenceSafetySettings(env);
    const usage = await readEvidenceUsage(env.DB, {
      shopKey,
      reason,
      capturedAt,
      burstWindowMinutes: settings.burstWindowMinutes,
    });
    const suppressionReason = quotaSuppressionReason(usage, settings, bounded.body.byteLength);
    if (suppressionReason) {
      logSuppressed({ shopKey, reason, suppressionReason, usage, settings });
      return { status: "suppressed", reason: suppressionReason, usage };
    }

    if (
      usage.burstObjects >= settings.burstMaxObjects &&
      !deterministicSample(contentHash, settings.burstSampleRate)
    ) {
      logSuppressed({ shopKey, reason, suppressionReason: "burst_sampled", usage, settings });
      return { status: "suppressed", reason: "burst_sampled", usage };
    }

    if (usage.estimatedStoredBytes >= settings.storageWarningBytes) {
      console.warn(
        JSON.stringify({
          event: "evidence_storage_warning",
          estimatedStoredBytes: usage.estimatedStoredBytes,
          warningThresholdBytes: settings.storageWarningBytes,
          evidence_storage_warning_count: 1,
        }),
      );
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

    await env.DB.prepare(`
        INSERT INTO evidence_archive(
          shop_key, product_id, crawl_run_id, reason, content_hash, r2_object_key,
          content_type, content_bytes, captured_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        shopKey,
        productId,
        crawlRunId,
        reason,
        contentHash,
        r2ObjectKey,
        contentType,
        bounded.body.byteLength,
        capturedAt,
        expiry,
      )
      .run();

    console.log(
      JSON.stringify({
        event: "evidence_archived",
        shopKey,
        reason,
        contentHash,
        retentionClass,
        contentBytes: bounded.body.byteLength,
        truncated: bounded.truncated,
        evidence_archived_count: 1,
      }),
    );
    return {
      status: "archived",
      contentHash,
      contentBytes: bounded.body.byteLength,
      objectKey: r2ObjectKey,
      expiresAt: expiry,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "evidence_archive_failure",
        shopKey,
        reason,
        evidence_archive_failure_count: 1,
        message: error?.message || String(error),
      }),
    );
    return { status: "failed", reason: "archive_error", error: error?.message || String(error) };
  }
}

export const EVIDENCE_RETENTION_DAYS = RETENTION_DAYS;
