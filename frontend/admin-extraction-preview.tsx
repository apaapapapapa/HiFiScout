import { AdminListingDiagnosisPanel } from "./admin-listing-diagnosis.js";
import { useEffect, useState } from "react";
import type {
  AdminExtractionRequest,
  AdminExtractionResult,
  AdminExtractionFields,
} from "../src/api/admin-listing-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";
import { AdminManufacturerPicker } from "./admin-manufacturer-picker.js";

const FIELDS: [keyof AdminExtractionFields, string][] = [
  ["manufacturer", "メーカー名"],
  ["manufacturerId", "メーカーID"],
  ["model", "型番"],
  ["normalizedModel", "照合用型番"],
  ["categoryId", "カテゴリ"],
  ["color", "色"],
];
export function AdminExtractionPreview() {
  const [diagnosing, setDiagnosing] = useState<number | null>(null);
  const [ids, setIds] = useState(
    () => new URLSearchParams(window.location.search).get("listingId") ?? "",
  );
  const [title, setTitle] = useState("");
  const [rawManufacturer, setRawManufacturer] = useState("");
  const [rawModel, setRawModel] = useState("");
  const [rawCategory, setRawCategory] = useState("");
  const [shopKey, setShopKey] = useState("");
  const [draft, setDraft] = useState(false);
  const [manufacturerId, setManufacturerId] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasShop, setAliasShop] = useState("");
  const [shops, setShops] = useState<{ key: string; name: string }[]>([]);
  const [metadataError, setMetadataError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AdminExtractionResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void adminJson<{ shops: { key: string; name: string }[] }>("/api/meta")
      .then((value) => {
        if (!cancelled) {
          setShops(value.shops);
          setMetadataError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) setMetadataError(genericErrorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  async function preview() {
    setError("");
    setResult(null);
    const tokens = ids.split(/[\s,、]+/u).filter(Boolean);
    if (
      tokens.some(
        (value) =>
          !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1,
      )
    ) {
      setError("商品IDは正の整数を空白またはカンマで区切って指定してください。");
      return;
    }
    const samples: AdminExtractionRequest["samples"] = [...new Set(tokens.map(Number))].map(
      (listingId) => ({ listingId }),
    );
    if (title.trim())
      samples.push({ title: title.trim(), rawManufacturer, rawModel, rawCategory, shopKey });
    if (!samples.length || samples.length > 20) {
      setError("商品IDまたはタイトルを、合計20件以内で指定してください。");
      return;
    }
    if (draft && (!manufacturerId || !alias.trim())) {
      setError("仮ルールのメーカーと別名を指定してください。");
      return;
    }
    setBusy(true);
    try {
      setResult(
        await adminJson<AdminExtractionResult>("/api/admin/extraction-preview", {
          method: "POST",
          body: JSON.stringify({
            samples,
            ...(draft
              ? { draftAlias: { manufacturerId, alias: alias.trim(), shopKey: aliasShop } }
              : {}),
          }),
        }),
      );
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel workspace-panel" aria-label="抽出テスト・修正効果">
      <h2>抽出テスト・修正効果</h2>
      <p>
        保存済みの商品ID、または商品タイトルを指定します。最大20件を、登録内容を変更せずに確認できます。
      </p>
      <p>
        メーカー・型番・カテゴリ・色の抽出を比較します。販売店ページの取得とカタログ再照合は行いません。
      </p>
      {metadataError ? (
        <p role="alert">
          ショップ一覧を取得できません: {metadataError}{" "}
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            ショップ一覧を再取得
          </button>
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void preview();
        }}
        onChange={() => setResult(null)}
      >
        <fieldset disabled={busy}>
          <legend>対象サンプル</legend>
          <label>
            保存済み商品ID
            <textarea
              value={ids}
              onChange={(event) => setIds(event.target.value)}
              placeholder="123, 456"
              rows={2}
            />
          </label>
          <label>
            商品タイトル
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={4096}
            />
          </label>
          <label>
            元のメーカー表記
            <input
              value={rawManufacturer}
              onChange={(event) => setRawManufacturer(event.target.value)}
              maxLength={4096}
            />
          </label>
          <label>
            元の型番表記
            <input
              value={rawModel}
              onChange={(event) => setRawModel(event.target.value)}
              maxLength={4096}
            />
          </label>
          <label>
            元のカテゴリ表記
            <input
              value={rawCategory}
              onChange={(event) => setRawCategory(event.target.value)}
              maxLength={4096}
            />
          </label>
          <label>
            入力タイトルのショップ
            <select value={shopKey} onChange={(event) => setShopKey(event.target.value)}>
              <option value="">共通ルール</option>
              {shops.map((shop) => (
                <option key={shop.key} value={shop.key}>
                  {shop.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>仮の別名ルール</legend>
          <label>
            <input
              type="checkbox"
              checked={draft}
              onChange={(event) => setDraft(event.target.checked)}
            />
            別名を追加した場合も比較する
          </label>
          {draft ? (
            <>
              <AdminManufacturerPicker
                value={manufacturerId}
                onChange={(value) => {
                  setManufacturerId(value);
                  setResult(null);
                }}
                clearLabel="メーカーを選び直す"
              />
              <label>
                仮の別名
                <input
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  maxLength={100}
                />
              </label>
              <label>
                仮ルールの適用範囲
                <select value={aliasShop} onChange={(event) => setAliasShop(event.target.value)}>
                  <option value="">全ショップ</option>
                  {shops.map((shop) => (
                    <option key={shop.key} value={shop.key}>
                      {shop.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {manufacturerId ? (
            <p>
              <a href={`/?manufacturerId=${manufacturerId}#manufacturers`}>
                このメーカーの正式名称・別名を管理する
              </a>
            </p>
          ) : null}
        </fieldset>
        <button type="submit" disabled={busy}>
          {busy ? "抽出を確認しています…" : "保存せず抽出を確認"}
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <section aria-label="抽出比較結果">
          <p role="status">{result.items.length}件を確認しました。登録内容は変更していません。</p>
          <p>
            確認日時 {dateText(result.observedAt)} · ルール: メーカー {result.versions.manufacturer}{" "}
            / 型番 {result.versions.model} / 分類 {result.versions.taxonomy}
          </p>
          {result.items.map((item, index) => (
            <section key={`${item.listingId}-${index}`} aria-label={`サンプル ${index + 1}`}>
              <h3>
                {item.listingId ? `#${item.listingId} · ` : "入力タイトル · "}
                {item.title}
              </h3>
              {item.error ? (
                <p role="alert">{item.error}</p>
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>項目</th>
                          <th>保存済み</th>
                          <th>現行ルールで抽出</th>
                          <th>仮ルールで抽出</th>
                          <th>手動補正を維持した仮値</th>
                        </tr>
                      </thead>
                      <tbody>
                        {FIELDS.map(([key, label]) => (
                          <tr key={key}>
                            <th>{label}</th>
                            <td>{item.saved?.[key] || "—"}</td>
                            <td>{item.current?.[key] || "—"}</td>
                            <td>
                              {item.proposed?.[key] || "—"}
                              {item.current?.[key] !== item.proposed?.[key] ? (
                                <strong>（変更）</strong>
                              ) : null}
                            </td>
                            <td>{item.withOverrides?.[key] || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p>
                    抽出理由: メーカー {item.reasons?.manufacturer} · 型番 {item.reasons?.model} ·
                    カテゴリ {item.reasons?.category}
                  </p>
                  <p>
                    維持した手動補正: {item.overrides.join("、") || "なし"}
                    。仮値はカタログ再照合前の情報です。
                  </p>
                  {item.listingId ? (
                    <button type="button" onClick={() => setDiagnosing(item.listingId)}>
                      判定理由を確認
                    </button>
                  ) : null}
                </>
              )}
            </section>
          ))}
        </section>
      ) : null}
      {diagnosing !== null ? (
        <AdminListingDiagnosisPanel listingId={diagnosing} onClose={() => setDiagnosing(null)} />
      ) : null}
    </section>
  );
}
