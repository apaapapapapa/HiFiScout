import { useEffect, useRef, useState } from "react";
import {
  adminCsvPreviewBatches,
  type AdminCsvChange,
  type AdminCsvResult,
} from "../src/api/admin-csv-contracts.js";
import { AdminManufacturerPicker } from "./admin-manufacturer-picker.js";
import { AdminEditDiff } from "./admin-edit-diff.js";
import { adminJson, genericErrorText, type CategoryFacet } from "./admin-shared.js";

export interface BulkListing {
  id: number;
  title: string;
  canonicalManufacturerId: string;
  model: string;
  primaryCategoryId: string;
}
type Field = "manufacturer_id" | "model" | "primary_category_id";
const LABELS: Record<Field, string> = {
  manufacturer_id: "メーカー",
  model: "型番",
  primary_category_id: "カテゴリ",
};
interface Plan {
  changes: AdminCsvChange[];
  results: AdminCsvResult[];
  field: Field;
}

/** Selection is an explicit snapshot of at most one 50-row search page. */
export function AdminBulkEdit({
  items,
  categories,
  onClose,
  onChanged,
}: {
  items: BulkListing[];
  categories: CategoryFacet[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stop = useRef(false);
  const [field, setField] = useState<Field>("manufacturer_id");
  const [value, setValue] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function preview() {
    setBusy(true);
    setError("");
    setPlan(null);
    setMessage("");
    const changes: AdminCsvChange[] = items.map((item, index) => {
      const original = {
        manufacturer_id: item.canonicalManufacturerId,
        model: item.model,
        primary_category_id: item.primaryCategoryId,
      };
      return {
        line: index + 1,
        original: { version: 1, kind: "listing", id: item.id, values: original },
        values: { ...original, [field]: value.trim() },
      };
    });
    try {
      const results: AdminCsvResult[] = [];
      for (const batch of adminCsvPreviewBatches(changes)) {
        const response = await adminJson<{ items: AdminCsvResult[] }>(
          "/api/admin/csv-import/preview",
          { method: "POST", body: JSON.stringify({ changes: batch }) },
        );
        if (
          response.items.length !== batch.length ||
          response.items.some(
            (r, i) =>
              r.id !== batch[i].original.id || r.line !== batch[i].line || r.kind !== "listing",
          )
        )
          throw new Error("確認結果と選択商品が一致しません。もう一度確認してください。");
        results.push(...response.items);
      }
      setPlan({ changes, results, field });
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan || busy) return;
    stop.current = false;
    setBusy(true);
    setApplying(true);
    setError("");
    setMessage("");
    const results = [...plan.results];
    let changed = false;
    try {
      for (let index = 0; index < results.length && !stop.current; index++) {
        let row = results[index];
        if (!["ready", "pending", "failed"].includes(row.status) || !row.revision) continue;
        const operationId = row.operationId || crypto.randomUUID();
        const revision = row.revision;
        results[index] = { ...row, operationId, revision };
        setPlan({ ...plan, results: [...results] });
        do {
          try {
            const response = await adminJson<AdminCsvResult>("/api/admin/csv-import/apply", {
              method: "POST",
              body: JSON.stringify({ change: plan.changes[index], revision, operationId }),
            });
            row = { ...response, operationId, revision };
            if (row.status === "applied" || row.status === "pending") changed = true;
          } catch {
            row = {
              ...row,
              operationId,
              revision,
              status: "failed",
              message: "更新結果を確認できません。再試行してください。",
            };
          }
          results[index] = row;
          setPlan({ ...plan, results: [...results] });
        } while (row.status === "pending" && !stop.current);
      }
      setMessage(
        stop.current
          ? "処理を停止しました。適用済みの変更は保存されています。残りを再開できます。"
          : "処理が終わりました。商品ごとの結果を確認してください。",
      );
    } finally {
      setBusy(false);
      setApplying(false);
      if (changed) onChanged();
    }
  }

  const ready =
    plan?.results.filter(
      (row) => ["ready", "pending", "failed"].includes(row.status) && row.revision,
    ).length ?? 0;
  const applied = plan?.results.filter((row) => row.status === "applied").length ?? 0;
  return (
    <dialog
      ref={dialog}
      className="admin-editor"
      aria-labelledby="bulk-edit-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="edit-form">
        <div className="dialog-heading">
          <h2 id="bulk-edit-heading">選択した{items.length}件を一括修正</h2>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            閉じる
          </button>
        </div>
        <p>選択した商品だけが対象です。変更は手動補正として保存され、変更履歴から確認できます。</p>
        {!plan ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void preview();
            }}
          >
            <label>
              変更する項目
              <select
                value={field}
                disabled={busy}
                onChange={(event) => {
                  setField(event.currentTarget.value as Field);
                  setValue("");
                }}
              >
                {Object.entries(LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {field === "manufacturer_id" ? (
              <AdminManufacturerPicker
                value={value}
                onChange={setValue}
                disabled={busy}
                clearLabel="メーカー未確定に戻す"
              />
            ) : field === "primary_category_id" ? (
              <label>
                変更後のカテゴリ
                <select
                  required
                  value={value}
                  disabled={busy}
                  onChange={(event) => setValue(event.currentTarget.value)}
                >
                  <option value="">選択してください</option>
                  {categories
                    .filter((c) => c.classifiable)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <label>
                変更後の型番
                <input
                  maxLength={200}
                  value={value}
                  disabled={busy}
                  onChange={(event) => setValue(event.currentTarget.value)}
                />
              </label>
            )}
            {field !== "primary_category_id" && !value.trim() ? (
              <p>空欄のまま適用すると、選択商品の{LABELS[field]}を未確定として固定します。</p>
            ) : null}
            <button
              type="submit"
              disabled={
                busy ||
                !items.length ||
                items.length > 50 ||
                (field === "primary_category_id" && !value)
              }
            >
              対象と差分を確認
            </button>
          </form>
        ) : (
          <>
            <p>
              適用済み {applied}件 / 適用・再試行できる対象 {ready}件
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>対象商品</th>
                    <th>変更差分</th>
                    <th>確認・実行結果</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.changes.map((change, index) => (
                    <tr key={change.original.id}>
                      <td>
                        #{change.original.id} {items[index].title}
                      </td>
                      <td>
                        <AdminEditDiff
                          rows={[
                            {
                              field: LABELS[plan.field],
                              before: change.original.values[plan.field] || "未確定",
                              after: change.values[plan.field] || "未確定",
                            },
                          ]}
                        />
                      </td>
                      <td>{plan.results[index].message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              競合・入力エラー・変更なしの商品は適用対象に含まれません。通信失敗の再試行でも、同じ変更は重複適用しません。
            </p>
            <div className="csv-import-actions">
              <button type="button" disabled={busy || !ready} onClick={() => void apply()}>
                {applied || plan.results.some((r) => r.operationId)
                  ? "残りを再開・失敗を再試行"
                  : `${ready}件に変更を適用`}
              </button>
              {!plan.results.some((r) => r.operationId) ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setPlan(null)}
                >
                  入力に戻る
                </button>
              ) : null}
              {applying ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    stop.current = true;
                    setMessage("現在の処理が終わり次第停止します。");
                  }}
                >
                  処理を停止
                </button>
              ) : null}
            </div>
          </>
        )}
        {busy ? (
          <p role="status">
            {applying ? "変更を適用しています…" : "現在の値と差分を確認しています…"}
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </dialog>
  );
}
