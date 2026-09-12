import {
  ADMIN_CSV_MAX_REQUEST_BYTES,
  type AdminBackgroundJob,
  type AdminCsvApplyInput,
  type AdminJobCommand,
} from "../src/api/admin-csv-contracts.js";
import { adminJson } from "./admin-shared.js";

export function adminJobRequest<T>(command: AdminJobCommand, signal?: AbortSignal): Promise<T> {
  return adminJson<T>("/api/admin/jobs", { method: "POST", signal, body: JSON.stringify(command) });
}

export async function submitAdminCsvJob(
  id: string,
  label: string,
  inputs: AdminCsvApplyInput[],
  signal: AbortSignal,
  onProgress: (uploaded: number) => void,
): Promise<AdminBackgroundJob> {
  let { job } = await adminJobRequest<{ job: AdminBackgroundJob }>(
    { action: "create", id, kind: "csv", total: inputs.length, label: label.slice(0, 100) },
    signal,
  );
  if (job.status !== "uploading") return job;
  const encoder = new TextEncoder();
  // Use complete apply payloads when bounding bytes; revisions and operation IDs also consume space.
  for (let offset = job.uploaded; offset < inputs.length;) {
    const batch: AdminCsvApplyInput[] = [];
    while (offset + batch.length < inputs.length && batch.length < 20) {
      const candidate = [...batch, inputs[offset + batch.length]];
      const body = { action: "append", id, offset, items: candidate };
      if (encoder.encode(JSON.stringify(body)).byteLength > ADMIN_CSV_MAX_REQUEST_BYTES) break;
      batch.push(inputs[offset + batch.length]);
    }
    if (!batch.length) throw new Error("1行の処理データが送信上限を超えています。");
    ({ job } = await adminJobRequest<{ job: AdminBackgroundJob }>(
      { action: "append", id, offset, items: batch },
      signal,
    ));
    offset += batch.length;
    onProgress(offset);
  }
  ({ job } = await adminJobRequest<{ job: AdminBackgroundJob }>({ action: "start", id }, signal));
  return job;
}

export async function submitAdminReplayJob(
  id: string,
  kind: "replay" | "model" = "replay",
): Promise<AdminBackgroundJob> {
  const { job } = await adminJobRequest<{ job: AdminBackgroundJob }>({
    action: "create",
    id,
    kind,
    total: 0,
    label: kind === "model" ? "旧バージョン商品の型番・カテゴリ再判定" : "全商品の出品条件再処理",
  });
  return (await adminJobRequest<{ job: AdminBackgroundJob }>({ action: "start", id: job.id })).job;
}
