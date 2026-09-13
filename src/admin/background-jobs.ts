import { registryVersion } from "../db/admin-manufacturer-management.js";
import { readAdminManufacturerAliases } from "../db/admin-manufacturer-registry.js";
import type { ManufacturerAliasEvidence } from "../catalog/types.js";
import {
  readManufacturerChange,
  scanManufacturerImpact,
  type ManufacturerMatcher,
} from "../db/admin-manufacturer-management.js";
import {
  ListingReplaySourceChangedError,
  replayAdminCsvListings,
} from "../db/data-quality-remediation-service.js";
import { DurableObject } from "cloudflare:workers";
import type {
  AdminBackgroundJob,
  AdminCsvApplyInput,
  AdminCsvResult,
  AdminJobCommand,
  AdminJobDetail,
  AdminJobList,
  AdminJobStatus,
} from "../api/admin-csv-contracts.js";
import { ADMIN_CSV_MAX_REQUEST_BYTES } from "../api/admin-csv-contracts.js";
import { parseAdminJobCommand } from "../http/admin-jobs.js";
import { readJsonBody, REQUEST_BODY_TOO_LARGE } from "../http/request.js";
import { trustedActor } from "../api/admin-actor.js";
import { isRecord } from "../types.js";
import { applyAdminCsvChange } from "../db/admin-csv-import-repository.js";
import { stepOfferFactReplay } from "../db/offer-fact-replay-repository.js";
import { OFFER_FACT_RULE_VERSION } from "../catalog/offer-facts.js";
import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import {
  needsAdminResolutionReplay,
  scanAdminResolutionReplay,
} from "../db/admin-resolution-replay.js";
import {
  applyCatalogReplay,
  CatalogReplayChangedError,
  CATALOG_REPLAY_VERSIONS_JSON,
  readCatalogReplaySnapshot,
  scanAdminCatalogReplay,
} from "../db/admin-catalog-replay.js";
import { accountReads, dbUsageMetrics } from "../db/read-accounting.js";

type JobRow = {
  id: string;
  kind: AdminBackgroundJob["kind"];
  label: string;
  status: AdminJobStatus;
  created_at: string;
  updated_at: string;
  total: number;
  uploaded: number;
  uploaded_bytes: number;
  processed: number;
  failed: number;
  after_index: number;
  pass: string;
  rule_version: number;
  error: string;
  expires_at: string;
  details_available: number;
  stalled_steps: number;
  requested_by: string;
};
type ItemRow = {
  ordinal: number;
  state: string;
  input_json: string | null;
  result_json: string | null;
};
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
// A model-only cursor may have already passed category-stale rows. Never reuse it for this scope.
const REPLAY_SCOPE = "model-category";
const REPLAY_VERSIONS_JSON = JSON.stringify({ ...RESOLUTION_VERSIONS, scope: REPLAY_SCOPE });
const listingReplay = (kind: AdminBackgroundJob["kind"]) => kind === "model" || kind === "catalog";
const replayVersions = (kind: AdminBackgroundJob["kind"]) =>
  kind === "catalog" ? CATALOG_REPLAY_VERSIONS_JSON : REPLAY_VERSIONS_JSON;
const REPLAY_CHANGED_MESSAGE =
  "判定ルールまたは対象範囲が更新されています。この処理を中止して、新しい一括再判定を開始してください。";
const jobDto = (row: JobRow): AdminBackgroundJob => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  total: row.total,
  uploaded: row.uploaded,
  processed: row.processed,
  failed: row.failed,
  error: row.error,
  expiresAt: row.expires_at,
  detailsAvailable: !!row.details_available,
  // The job is executed by this Durable Object; `requestedBy` names the operator who asked for it.
  requestedBy: row.requested_by || null,
});
class JobInputError extends Error {}

type ResolutionReplayState = {
  versions_json: string;
  max_product_id: number | null;
  after_id: number;
  scanned_count: number;
  skipped_count: number;
  pending_ids: string;
  scan_complete: number;
};

/** One persisted coordinator serializes admin work separately from every shop's crawl DO. */
export class AdminJobs extends DurableObject<Env> {
  private aliasSnapshot: { version: number; aliases: ManufacturerAliasEvidence[] } | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, total INTEGER NOT NULL,
      uploaded INTEGER NOT NULL DEFAULT 0, uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
      after_index INTEGER NOT NULL DEFAULT -1, pass TEXT NOT NULL DEFAULT 'main',
      rule_version INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL,
      details_available INTEGER NOT NULL DEFAULT 1, stalled_steps INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS jobs_active ON jobs(created_at, id) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at, id) WHERE details_available = 1;
      CREATE TABLE IF NOT EXISTS items(job_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', input_json TEXT, result_json TEXT,
        PRIMARY KEY(job_id, ordinal));
      CREATE INDEX IF NOT EXISTS items_work ON items(job_id, state, ordinal);
      CREATE TABLE IF NOT EXISTS model_replays(job_id TEXT PRIMARY KEY,
        versions_json TEXT NOT NULL, max_product_id INTEGER,
        after_id INTEGER NOT NULL DEFAULT 0, scanned_count INTEGER NOT NULL DEFAULT 0,
        pending_ids TEXT NOT NULL DEFAULT '[]', scan_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS catalog_replay_marks(listing_product_id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL, applied_job_id TEXT NOT NULL);`);
    try {
      ctx.storage.sql.exec(
        "ALTER TABLE model_replays ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // Already present. The historical table also owns catalog replay's bounded listing cursor.
    }
    // Who asked for the work, as distinct from this Durable Object, which performs it. Added to an
    // existing table, so the column may already be there; jobs created before it keep the empty
    // default and read back as an unrecorded subject rather than being attributed to anyone.
    try {
      ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN requested_by TEXT NOT NULL DEFAULT ''");
    } catch {
      // Already present.
    }
  }

  private job(id: string): JobRow {
    const row = this.ctx.storage.sql
      .exec<JobRow>("SELECT * FROM jobs WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new JobInputError("処理が見つかりません。");
    return row;
  }

  // Keep the persisted table/kind names so deployed model-only jobs remain readable.
  private replayState(id: string): ResolutionReplayState {
    const row = this.ctx.storage.sql
      .exec<ResolutionReplayState>("SELECT * FROM model_replays WHERE job_id=?", id)
      .toArray()[0];
    if (!row) throw new Error("model_replay_state_missing");
    return row;
  }

  private dto(row: JobRow): AdminBackgroundJob {
    const state = listingReplay(row.kind) ? this.replayState(row.id) : null;
    const versions = state
      ? (JSON.parse(state.versions_json) as { scope?: string; category: number })
      : null;
    return {
      ...jobDto(row),
      ...(state && row.kind === "catalog"
        ? { catalogReplay: { scanned: state.scanned_count, skipped: state.skipped_count } }
        : state
          ? {
              modelReplay: {
                version: row.rule_version,
                ...(versions?.scope === REPLAY_SCOPE ? { categoryVersion: versions.category } : {}),
                scanned: state.scanned_count,
              },
            }
          : {}),
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const raw = await readJsonBody(request, ADMIN_CSV_MAX_REQUEST_BYTES);
    if (raw === REQUEST_BODY_TOO_LARGE)
      return Response.json({ error: "送信データが大きすぎます。" }, { status: 413 });
    // The envelope keeps the operator's identity out of the command itself, so a request body
    // cannot supply one: `parseAdminJobCommand` never sees the actor field, and `trustedActor`
    // discards anything that is not an identity this system issued.
    const envelope = isRecord(raw) && "command" in raw ? raw : { command: raw, actor: undefined };
    const command = parseAdminJobCommand(envelope.command);
    if (!command)
      return Response.json({ error: "処理の入力を確認してください。" }, { status: 400 });
    const actor = trustedActor(envelope.actor);
    try {
      return Response.json(await this.command(command, actor));
    } catch (error) {
      if (error instanceof JobInputError)
        return Response.json({ error: error.message }, { status: 409 });
      console.error(
        JSON.stringify({
          event: "admin_job_request_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json(
        { error: "処理の状態を保存できませんでした。同じ操作を再試行してください。" },
        { status: 503 },
      );
    }
  }

  private async command(
    command: AdminJobCommand,
    actor: string,
  ): Promise<AdminJobList | AdminJobDetail | { job: AdminBackgroundJob }> {
    const sql = this.ctx.storage.sql;
    if (command.action === "list") {
      const [at, id] = command.before?.split("~") ?? [];
      const rows = (
        at && id
          ? sql.exec<JobRow>(
              "SELECT * FROM jobs WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 26",
              at,
              id,
            )
          : sql.exec<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT 26")
      ).toArray();
      const page = rows.slice(0, 25);
      return {
        items: page.map((row) => this.dto(row)),
        nextBefore: rows.length > 25 ? `${page.at(-1)!.created_at}~${page.at(-1)!.id}` : null,
        modelResolverVersion: RESOLUTION_VERSIONS.model,
        categoryClassifierVersion: RESOLUTION_VERSIONS.category,
      };
    }
    if (command.action === "create") {
      const existing = sql.exec<JobRow>("SELECT * FROM jobs WHERE id = ?", command.id).toArray()[0];
      if (existing) {
        if (
          existing.kind !== command.kind ||
          existing.total !== command.total ||
          existing.label !== command.label
        )
          throw new JobInputError("同じ処理IDに異なる入力が指定されています。");
        return { job: this.dto(existing) };
      }
      if (command.kind === "manufacturer") {
        const receipt = await readManufacturerChange(this.env.DB, command.id);
        if (!receipt || receipt.status !== "applied")
          throw new JobInputError("適用済みのメーカー変更だけを再処理できます。");
        const raced = sql.exec<JobRow>("SELECT * FROM jobs WHERE id=?", command.id).toArray()[0];
        if (raced) {
          if (
            raced.kind !== command.kind ||
            raced.total !== command.total ||
            raced.label !== command.label
          )
            throw new JobInputError("同じ処理IDに異なる入力が指定されています。");
          return { job: this.dto(raced) };
        }
      }
      const active = sql
        .exec<JobRow>(
          "SELECT * FROM jobs WHERE status IN ('uploading','queued','running','paused') LIMIT 4",
        )
        .toArray();
      if (command.kind === "replay") {
        const replay = active.find(
          (j) => j.kind === "replay" && j.rule_version === OFFER_FACT_RULE_VERSION,
        );
        if (replay) return { job: this.dto(replay) };
      }
      if (listingReplay(command.kind)) {
        const replay = sql
          .exec<JobRow>(
            `SELECT j.* FROM jobs j JOIN model_replays r ON r.job_id=j.id
          WHERE j.status IN ('uploading','queued','running','paused','failed') AND j.details_available=1
            AND j.kind=? AND r.versions_json=? ORDER BY j.created_at,j.id LIMIT 1`,
            command.kind,
            replayVersions(command.kind),
          )
          .toArray()[0];
        if (replay) return { job: this.dto(replay) };
      }
      if (active.length >= 3)
        throw new JobInputError(
          "同時に保持できる未完了の処理は3件です。処理を完了または中止してください。",
        );
      const now = new Date().toISOString();
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "INSERT INTO jobs(id,kind,label,status,created_at,updated_at,total,rule_version,expires_at,requested_by) VALUES (?,?,?,'uploading',?,?,?,?,?,?)",
          command.id,
          command.kind,
          command.label,
          now,
          now,
          command.total,
          listingReplay(command.kind) ? RESOLUTION_VERSIONS.model : OFFER_FACT_RULE_VERSION,
          new Date(Date.now() + RETENTION_MS).toISOString(),
          actor,
        );
        if (listingReplay(command.kind))
          sql.exec(
            "INSERT INTO model_replays(job_id,versions_json) VALUES (?,?)",
            command.id,
            replayVersions(command.kind),
          );
      });
      await this.schedule();
      return { job: this.dto(this.job(command.id)) };
    }
    const job = this.job(command.id);
    if (command.action === "get") {
      const rows = sql
        .exec<ItemRow>(
          `SELECT ordinal,state,result_json FROM items WHERE job_id = ? ${command.failedOnly ? "AND state='failed'" : ""} AND ordinal > ? ORDER BY ordinal LIMIT 51`,
          job.id,
          command.after ?? -1,
        )
        .toArray();
      const page = rows.slice(0, 50);
      return {
        job: this.dto(job),
        items: page.map((row) => ({
          ordinal: row.ordinal,
          state: row.state,
          result: row.result_json ? (JSON.parse(row.result_json) as AdminCsvResult) : null,
        })),
        nextAfter: rows.length > 50 ? page.at(-1)!.ordinal : null,
      };
    }
    if (command.action === "append") {
      if (job.kind !== "csv" || job.status !== "uploading" || !job.details_available)
        throw new JobInputError("この処理には追加送信できません。");
      const values = command.items.map((item) => JSON.stringify(item));
      if (command.offset < job.uploaded) {
        const saved = sql
          .exec<ItemRow>(
            "SELECT input_json FROM items WHERE job_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?",
            job.id,
            command.offset,
            values.length,
          )
          .toArray();
        if (saved.length !== values.length || saved.some((r, i) => r.input_json !== values[i]))
          throw new JobInputError("再送信された内容が元の入力と一致しません。");
      } else {
        const bytes = values.reduce(
          (sum, value) => sum + new TextEncoder().encode(value).byteLength,
          0,
        );
        if (
          command.offset !== job.uploaded ||
          job.uploaded + values.length > job.total ||
          job.uploaded_bytes + bytes > MAX_UPLOAD_BYTES
        )
          throw new JobInputError("送信位置・件数または128MiBの処理データ上限を確認してください。");
        this.ctx.storage.transactionSync(() => {
          values.forEach((value, index) =>
            sql.exec(
              "INSERT INTO items(job_id,ordinal,input_json) VALUES (?,?,?)",
              job.id,
              command.offset + index,
              value,
            ),
          );
          sql.exec(
            "UPDATE jobs SET uploaded = uploaded + ?, uploaded_bytes = uploaded_bytes + ?, updated_at = ? WHERE id = ?",
            values.length,
            bytes,
            new Date().toISOString(),
            job.id,
          );
        });
      }
    } else if (command.action === "start") {
      if (job.status === "uploading") {
        if (job.uploaded !== job.total || !job.details_available)
          throw new JobInputError("対象データの送信完了後に開始できます。");
        sql.exec(
          "UPDATE jobs SET status='queued',updated_at=? WHERE id=?",
          new Date().toISOString(),
          job.id,
        );
      }
    } else if (command.action === "pause") {
      sql.exec(
        "UPDATE jobs SET status='paused',updated_at=? WHERE id=? AND status IN ('queued','running')",
        new Date().toISOString(),
        job.id,
      );
    } else if (command.action === "resume") {
      if (
        listingReplay(job.kind) &&
        this.replayState(job.id).versions_json !== replayVersions(job.kind)
      )
        throw new JobInputError(REPLAY_CHANGED_MESSAGE);
      if (!job.details_available)
        throw new JobInputError(
          "詳細データの保持期限が切れています。新しい処理を作成してください。",
        );
      sql.exec(
        "UPDATE jobs SET status='queued',error='',stalled_steps=0,updated_at=? WHERE id=? AND status IN ('paused','failed','running')",
        new Date().toISOString(),
        job.id,
      );
    } else if (command.action === "retry") {
      if (
        !job.details_available ||
        job.kind !== "csv" ||
        job.processed !== job.total ||
        !job.failed ||
        !["completed", "failed"].includes(job.status)
      )
        throw new JobInputError("全対象の処理後に、失敗した対象だけを再試行できます。");
      sql.exec(
        "UPDATE jobs SET status='queued',pass='retry',after_index=-1,error='',updated_at=? WHERE id=?",
        new Date().toISOString(),
        job.id,
      );
    } else if (command.action === "cancel") {
      sql.exec(
        "UPDATE jobs SET status='cancelled',expires_at=?,updated_at=? WHERE id=? AND status <> 'completed'",
        new Date().toISOString(),
        new Date().toISOString(),
        job.id,
      );
    }
    await this.schedule();
    return { job: this.dto(this.job(job.id)) };
  }

  private async schedule() {
    const runnable = this.ctx.storage.sql
      .exec(
        "SELECT id FROM jobs WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT 1",
      )
      .toArray()[0];
    if (runnable) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }
    const expiry = this.ctx.storage.sql
      .exec<{ expires_at: string }>(
        "SELECT expires_at FROM jobs WHERE details_available=1 ORDER BY expires_at,id LIMIT 1",
      )
      .toArray()[0];
    if (expiry)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Date.parse(expiry.expires_at)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    await this.cleanup();
    const job = sql
      .exec<JobRow>(
        "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT 1",
      )
      .toArray()[0];
    if (!job) {
      await this.schedule();
      return;
    }
    // A hard kill has a durable wake-up; receipts fence a repeated item after lost responses.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    sql.exec(
      "UPDATE jobs SET status='running',updated_at=? WHERE id=? AND status='queued'",
      new Date().toISOString(),
      job.id,
    );
    try {
      if (job.kind === "manufacturer") await this.manufacturer(job);
      else if (listingReplay(job.kind)) await this.resolutionReplay(job);
      else if (job.kind === "replay") await this.replay(job);
      else
        for (let step = 0; step < 5; step++) {
          const current = this.job(job.id);
          if (current.status !== "running") break;
          const row = sql
            .exec<ItemRow>(
              "SELECT ordinal,state,input_json,result_json FROM items WHERE job_id=? AND state=? AND ordinal>? ORDER BY ordinal LIMIT 1",
              job.id,
              current.pass === "retry" ? "failed" : "pending",
              current.after_index,
            )
            .toArray()[0];
          if (!row) {
            sql.exec(
              "UPDATE jobs SET status=CASE WHEN failed>0 THEN 'failed' ELSE 'completed' END,updated_at=?,expires_at=? WHERE id=? AND status='running'",
              new Date().toISOString(),
              new Date(Date.now() + RETENTION_MS).toISOString(),
              job.id,
            );
            break;
          }
          if (!row.input_json) throw new Error("admin_job_input_missing");
          const input = JSON.parse(row.input_json) as AdminCsvApplyInput;
          // This Durable Object performs the work; the change is attributed to the operator who
          // asked for the job. The subject is carried on the job row, never re-read from the item
          // payload, so a crafted upload cannot name itself as the actor.
          const result = await applyAdminCsvChange(this.env.DB, input, job.requested_by);
          const nextInput = {
            ...input,
            operationId: result.operationId || input.operationId,
            revision: result.revision || input.revision,
          };
          if (result.status === "pending") {
            sql.exec(
              "UPDATE items SET input_json=?,result_json=? WHERE job_id=? AND ordinal=?",
              JSON.stringify(nextInput),
              JSON.stringify(result),
              job.id,
              row.ordinal,
            );
            continue;
          }
          const success = result.status === "applied" || result.status === "unchanged";
          this.ctx.storage.transactionSync(() => {
            sql.exec(
              "UPDATE items SET state=?,input_json=?,result_json=? WHERE job_id=? AND ordinal=?",
              success ? "applied" : "failed",
              success ? null : JSON.stringify(nextInput),
              JSON.stringify(result),
              job.id,
              row.ordinal,
            );
            sql.exec(
              "UPDATE jobs SET after_index=?,processed=processed+?,failed=failed+?,updated_at=? WHERE id=?",
              row.ordinal,
              row.state === "pending" ? 1 : 0,
              row.state === "pending" ? (success ? 0 : 1) : success ? -1 : 0,
              new Date().toISOString(),
              job.id,
            );
          });
          // A quota/transport failure stops this job immediately instead of failing every remaining row.
          if (result.status === "failed") {
            sql.exec(
              "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'",
              result.message,
              new Date().toISOString(),
              job.id,
            );
            break;
          }
        }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "admin_job_step_failed",
          jobId: job.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      if (
        listingReplay(job.kind) &&
        (error instanceof ListingReplaySourceChangedError ||
          error instanceof CatalogReplayChangedError) &&
        this.job(job.id).stalled_steps < 2
      ) {
        sql.exec(
          "UPDATE jobs SET status='queued',stalled_steps=stalled_steps+1,updated_at=? WHERE id=? AND status='running'",
          new Date().toISOString(),
          job.id,
        );
      } else
        sql.exec(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'",
          error instanceof Error && error.message === "offer_fact_replay_no_progress"
            ? "進捗が更新されないため停止しました。状態を確認してから再開してください。"
            : error instanceof ListingReplaySourceChangedError ||
                error instanceof CatalogReplayChangedError
              ? "商品情報またはカタログの更新との競合が続くため停止しました。時間をおいて続きから再開してください。"
              : error instanceof Error && error.message === "offer_fact_rule_version_changed"
                ? "抽出ルールが更新されています。この処理を中止して、新しい再処理を開始してください。"
                : error instanceof Error && error.message === "resolution_replay_version_changed"
                  ? REPLAY_CHANGED_MESSAGE
                  : "処理が中断しました。保存済みの続きから再開できます。",
          new Date().toISOString(),
          job.id,
        );
    }
    await this.schedule();
  }

  private async manufacturer(job: JobRow) {
    const receipt = await readManufacturerChange(this.env.DB, job.id);
    if (!receipt || receipt.status !== "applied") throw new Error("manufacturer_change_missing");
    const matcher = JSON.parse(receipt.matcher_json) as ManufacturerMatcher;
    const page = await scanManufacturerImpact(
      this.env.DB,
      matcher,
      Math.max(0, job.after_index),
      receipt.max_product_id,
      5,
    );
    if (page.ids.length) {
      const version = await registryVersion(this.env.DB);
      if (!this.aliasSnapshot || this.aliasSnapshot.version !== version)
        this.aliasSnapshot = { version, aliases: await readAdminManufacturerAliases(this.env.DB) };
      await replayAdminCsvListings(
        this.env.DB,
        page.ids,
        new Date().toISOString(),
        this.aliasSnapshot.aliases,
      );
    }
    // Reprocessing is idempotent and preserves newer manual overrides; a lost checkpoint only repeats this bounded page.
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET after_index=?,processed=processed+?,updated_at=? WHERE id=?",
      page.nextAfterId,
      page.scanned,
      new Date().toISOString(),
      job.id,
    );
    if (!page.hasMore)
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status='completed',error='',expires_at=? WHERE id=? AND status='running'",
        new Date(Date.now() + RETENTION_MS).toISOString(),
        job.id,
      );
  }

  private async replay(job: JobRow) {
    if (job.rule_version !== OFFER_FACT_RULE_VERSION)
      throw new Error("offer_fact_rule_version_changed");
    const progress = await stepOfferFactReplay(this.env.DB);
    if (!progress) throw new Error("offer_fact_replay_state_missing");
    const stalled = progress.scannedCount > job.processed ? 0 : job.stalled_steps + 1;
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET processed=?,stalled_steps=?,updated_at=? WHERE id=?",
      progress.scannedCount,
      stalled,
      new Date().toISOString(),
      job.id,
    );
    if (progress.completedAt)
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status='completed',error='',expires_at=? WHERE id=? AND status='running'",
        new Date(Date.now() + RETENTION_MS).toISOString(),
        job.id,
      );
    else if (stalled >= 3) throw new Error("offer_fact_replay_no_progress");
  }

  private async resolutionReplay(job: JobRow) {
    const sql = this.ctx.storage.sql;
    let state = this.replayState(job.id);
    if (state.versions_json !== replayVersions(job.kind))
      throw new Error("resolution_replay_version_changed");
    if (state.max_product_id === null) {
      const last = await this.env.DB.prepare(
        "SELECT id FROM products ORDER BY id DESC LIMIT 1",
      ).first<{ id: number }>();
      sql.exec("UPDATE model_replays SET max_product_id=? WHERE job_id=?", last?.id ?? 0, job.id);
      state = this.replayState(job.id);
    }
    let pending = JSON.parse(state.pending_ids) as number[];
    if (!pending.length && !state.scan_complete) {
      const previousAfterId = state.after_id;
      const scan = job.kind === "catalog" ? scanAdminCatalogReplay : scanAdminResolutionReplay;
      const page = await scan(this.env.DB, state.after_id, state.max_product_id!);
      // Persist the bounded candidate window before any D1 mutation. A lost response retries the
      // same candidate; already-current rows are skipped by the primary-key eligibility check.
      sql.exec(
        `UPDATE model_replays SET after_id=?,scanned_count=scanned_count+?,pending_ids=?,scan_complete=? WHERE job_id=?`,
        page.afterId,
        page.scanned,
        JSON.stringify(page.ids),
        Number(page.complete),
        job.id,
      );
      state = this.replayState(job.id);
      pending = page.ids;
      if (job.kind === "catalog") {
        // Reap receipts for deleted listings using the ID window already read, without querying
        // D1 again. A large deletion gap is cleaned in bounded chunks across subsequent runs.
        // The terminal window also covers receipts above the surviving product maximum, including
        // an empty catalog. Keeping the listing scan bound separate preserves its start snapshot.
        const cleanupUpperId = page.complete
          ? Math.max(
              state.max_product_id!,
              sql
                .exec<{ id: number }>(
                  "SELECT COALESCE(MAX(listing_product_id),0) AS id FROM catalog_replay_marks",
                )
                .toArray()[0].id,
            )
          : page.afterId;
        sql.exec(
          `DELETE FROM catalog_replay_marks WHERE listing_product_id IN (
          SELECT listing_product_id FROM catalog_replay_marks WHERE listing_product_id<=?
          AND listing_product_id>? AND listing_product_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1000)`,
          cleanupUpperId,
          previousAfterId,
          JSON.stringify(page.ids),
        );
      }
    }
    if (this.job(job.id).status !== "running") return;
    const id = pending[0];
    if (id !== undefined) {
      let skipped = false;
      if (job.kind === "catalog") {
        const result = await this.catalogListing(job, id);
        if (result === null) return;
        skipped = result;
      } else if (await needsAdminResolutionReplay(this.env.DB, id)) {
        const aliases = await this.manufacturerAliases();
        if (this.job(job.id).status !== "running") return;
        await replayAdminCsvListings(this.env.DB, [id], new Date().toISOString(), aliases);
      }
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE model_replays SET pending_ids=?,skipped_count=skipped_count+? WHERE job_id=?",
          JSON.stringify(pending.slice(1)),
          Number(skipped),
          job.id,
        );
        sql.exec(
          "UPDATE jobs SET processed=processed+?,stalled_steps=0,updated_at=? WHERE id=?",
          Number(!skipped),
          new Date().toISOString(),
          job.id,
        );
      });
      pending = pending.slice(1);
    } else {
      sql.exec("UPDATE jobs SET updated_at=? WHERE id=?", new Date().toISOString(), job.id);
    }
    if (state.scan_complete && !pending.length)
      sql.exec(
        "UPDATE jobs SET status='completed',error='',expires_at=? WHERE id=? AND status='running'",
        new Date(Date.now() + RETENTION_MS).toISOString(),
        job.id,
      );
  }

  private async manufacturerAliases() {
    const version = await registryVersion(this.env.DB);
    if (!this.aliasSnapshot || this.aliasSnapshot.version !== version)
      this.aliasSnapshot = { version, aliases: await readAdminManufacturerAliases(this.env.DB) };
    return this.aliasSnapshot.aliases;
  }

  /** A successful receipt is saved before the job cursor. A lost cursor checkpoint retries the
   * same ID, observes the receipt, and neither repeats its D1 writes nor counts it twice. */
  private async catalogListing(job: JobRow, id: number): Promise<boolean | null> {
    const sql = this.ctx.storage.sql;
    const measured = accountReads(this.env.DB);
    const before = await readCatalogReplaySnapshot(measured.db, id);
    if (this.job(job.id).status !== "running") return null;
    if (!before) {
      sql.exec("DELETE FROM catalog_replay_marks WHERE listing_product_id=?", id);
      return true;
    }
    const mark = sql
      .exec<{ fingerprint: string; applied_job_id: string }>(
        "SELECT fingerprint,applied_job_id FROM catalog_replay_marks WHERE listing_product_id=?",
        id,
      )
      .toArray()[0];
    const unchanged =
      !before.listing.remediation_projection_required && mark?.fingerprint === before.fingerprint;
    console.log(
      JSON.stringify({
        event: "admin_catalog_replay_check",
        listingId: id,
        unchanged,
        ...dbUsageMetrics(measured),
      }),
    );
    if (unchanged) return mark.applied_job_id !== job.id;
    const aliases = await this.manufacturerAliases();
    if (this.job(job.id).status !== "running") return null;
    const after = await applyCatalogReplay(this.env.DB, before, aliases);
    sql.exec(
      `INSERT INTO catalog_replay_marks(listing_product_id,fingerprint,applied_job_id)
      VALUES (?,?,?) ON CONFLICT(listing_product_id) DO UPDATE SET
      fingerprint=excluded.fingerprint,applied_job_id=excluded.applied_job_id`,
      id,
      after.fingerprint,
      job.id,
    );
    return false;
  }

  private async cleanup() {
    const sql = this.ctx.storage.sql;
    const job = sql
      .exec<JobRow>(
        "SELECT * FROM jobs WHERE details_available=1 AND status NOT IN ('queued','running') AND expires_at<=? ORDER BY expires_at,id LIMIT 1",
        new Date().toISOString(),
      )
      .toArray()[0];
    if (!job) return;
    // Bounded expiry cleanup; retain the small job summary and the canonical D1 edit receipts.
    sql.exec(
      "DELETE FROM items WHERE job_id=? AND ordinal IN (SELECT ordinal FROM items WHERE job_id=? ORDER BY ordinal LIMIT 1000)",
      job.id,
      job.id,
    );
    if (!sql.exec("SELECT ordinal FROM items WHERE job_id=? LIMIT 1", job.id).toArray().length)
      sql.exec(
        "UPDATE jobs SET details_available=0,error=CASE WHEN status IN ('uploading','paused') THEN '詳細データの保持期限が切れました。' ELSE error END,status=CASE WHEN status IN ('uploading','paused') THEN 'cancelled' ELSE status END WHERE id=?",
        job.id,
      );
  }
}
