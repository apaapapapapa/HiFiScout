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
import { applyAdminCsvChange } from "../db/admin-csv-import-repository.js";
import { stepOfferFactReplay } from "../db/offer-fact-replay-repository.js";
import { OFFER_FACT_RULE_VERSION } from "../catalog/offer-facts.js";

type JobRow = {
  id: string;
  kind: "csv" | "replay";
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
};
type ItemRow = {
  ordinal: number;
  state: string;
  input_json: string | null;
  result_json: string | null;
};
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
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
});
class JobInputError extends Error {}

/** One persisted coordinator serializes admin work separately from every shop's crawl DO. */
export class AdminJobs extends DurableObject<Env> {
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
      CREATE INDEX IF NOT EXISTS items_work ON items(job_id, state, ordinal);`);
  }

  private job(id: string): JobRow {
    const row = this.ctx.storage.sql
      .exec<JobRow>("SELECT * FROM jobs WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new JobInputError("処理が見つかりません。");
    return row;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const raw = await readJsonBody(request, ADMIN_CSV_MAX_REQUEST_BYTES);
    if (raw === REQUEST_BODY_TOO_LARGE)
      return Response.json({ error: "送信データが大きすぎます。" }, { status: 413 });
    const command = parseAdminJobCommand(raw);
    if (!command)
      return Response.json({ error: "処理の入力を確認してください。" }, { status: 400 });
    try {
      return Response.json(await this.command(command));
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
        items: page.map(jobDto),
        nextBefore: rows.length > 25 ? `${page.at(-1)!.created_at}~${page.at(-1)!.id}` : null,
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
        return { job: jobDto(existing) };
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
        if (replay) return { job: jobDto(replay) };
      }
      if (active.length >= 3)
        throw new JobInputError(
          "同時に保持できる未完了の処理は3件です。処理を完了または中止してください。",
        );
      const now = new Date().toISOString();
      sql.exec(
        "INSERT INTO jobs(id,kind,label,status,created_at,updated_at,total,rule_version,expires_at) VALUES (?,?,?,'uploading',?,?,?,?,?)",
        command.id,
        command.kind,
        command.label,
        now,
        now,
        command.total,
        OFFER_FACT_RULE_VERSION,
        new Date(Date.now() + RETENTION_MS).toISOString(),
      );
      await this.schedule();
      return { job: jobDto(this.job(command.id)) };
    }
    const job = this.job(command.id);
    if (command.action === "get") {
      const rows = sql
        .exec<ItemRow>(
          "SELECT ordinal,state,result_json FROM items WHERE job_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 51",
          job.id,
          command.after ?? -1,
        )
        .toArray();
      const page = rows.slice(0, 50);
      return {
        job: jobDto(job),
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
    return { job: jobDto(this.job(job.id)) };
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
    const job = sql
      .exec<JobRow>(
        "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT 1",
      )
      .toArray()[0];
    if (!job) {
      await this.cleanup();
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
      if (job.kind === "replay") await this.replay(job);
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
          const result = await applyAdminCsvChange(this.env.DB, input);
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
      sql.exec(
        "UPDATE jobs SET status='failed',error='処理が中断しました。保存済みの続きから再開できます。',updated_at=? WHERE id=? AND status='running'",
        new Date().toISOString(),
        job.id,
      );
    }
    await this.schedule();
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

  private async cleanup() {
    const sql = this.ctx.storage.sql;
    const job = sql
      .exec<JobRow>(
        "SELECT * FROM jobs WHERE details_available=1 AND expires_at<=? ORDER BY expires_at,id LIMIT 1",
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
