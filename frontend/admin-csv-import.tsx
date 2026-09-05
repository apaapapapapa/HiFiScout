import { useEffect, useRef, useState } from "react";
import {
  ADMIN_CSV_FIELDS,
  ADMIN_CSV_MAX_FILE_BYTES,
  ADMIN_CSV_PREVIEW_LIMIT,
  adminCsvCell,
  type AdminCsvChange,
  type AdminCsvResult,
} from "../src/api/admin-csv-contracts.js";
import { readAdminCsv } from "./admin-csv-parser.js";
import { adminJson, type CategoryFacet } from "./admin-shared.js";

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

function resultCsv(changes: readonly AdminCsvChange[], results: readonly AdminCsvResult[]): string {
  const fields = [...new Set([...ADMIN_CSV_FIELDS.listing, ...ADMIN_CSV_FIELDS.catalog])];
  const rows = [
    [
      "listing_id",
      "catalog_product_id",
      "csv_original",
      ...fields.map((field) => "edit_" + field),
      "result",
      "message",
    ],
  ];
  changes.forEach((change, index) =>
    rows.push([
      change.original.kind === "listing" ? String(change.original.id) : "",
      change.original.kind === "catalog" ? String(change.original.id) : "",
      JSON.stringify(change.original),
      ...fields.map((field) => change.values[field] ?? ""),
      results[index]?.status || "unprocessed",
      results[index]?.message || "未処理",
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
  const active = useRef<AbortController | null>(null);
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
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
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
      for (let offset = 0; offset < parsed.changes.length; offset += ADMIN_CSV_PREVIEW_LIMIT) {
        setMessage("変更行を検証中: " + offset + " / " + parsed.changes.length + "件");
        const response = await adminJson<{ items: AdminCsvResult[] }>(
          "/api/admin/csv-import/preview",
          {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({
              changes: parsed.changes.slice(offset, offset + ADMIN_CSV_PREVIEW_LIMIT),
            }),
          },
        );
        if (!mounted.current || controller.signal.aborted) return;
        checked.push(...response.items);
        setResults([...checked]);
      }
      setMessage(
        parsed.totalRows +
          "行中、編集された" +
          parsed.changes.length +
          "行を検証しました。変更のない" +
          parsed.unchangedRows +
          "行は更新しません。",
      );
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "CSVを検証できませんでした。");
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function apply() {
    if (busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    const progress = [...results];
    try {
      for (let index = 0; index < changes.length; index += 1) {
        let row = progress[index];
        if (!row || (row.status !== "ready" && row.status !== "pending")) continue;
        let operationId = row.operationId || crypto.randomUUID();
        let revision = row.revision || "";
        setPage(Math.floor(index / PAGE_SIZE));
        do {
          setMessage(index + 1 + " / " + changes.length + "件目を更新・反映しています。");
          row = await adminJson<AdminCsvResult>("/api/admin/csv-import/apply", {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({ change: changes[index], revision, operationId }),
          });
          if (!mounted.current || controller.signal.aborted) return;
          // A concurrent upload may already have committed this exact edit.
          operationId = row.operationId || operationId;
          revision = row.revision || revision;
          progress[index] = { ...row, operationId, revision };
          setResults([...progress]);
        } while (row.status === "pending");
        if (row.status !== "applied" && row.status !== "unchanged") {
          throw new Error(
            "更新を中断しました。結果を確認し、差分を再確認してから再試行してください。",
          );
        }
      }
      setMessage(
        "更新が完了しました。適用済み " +
          progress.filter((row) => row.status === "applied").length +
          "件、変更なし " +
          progress.filter((row) => row.status === "unchanged").length +
          "件。",
      );
      onApplied?.();
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        setError(
          (failure instanceof Error ? failure.message : "更新できませんでした。") +
            " 同じCSVを再確認すると、適用済みの行を除き、未完了の反映を再開できます。",
        );
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
  const validated = changes.length > 0 && results.length === changes.length && !error;
  const pageCount = Math.max(1, Math.ceil(changes.length / PAGE_SIZE));
  return (
    <section className="csv-import-panel" aria-labelledby="csv-import-heading">
      <h3 id="csv-import-heading">編集したCSVで一括更新</h3>
      <p>
        上のCSVを生成し、<code>edit_</code>で始まる列を編集して、UTF-8のCSVとして保存してください。
        元データ列・ID・<code>csv_original</code>はそのまま残します。
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
      <div className="csv-import-actions">
        <label htmlFor="admin-csv-file">編集済みCSV（100MiB以内）</label>
        <input
          id="admin-csv-file"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] || null);
            setChanges([]);
            setResults([]);
            setMessage("");
            setError("");
            setPage(0);
          }}
        />
        <button type="button" onClick={() => void preview()} disabled={!file || busy}>
          差分を確認
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void apply()}
          disabled={busy || !validated || blocked || ready === 0}
        >
          {ready}件の更新を実行
        </button>
        {changes.length > 0 && (
          <button type="button" onClick={downloadResults}>
            結果CSVをダウンロード
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {error && (
        <p role="alert" className="csv-import-error">
          {error}
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
                        {change.original.kind === "catalog" ? "カタログ" : "登録商品"} #
                        {change.original.id}
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
                        {row ? STATUS_LABELS[row.status] : "未検証"}
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
        更新中は画面を開いたままにしてください。通信が切れた場合は同じCSVを再度読み込み、
        「差分を確認」から再開できます。削除や価格・在庫の更新は行いません。
      </p>
    </section>
  );
}
