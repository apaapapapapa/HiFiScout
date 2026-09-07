import { AdminEditDiff } from "./admin-edit-diff.js";
import { useEffect, useRef, useState } from "react";
import {
  parseCatalogSpecifications,
  isCatalogSpecificationRecord,
} from "../src/api/catalog-specification-contracts.js";
import type {
  CatalogSpecifications,
  CatalogSpecificationRecord,
} from "../src/api/catalog-specification-contracts.js";
import { adminJson, genericErrorText } from "./admin-shared.js";

const EMPTY: CatalogSpecifications = {
  widthMm: null,
  heightMm: null,
  depthMm: null,
  weightKg: null,
  inputs: null,
  outputs: null,
  main: [],
  sourceUrl: "",
};
const dimensions = [
  { key: "widthMm", label: "幅 (mm)" },
  { key: "heightMm", label: "高さ (mm)" },
  { key: "depthMm", label: "奥行 (mm)" },
  { key: "weightKg", label: "重量 (kg)" },
] as const;

export function AdminCatalogSpecifications({
  productId,
  name,
  onClose,
}: {
  productId: number;
  name: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<CatalogSpecifications>(EMPTY);
  const [initial, setInitial] = useState(JSON.stringify(EMPTY));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("読み込んでいます…");
  const path = `/api/admin/knowledge-catalog/products/${productId}/specifications`;
  const original: CatalogSpecifications = JSON.parse(initial);
  const summarize = (value: CatalogSpecifications) => ({
    ...Object.fromEntries(
      dimensions.map(({ key, label }) => [
        label,
        value[key] == null ? "記載なし" : String(value[key]),
      ]),
    ),
    入力端子:
      value.inputs == null
        ? "記載なし"
        : value.inputs.map((p) => `${p.connector} (${p.count ?? "未確認"}系統)`).join(" / ") ||
          "なし（確認済み）",
    出力端子:
      value.outputs == null
        ? "記載なし"
        : value.outputs.map((p) => `${p.connector} (${p.count ?? "未確認"}系統)`).join(" / ") ||
          "なし（確認済み）",
    主要仕様: value.main.map((p) => `${p.name}: ${p.value}`).join(" / ") || "記載なし",
    出典URL: value.sourceUrl,
  });
  const before = summarize(original),
    after = summarize(draft);
  const diff = Object.keys(before)
    .filter((key) => before[key as keyof typeof before] !== after[key as keyof typeof after])
    .map((key) => ({
      field: key,
      before: before[key as keyof typeof before],
      after: after[key as keyof typeof after],
    }));
  const dirty = JSON.stringify(draft) !== initial;
  const valid = parseCatalogSpecifications(draft);
  useEffect(() => {
    let active = true;
    dialog.current?.showModal();
    void adminJson<{ specifications: CatalogSpecificationRecord | null }>(path)
      .then((data) => {
        if (!active) return;
        if (data.specifications !== null && !isCatalogSpecificationRecord(data.specifications))
          throw new Error("invalid_response");
        const next = data.specifications ? parseCatalogSpecifications(data.specifications)! : EMPTY;
        setDraft(next);
        setInitial(JSON.stringify(next));
        setReady(true);
        setStatus("");
      })
      .catch((error) => {
        if (active) setStatus(`取得に失敗しました: ${genericErrorText(error)}`);
      });
    return () => {
      active = false;
    };
  }, [path]);
  const close = () => {
    if (saving || (dirty && !window.confirm("未保存の仕様を破棄しますか？"))) return;
    onClose();
  };
  const save = async () => {
    if (!valid || !dirty || saving) return;
    setSaving(true);
    setStatus("保存しています…");
    try {
      const data = await adminJson<{ specifications: CatalogSpecificationRecord }>(path, {
        method: "PATCH",
        body: JSON.stringify(valid),
      });
      if (!isCatalogSpecificationRecord(data.specifications)) throw new Error("invalid_response");
      const next = parseCatalogSpecifications(data.specifications)!;
      setDraft(next);
      setInitial(JSON.stringify(next));
      setStatus("比較用の仕様を保存しました。");
    } catch (error) {
      setStatus(`保存に失敗しました: ${genericErrorText(error)}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby="specification-heading"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-heading">
          <h2 id="specification-heading">{name} の比較用仕様</h2>
          <button type="button" onClick={close} disabled={saving}>
            閉じる
          </button>
        </div>
        <p>
          メーカー資料などで確認した機種共通の仕様を入力してください。寸法は本体1台分です。未確認の値は空欄にします。
        </p>
        <fieldset disabled={!ready || saving} className="specification-fields">
          <legend>寸法・重量</legend>
          {dimensions.map(({ key, label }) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min="0.001"
                max="100000"
                step="any"
                value={draft[key] ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
        </fieldset>
        {(["inputs", "outputs"] as const).map((key) => (
          <fieldset key={key} disabled={!ready || saving}>
            <legend>{key === "inputs" ? "入力端子" : "出力端子"}</legend>
            <label>
              記載状態
              <select
                value={draft[key] === null ? "unknown" : draft[key].length ? "listed" : "none"}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]:
                      e.target.value === "unknown"
                        ? null
                        : e.target.value === "none"
                          ? []
                          : [{ connector: "", count: null }],
                  })
                }
              >
                <option value="unknown">記載なし</option>
                <option value="none">なし（確認済み）</option>
                <option value="listed">端子を登録</option>
              </select>
            </label>
            {draft[key]?.map((port, index) => (
              <div className="specification-port" key={index}>
                <label>
                  端子名
                  <input
                    value={port.connector}
                    maxLength={60}
                    list="specification-connectors"
                    required
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [key]: draft[key]!.map((p, i) =>
                          i === index ? { ...p, connector: e.target.value } : p,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  系統数
                  <input
                    type="number"
                    min="1"
                    max="128"
                    placeholder="未確認"
                    value={port.count ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [key]: draft[key]!.map((p, i) =>
                          i === index
                            ? { ...p, count: e.target.value === "" ? null : Number(e.target.value) }
                            : p,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, [key]: draft[key]!.filter((_, i) => i !== index) })
                  }
                >
                  削除
                </button>
              </div>
            ))}
            {draft[key] && draft[key].length < 16 ? (
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, [key]: [...draft[key]!, { connector: "", count: null }] })
                }
              >
                端子を追加
              </button>
            ) : null}
            <p>RCAの左右1組は1系統です。系統数が未確認の場合は空欄にしてください。</p>
          </fieldset>
        ))}
        <datalist id="specification-connectors">
          {[
            "RCA ライン",
            "XLR バランス",
            "RCA フォノ",
            "光デジタル",
            "同軸デジタル",
            "USB",
            "HDMI",
            "スピーカー",
            "6.3mm ヘッドホン",
            "4.4mm バランス",
          ].map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <fieldset disabled={!ready || saving}>
          <legend>主要仕様（最大12項目）</legend>
          {draft.main.map((item, index) => (
            <div className="specification-port" key={index}>
              <label>
                項目名
                <input
                  required
                  maxLength={60}
                  value={item.name}
                  placeholder="例: 定格出力"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      main: draft.main.map((p, i) =>
                        i === index ? { ...p, name: e.target.value } : p,
                      ),
                    })
                  }
                />
              </label>
              <label>
                値・単位・条件
                <input
                  required
                  maxLength={200}
                  value={item.value}
                  placeholder="例: 100 W / 8 Ω"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      main: draft.main.map((p, i) =>
                        i === index ? { ...p, value: e.target.value } : p,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, main: draft.main.filter((_, i) => i !== index) })
                }
              >
                削除
              </button>
            </div>
          ))}
          {draft.main.length < 12 ? (
            <button
              type="button"
              onClick={() => setDraft({ ...draft, main: [...draft.main, { name: "", value: "" }] })}
            >
              仕様を追加
            </button>
          ) : null}
          <label>
            出典URL
            <input
              type="url"
              required
              maxLength={2048}
              value={draft.sourceUrl}
              onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })}
            />
          </label>
        </fieldset>
        {dirty && !valid ? (
          <p>
            出典URLと各項目を確認してください。数値は正数、項目名・端子名は重複なしで入力します。
          </p>
        ) : null}
        <AdminEditDiff rows={diff} />
        <p role="status">{status}</p>
        <div className="dialog-actions">
          <button type="submit" disabled={!ready || saving || !dirty || !valid}>
            仕様を保存
          </button>
        </div>
      </form>
    </dialog>
  );
}
