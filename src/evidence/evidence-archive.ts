import { errorMessage } from "../types.js";
import type {
  EvidenceArchiveResult,
  EvidenceReason,
  EvidenceRetentionClass,
  EvidenceSuppressionReason,
  EvidenceUsage,
} from "../db/types.js";

// ---------------------------------------------------------------------------
// Bindings, narrowed to the members this module actually calls
// ---------------------------------------------------------------------------

/** Every statement here is bound before it is read, so `bind` is the only prepared member. */
export interface EvidencePreparedStatement {
  bind(...values: unknown[]): EvidenceBoundStatement;
}

export interface EvidenceBoundStatement {
  all<TRow = Record<string, unknown>>(): Promise<{ results?: TRow[] }>;
  run(): Promise<unknown>;
}

/** Structural subset of `D1Database`; the real binding and the test doubles both satisfy it. */
export interface EvidenceDatabase {
  prepare(query: string): EvidencePreparedStatement;
}

/** Structural subset of `R2Bucket`: the archive only ever writes. */
export interface EvidenceBucket {
  put(
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

/**
 * The environment view `archiveEvidence` needs.
 *
 * Every member is optional because the binding check is a runtime guard, and the tuning
 * variables are plain `wrangler.jsonc` vars. The generated `Env` and `CrawlerEnv` are both
 * assignable to this.
 */
export interface EvidenceArchiveEnv {
  readonly DB?: EvidenceDatabase;
  readonly EVIDENCE_BUCKET?: EvidenceBucket;
  readonly EVIDENCE_MAX_BYTES?: string;
  readonly EVIDENCE_DAILY_MAX_OBJECTS?: string;
  readonly EVIDENCE_DAILY_MAX_BYTES?: string;
  readonly EVIDENCE_SHOP_DAILY_MAX_OBJECTS?: string;
  readonly EVIDENCE_BURST_WINDOW_MINUTES?: string;
  readonly EVIDENCE_BURST_MAX_OBJECTS?: string;
  readonly EVIDENCE_BURST_SAMPLE_RATE?: string;
  readonly EVIDENCE_STORAGE_WARNING_BYTES?: string;
}

/** Resolved tuning knobs; every field comes from `numericSetting`. */
export interface EvidenceSafetySettings {
  dailyMaxObjects: number;
  dailyMaxBytes: number;
  shopDailyMaxObjects: number;
  burstWindowMinutes: number;
  burstMaxObjects: number;
  burstSampleRate: number;
  storageWarningBytes: number;
}

export interface ArchiveEvidenceOptions {
  env?: EvidenceArchiveEnv;
  shopKey?: string;
  reason?: string;
  html?: string;
  productId?: number | null;
  crawlRunId?: number | null;
  contentType?: string;
  capturedAt?: string;
  eventId?: string;
}

const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_DAILY_MAX_OBJECTS = 500;
const DEFAULT_DAILY_MAX_BYTES = 200_000_000;
const DEFAULT_SHOP_DAILY_MAX_OBJECTS = 100;
const DEFAULT_BURST_WINDOW_MINUTES = 15;
const DEFAULT_BURST_MAX_OBJECTS = 20;
const DEFAULT_BURST_SAMPLE_RATE = 10;
const DEFAULT_STORAGE_WARNING_BYTES = 8_000_000_000;
const RETENTION_DAYS: Readonly<Record<EvidenceRetentionClass, number>> = Object.freeze({
  short: 30,
  medium: 90,
  long: 365,
});
const REASON_RETENTION: Readonly<Partial<Record<string, EvidenceRetentionClass>>> = Object.freeze({
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

interface BoundedHtml {
  body: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

interface ObjectKeyOptions {
  shopKey: unknown;
  retentionClass: EvidenceRetentionClass;
  capturedAt: string;
  eventId: string;
}

interface EvidenceUsageOptions {
  shopKey: string | undefined;
  reason: EvidenceReason;
  capturedAt: string;
  burstWindowMinutes: number;
}

interface EvidenceLogOptions {
  shopKey: string | undefined;
  reason: EvidenceReason;
  suppressionReason: EvidenceSuppressionReason;
  usage: EvidenceUsage;
  settings: EvidenceSafetySettings;
}

interface DuplicateEvidenceRow extends Record<string, unknown> {
  id?: number;
  r2_object_key?: string;
}

interface CountRow extends Record<string, unknown> {
  object_count?: number;
  byte_count?: number;
}

function numericSetting(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redactSensitiveTag(tag: string): string {
  if (!/(?:token|secret|password|passwd|session|cookie|authorization|auth|csrf|xsrf)/iu.test(tag)) {
    return tag;
  }
  return tag
    .replace(/\svalue\s*=\s*(["']).*?\1/giu, ' value="[REDACTED]"')
    .replace(/\scontent\s*=\s*(["']).*?\1/giu, ' content="[REDACTED]"');
}

export function sanitizeEvidenceHtml(value: unknown = ""): string {
  return String(value)
    .replace(/<(?:input|meta)\b[^>]*>/giu, redactSensitiveTag)
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|auth(?:orization)?|session|cookie|csrf|xsrf|password)["']?\s*[:=]\s*)(["'])(.*?)\2/giu,
      "$1$2[REDACTED]$2",
    );
}

function boundedHtml(value: string, maxBytes: number): BoundedHtml {
  const bytes = new TextEncoder().encode(sanitizeEvidenceHtml(value));
  if (bytes.byteLength <= maxBytes) return { body: bytes, truncated: false };
  return { body: bytes.slice(0, maxBytes), truncated: true };
}

export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function evidenceRetentionClass(reason: unknown): EvidenceRetentionClass | "" {
  return typeof reason === "string" ? REASON_RETENTION[reason] || "" : "";
}

export function shouldArchiveEvidence(reason: unknown): reason is EvidenceReason {
  return Boolean(evidenceRetentionClass(reason));
}

function safeSegment(value: unknown, fallback = "unknown"): string {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function objectKey({ shopKey, retentionClass, capturedAt, eventId }: ObjectKeyOptions): string {
  const date = new Date(capturedAt);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const year = safeDate.getUTCFullYear();
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  return `evidence/${retentionClass}/${safeSegment(shopKey)}/${year}/${month}/${day}/${safeSegment(eventId, crypto.randomUUID())}.html`;
}

function expiresAt(capturedAt: string, retentionClass: EvidenceRetentionClass): string | null {
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime())) return null;
  const days = RETENTION_DAYS[retentionClass];
  return new Date(captured.getTime() + days * 86_400_000).toISOString();
}

function utcDayBounds(capturedAt: string): { start: string; end: string } {
  const date = new Date(capturedAt);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const start = new Date(
    Date.UTC(safeDate.getUTCFullYear(), safeDate.getUTCMonth(), safeDate.getUTCDate()),
  );
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

async function firstRow<TRow extends Record<string, unknown>>(
  statement: EvidenceBoundStatement,
): Promise<Partial<TRow>> {
  const result = await statement.all<TRow>();
  return result.results?.[0] ?? {};
}

async function findDuplicate(
  db: EvidenceDatabase,
  shopKey: string | undefined,
  reason: EvidenceReason,
  contentHash: string,
  capturedAt: string,
): Promise<Partial<DuplicateEvidenceRow>> {
  return firstRow<DuplicateEvidenceRow>(
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

async function readEvidenceUsage(
  db: EvidenceDatabase,
  { shopKey, reason, capturedAt, burstWindowMinutes }: EvidenceUsageOptions,
): Promise<EvidenceUsage> {
  const day = utcDayBounds(capturedAt);
  const capturedMs = new Date(capturedAt).getTime();
  const safeCapturedMs = Number.isFinite(capturedMs) ? capturedMs : Date.now();
  const burstStart = new Date(safeCapturedMs - burstWindowMinutes * 60_000).toISOString();

  const daily = await firstRow<CountRow>(
    db
      .prepare(`
        SELECT COUNT(*) AS object_count, COALESCE(SUM(content_bytes), 0) AS byte_count
        FROM evidence_archive
        WHERE captured_at >= ? AND captured_at < ?
      `)
      .bind(day.start, day.end),
  );
  const shopDaily = await firstRow<CountRow>(
    db
      .prepare(`
        SELECT COUNT(*) AS object_count
        FROM evidence_archive
        WHERE shop_key = ? AND captured_at >= ? AND captured_at < ?
      `)
      .bind(shopKey, day.start, day.end),
  );
  const burst = await firstRow<CountRow>(
    db
      .prepare(`
        SELECT COUNT(*) AS object_count
        FROM evidence_archive
        WHERE shop_key = ? AND reason = ? AND captured_at >= ? AND captured_at <= ?
      `)
      .bind(shopKey, reason, burstStart, capturedAt),
  );
  const storage = await firstRow<CountRow>(
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

function deterministicSample(contentHash: string, rate: number): boolean {
  if (rate <= 1) return true;
  const prefix = Number.parseInt(contentHash.slice(0, 8), 16);
  return Number.isFinite(prefix) && prefix % rate === 0;
}

function evidenceSafetySettings(env: EvidenceArchiveEnv): EvidenceSafetySettings {
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

function quotaSuppressionReason(
  usage: EvidenceUsage,
  settings: EvidenceSafetySettings,
  incomingBytes: number,
): Exclude<EvidenceSuppressionReason, "burst_sampled"> | "" {
  if (usage.dailyObjects >= settings.dailyMaxObjects) return "daily_object_cap";
  if (usage.dailyBytes + incomingBytes > settings.dailyMaxBytes) return "daily_byte_cap";
  if (usage.shopDailyObjects >= settings.shopDailyMaxObjects) return "shop_daily_object_cap";
  return "";
}

function logSuppressed({
  shopKey,
  reason,
  suppressionReason,
  usage,
  settings,
}: EvidenceLogOptions): void {
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
}: ArchiveEvidenceOptions = {}): Promise<EvidenceArchiveResult> {
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
    if (duplicate.id && duplicate.r2_object_key) {
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
    if (!retentionClass) return { status: "skipped", reason: "not_archiveable" };
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
        message: errorMessage(error),
      }),
    );
    return { status: "failed", reason: "archive_error", error: errorMessage(error) };
  }
}

export const EVIDENCE_RETENTION_DAYS = RETENTION_DAYS;
