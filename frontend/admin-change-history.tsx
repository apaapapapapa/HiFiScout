import { useEffect, useRef, useState } from "react";
import type {
  AdminChangeHistory,
  AdminChangeHistoryItem,
  AdminRestoreSelection,
} from "../src/api/admin-listing-contracts.js";
import type { AdminCsvChange, AdminCsvResult } from "../src/api/admin-csv-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";

const LABELS: Record<string, string> = {
  manufacturer_id: "メーカー",
  manufacturer: "メーカー",
  model: "型番",
  canonical_model: "型番",
  canonical_name: "表示名",
  primary_category_id: "カテゴリ",
  category: "カテゴリ",
  presentation_color: "色",
  lifecycle_status: "販売状態",
  identity: "カタログ照合",
};
interface Preview {
  status: string;
  message: string;
  change?: AdminCsvChange;
  revision?: string;
  before?: string;
  after?: string;
}

export function AdminChangeHistoryPanel({
  kind,
  targetId,
  onClose,
  onChanged,
}: {
  kind: "listing" | "catalog";
  targetId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<AdminChangeHistory | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<AdminRestoreSelection | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const operation = useRef("");
  useEffect(() => {
    let cancelled = false;
    if (!dialog.current?.open) dialog.current?.showModal();
    void adminJson<AdminChangeHistory>(`/api/admin/change-history?kind=${kind}&id=${targetId}`)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((error) => {
        if (!cancelled) setStatus(genericErrorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [kind, targetId, attempt]);
  const review = async (item: AdminChangeHistoryItem, field: string) => {
    if (busy || item.source === "resolver") return;
    const selected: AdminRestoreSelection = {
      kind,
      targetId,
      source: item.source,
      operationId: item.operationId,
      field,
    };
    setBusy(true);
    setPreview(null);
    setSelection(selected);
    setStatus("現在の値と競合を確認しています…");
    operation.current = crypto.randomUUID();
    try {
      const result = await adminJson<Preview>("/api/admin/change-history/restore-preview", {
        method: "POST",
        body: JSON.stringify({ selection: selected }),
      });
      setPreview(result);
      setStatus(result.message);
    } catch (error) {
      setStatus(genericErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (busy || !selection || preview?.status !== "ready" || !preview.revision) return;
    setBusy(true);
    setStatus("復元を反映しています…");
    try {
      let result: Pick<AdminCsvResult, "status" | "message">;
      if (preview.change) {
        const input = {
          change: preview.change,
          revision: preview.revision,
          operationId: operation.current,
        };
        do {
          result = await adminJson<AdminCsvResult>("/api/admin/csv-import/apply", {
            method: "POST",
            body: JSON.stringify(input),
          });
          setStatus(result.message);
        } while (result.status === "pending");
      } else {
        result = await adminJson<AdminCsvResult>("/api/admin/change-history/restore-color", {
          method: "POST",
          body: JSON.stringify({
            selection,
            revision: preview.revision,
            operationId: operation.current,
          }),
        });
      }
      setStatus(result.message);
      if (result.status === "applied" || result.status === "unchanged") {
        setPreview(null);
        setSelection(null);
        setAttempt(attempt + 1);
        onChanged();
      } else if (result.status !== "failed") setPreview(null);
    } catch (error) {
      setStatus(`処理が中断しました。同じ操作で再試行できます: ${genericErrorText(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby="change-history-heading"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <div className="edit-form">
        <div className="dialog-heading">
          <h2 id="change-history-heading">変更履歴 · #{targetId}</h2>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            閉じる
          </button>
        </div>
        <p>
          以前の値への復元も新しい手動修正として記録します。後続の変更がある場合は競合として停止します。
        </p>
        <p role="status">{status}</p>
        {preview?.status === "ready" ? (
          <section>
            <h3>復元する差分</h3>
            <p>
              {LABELS[selection!.field]}: {preview.before || "空欄"} → {preview.after || "空欄"}
            </p>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void restore()}
            >
              復元を実行
            </button>
          </section>
        ) : null}
        {!data ? (
          <p>履歴を読み込んでいます…</p>
        ) : !data.items.length ? (
          <p>保存されている変更履歴はありません。</p>
        ) : (
          data.items.map((item) => (
            <section key={`${item.source}:${item.operationId}`}>
              <h3>
                {dateText(item.createdAt)} ·{" "}
                {item.source === "csv"
                  ? "CSV・一括修正"
                  : item.source === "editor"
                    ? "個別編集・復元"
                    : "保存済み判定イベント"}
              </h3>
              <small>
                {item.status} · {item.operationId}
              </small>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>項目</th>
                      <th>変更前</th>
                      <th>変更後</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(item.after)
                      .filter((field) => item.before[field] !== item.after[field])
                      .map((field) => (
                        <tr key={field}>
                          <th>{LABELS[field] || field}</th>
                          <td>{item.before[field] ?? "記録なし"}</td>
                          <td>{item.after[field] || "空欄"}</td>
                          <td>
                            {item.source !== "resolver" && Object.hasOwn(item.before, field) ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void review(item, field)}
                              >
                                この値へ戻す
                              </button>
                            ) : (
                              "参照のみ"
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
        {data?.hasMore ? (
          <p>最新25件の記録を表示しています。過去の全記録は全情報ZIPに含まれます。</p>
        ) : null}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => setAttempt(attempt + 1)}
        >
          履歴を再取得
        </button>
      </div>
    </dialog>
  );
}
