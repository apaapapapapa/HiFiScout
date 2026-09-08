import { useEffect, useRef, useState } from "react";
import {
  ADMIN_CSV_FIELDS,
  ADMIN_CSV_MAX_FILE_BYTES,
  adminCsvCell,
  adminCsvPreviewBatches,
  adminCsvPreviewResults,
  type AdminCsvChange,
  type AdminCsvResult,
} from "../src/api/admin-csv-contracts.js";
import { readAdminCsv } from "./admin-csv-parser.js";
import { AdminOperationError, genericErrorText, type CategoryFacet } from "./admin-shared.js";
import { adminCsvRequest } from "./admin-csv-request.js";
import { submitAdminCsvJob } from "./admin-job-client.js";

const FIELD_LABELS: Record<string, string> = {
  manufacturer_id: "メーカーID",
  model: "型番",
  canonical_model: "正式型番",
  canonical_name: "正式名称",
  primary_category_id: "カテゴリID",
  lifecycle_status: "製品状態",
};
const STATUS_LABELS: Record<AdminCsvResult["status"], string> = {
  ready: "更新可能",
  unchanged: "変更なし",
  conflict: "競合",
  invalid: "入力エラー",
  pending: "反映中",
  applied: "適用済み",
  failed: "失敗",
};
const PAGE_SIZE = 20;

export function resultCsv(
  changes: readonly AdminCsvChange[],
  results: readonly AdminCsvResult[],
): string {
  const fields = [...new Set([...ADMIN_CSV_FIELDS.listing, ...ADMIN_CSV_FIELDS.catalog])];
  const rows = [
    [
      "listing_id",
      "catalog_product_id",
      "csv_original",
      ...fields.map((field) => "edit_" + field),
      "result",
      "message",
      "result_target_id",
    ],
  ];
  changes.forEach((change, index) =>
    rows.push([
      change.original.kind === "listing" ? String(change.original.id) : "",
      change.original.kind === "catalog" && change.original.id !== null
        ? String(change.original.id)
        : "",
      JSON.stringify(change.original),
      ...fields.map((field) => change.values[field] ?? ""),
      results[index]?.status || "unprocessed",
      results[index]?.message || "未処理",
      String(results[index]?.id ?? ""),
    ]),
  );
  return "\uFEFF" + rows.map((row) => row.map(adminCsvCell).join(",")).join("\r\n") + "\r\n";
}

export function AdminCsvImport({
  categories,
  onApplied,
}: {
  categories: CategoryFacet[];
  onApplied?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [changes, setChanges] = useState<AdminCsvChange[]>([]);
  const [results, setResults] = useState<AdminCsvResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [validated, setValidated] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [paused, setPaused] = useState(false);
  const active = useRef<AbortController | null>(null);
  const uploadId = useRef<string | null>(null);
  const [submittedJob, setSubmittedJob] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  async function preview() {
    if (!file || busy) return;
    uploadId.current = null;
    setSubmittedJob(null);
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setNeedsLogin(false);
    setPaused(false);
    setValidated(false);
    setResults([]);
    setChanges([]);
    setPage(0);
    try {
      if (file.size > ADMIN_CSV_MAX_FILE_BYTES)
        throw new Error("CSVは100MiB以内でアップロードしてください。");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error("UTF-8形式のCSVで保存してください。");
      }
      const parsed = readAdminCsv(text);
      if (!mounted.current || controller.signal.aborted) return;
      setChanges(parsed.changes);
      if (!parsed.changes.length) {
        setMessage(parsed.totalRows + "行を確認しました。編集による変更はありません。");
        return;
      }
      const checked: AdminCsvResult[] = [];
      for (const batch of adminCsvPreviewBatches(parsed.changes)) {
        setMessage("変更行を検証中: " + checked.length + " / " + parsed.changes.length + "件");
        const response = await adminCsvRequest<{ items: AdminCsvResult[] }>(
          "preview",
          {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({
              changes: batch,
            }),
          },
          () => setMessage("接続を再試行しています。検証の進捗は保持されています。"),
        );
        if (!mounted.current || controller.signal.aborted) return;
        checked.push(...response.items);
        setResults([...checked]);
      }
      setMessage(
        parsed.totalRows +
          "行中、追加・修正された" +
          parsed.changes.length +
          "行を検証しました。変更のない" +
          parsed.unchangedRows +
          "行は更新しません。",
      );
      setResults(adminCsvPreviewResults(parsed.changes, checked));
      setValidated(true);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        setNeedsLogin(failure instanceof AdminOperationError && failure.requiresAuthentication);
        setError(genericErrorText(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function apply() {
    if (busy || submittedJob) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setNeedsLogin(false);
    setPaused(false);
    const progress = results.map((row) =>
      row.status === "ready" || row.status === "pending"
        ? { ...row, operationId: row.operationId || crypto.randomUUID() }
        : row,
    );
    setResults(progress);
    const inputs = changes.flatMap((change, index) => {
      const row = progress[index];
      return row &&
        (row.status === "ready" || row.status === "pending") &&
        row.revision &&
        row.operationId
        ? [{ change, revision: row.revision, operationId: row.operationId }]
        : [];
    });
    uploadId.current ||= crypto.randomUUID();
    try {
      setMessage("処理を準備しています。送信が完了するまで画面を開いたままにしてください。");
      const job = await submitAdminCsvJob(
        uploadId.current,
        file?.name || "CSV取込",
        inputs,
        controller.signal,
        (uploaded) => {
          if (mounted.current) setMessage(`処理データを送信中: ${uploaded} / ${inputs.length}件`);
        },
      );
      if (!mounted.current) return;
      setSubmittedJob(job.id);
      setMessage(
        job.status === "queued" || job.status === "running"
          ? "処理を受け付けました。画面を閉じても処理は続きます。進捗と結果は処理一覧で確認してください。"
          : "この処理の記録があります。現在の状態と結果は処理一覧で確認してください。",
      );
      onApplied?.();
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        setPaused(true);
        setNeedsLogin(failure instanceof AdminOperationError && failure.requiresAuthentication);
        setMessage("送信を中断しました。同じ処理IDと送信済みの位置で再開できます。");
        setError(genericErrorText(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function downloadResults() {
    const url = URL.createObjectURL(
      new Blob([resultCsv(changes, results)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "hifiscout-csv-import-results.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const blocked = results.some((row) => ["invalid", "conflict", "failed"].includes(row.status));
  const ready = results.filter((row) => row.status === "ready" || row.status === "pending").length;
  const additions = changes.filter((change) => change.original.id === null).length;
  const action = additions ? "登録・更新" : "更新";
  const pageCount = Math.max(1, Math.ceil(changes.length / PAGE_SIZE));
  return (
    <section className="csv-import-panel" aria-labelledby="csv-import-heading">
      <h3 id="csv-import-heading">編集したCSVで一括登録・更新</h3>
      <p>
        上の「編集用CSV」を生成し、<code>edit_</code>
        で始まる列を編集して、UTF-8のCSVとして保存してください。既存行の元データ列・ID・
        <code>csv_original</code>はそのまま残します。
      </p>
      <details className="csv-edit-guide">
        <summary>CSVの入力ルール・新規追加の方法</summary>
        <p>
          カタログを追加する場合は行を追加し、<code>catalog_product_id</code>と
          <code>csv_original</code>を空欄にして、5つの<code>edit_</code>列を入力してください。
          追加行の他の列は空欄で構いません。同じCSVに既存行の修正と新規追加を含められます。
          登録済みのメーカーIDを使い、製品状態が不明な場合は<code>unknown</code>を指定します。
        </p>
        <p>
          メーカー・型番・カテゴリを修正できます。カタログは正式名称・製品状態も編集できます。
          カテゴリは下のID一覧、製品状態は <code>unknown</code> / <code>active</code> /{" "}
          <code>discontinued</code> を使います。
          登録商品のメーカー・型番を空欄にすると未確定へ戻します。カテゴリとカタログの必須項目は空欄にできません。
        </p>
        <details>
          <summary>カテゴリID一覧</summary>
          <ul className="csv-category-reference">
            {categories
              .filter((category) => category.classifiable)
              .map((category) => (
                <li key={category.id}>
                  <code>{category.id}</code> {category.name.trim()}
                </li>
              ))}
          </ul>
        </details>
      </details>
      <ol className="csv-steps" aria-label="CSV更新の手順">
        <li aria-current={!file ? "step" : undefined}>1. ファイルを選択</li>
        <li aria-current={file && !validated ? "step" : undefined}>2. 差分を確認</li>
        <li aria-current={validated ? "step" : undefined}>3. 登録・更新</li>
      </ol>
      <div className="csv-import-actions">
        <label htmlFor="admin-csv-file">編集済みCSV（100MiB以内）</label>
        <input
          id="admin-csv-file"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            uploadId.current = null;
            setSubmittedJob(null);
            setFile(event.currentTarget.files?.[0] || null);
            setChanges([]);
            setResults([]);
            setMessage("");
            setError("");
            setPage(0);
            setValidated(false);
            setNeedsLogin(false);
            setPaused(false);
          }}
        />
        <button type="button" onClick={() => void preview()} disabled={!file || busy}>
          差分を確認
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void apply()}
          disabled={busy || !validated || blocked || ready === 0 || !!submittedJob}
        >
          {paused ? `送信を再開` : `${ready}件の${action}を実行`}
        </button>
        {changes.length > 0 && (
          <button type="button" onClick={downloadResults}>
            確認結果CSVをダウンロード
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {submittedJob ? (
        <p>
          <a href={`/?jobId=${submittedJob}#jobs`}>処理一覧で進捗と結果を確認</a>
        </p>
      ) : null}
      {changes.length > 0 && (
        <p>
          新規追加 {additions}件 / 既存行の修正 {changes.length - additions}件
        </p>
      )}
      {error && (
        <p role="alert" className="csv-import-error">
          {error}
        </p>
      )}
      {needsLogin && (
        <p>
          <a href="/" target="_blank" rel="noopener noreferrer">
            別タブでログインを確認
          </a>{" "}
          ログイン後にこの画面へ戻り、{validated ? "更新を再開" : "差分を確認"}してください。
          この画面を再読み込みする必要はありません。
        </p>
      )}
      {blocked && (
        <p className="csv-import-error">
          入力エラー・競合・失敗があるため更新できません。CSVを修正し、差分を再確認してください。
        </p>
      )}
      {changes.length > 0 && (
        <>
          <div className="csv-import-table-wrap">
            <table className="csv-import-table">
              <thead>
                <tr>
                  <th>CSV行 / 対象ID</th>
                  <th>項目</th>
                  <th>変更前 → 変更後</th>
                  <th>確認結果</th>
                </tr>
              </thead>
              <tbody>
                {changes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((change, offset) => {
                  const row = results[page * PAGE_SIZE + offset];
                  const fields = ADMIN_CSV_FIELDS[change.original.kind].filter(
                    (field) => change.values[field] !== change.original.values[field],
                  );
                  return (
                    <tr key={change.line}>
                      <td>
                        {change.line}行 /{" "}
                        {change.original.kind === "catalog" ? "カタログ" : "登録商品"}{" "}
                        {change.original.id === null ? "新規追加" : "修正"}
                        {(row?.id ?? change.original.id) !== null && (
                          <> #{row?.id ?? change.original.id}</>
                        )}
                      </td>
                      <td>
                        {fields.map((field) => (
                          <div key={field}>{FIELD_LABELS[field]}</div>
                        ))}
                      </td>
                      <td>
                        {fields.map((field) => (
                          <div key={field}>
                            <span>{change.original.values[field] || "（空欄）"}</span>
                            {" → "}
                            <strong>{change.values[field] || "（空欄）"}</strong>
                          </div>
                        ))}
                      </td>
                      <td>
                        {row
                          ? row.status === "ready" && change.original.id === null
                            ? "追加可能"
                            : STATUS_LABELS[row.status]
                          : "未検証"}
                        <br />
                        {row?.message}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="csv-import-actions">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
              前の差分
            </button>
            <span>
              {page + 1} / {pageCount}ページ
            </span>
            <button
              type="button"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              次の差分
            </button>
          </div>
        </>
      )}
      <p>
        送信中は画面を開いたままにしてください。受付完了後は画面を閉じても処理が続きます。
        進捗・停止・再開は処理一覧で確認できます。送信に失敗した場合はこの画面の「送信を再開」を押してください。
      </p>
    </section>
  );
}
