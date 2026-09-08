import { useEffect, useState } from "react";
import type {
  AdminManufacturerApplyResult,
  AdminManufacturerCommand,
  AdminManufacturerEdit,
  AdminManufacturerPreview,
  AdminManufacturerRegistryDetail,
} from "../src/api/admin-manufacturer-contracts.js";
import type {
  AdminExtractionFields,
  AdminExtractionResult,
} from "../src/api/admin-listing-contracts.js";
import { AdminManufacturerPicker } from "./admin-manufacturer-picker.js";
import { AdminListingDiagnosisPanel } from "./admin-listing-diagnosis.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";
const command = <T,>(input: AdminManufacturerCommand) =>
  adminJson<T>("/api/admin/manufacturer-registry", { method: "POST", body: JSON.stringify(input) });
const fieldNames = [
  ["canonicalName", "正式名称"],
  ["nameJa", "日本語表記"],
  ["nameEn", "英語表記"],
] as const;
function extracted(value: AdminExtractionFields | null) {
  return value ? (
    <>
      <strong>{value.manufacturer || "メーカー未確定"}</strong>
      <br />
      {value.model || "型番未確定"}
      <br />
      <small>
        {value.categoryId} · {value.color || "色指定なし"}
      </small>
    </>
  ) : (
    "—"
  );
}
export function AdminManufacturerRegistry({ onDataChanged }: { onDataChanged: () => void }) {
  const [selected, setSelected] = useState(
    () => new URLSearchParams(window.location.search).get("manufacturerId") ?? "",
  );
  const [detail, setDetail] = useState<AdminManufacturerRegistryDetail | null>(null);
  const [edit, setEdit] = useState<AdminManufacturerEdit | null>(null);
  const [preview, setPreview] = useState<AdminManufacturerPreview<AdminExtractionResult> | null>(
    null,
  );
  const [pending, setPending] = useState<Extract<
    AdminManufacturerCommand,
    { action: "apply" }
  > | null>(null);
  const [outcome, setOutcome] = useState<AdminManufacturerApplyResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [diagnosing, setDiagnosing] = useState<number | null>(null);
  const [shops, setShops] = useState<{ key: string; name: string }[]>([]);
  const [metadataError, setMetadataError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void adminJson<{ shops: { key: string; name: string }[] }>("/api/meta")
      .then((data) => {
        if (!cancelled) {
          setShops(data.shops);
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
  const locked = busy || !!pending;
  const shopName = (key: string) =>
    shops.find((row) => row.key === key)?.name || key || "全ショップ共通";
  function change(next: AdminManufacturerEdit) {
    setEdit(next);
    setPreview(null);
    setOutcome(null);
    setError("");
  }
  function choose(value: string) {
    setSelected(value);
    setDetail(null);
    setEdit(null);
    setPreview(null);
    setOutcome(null);
    setError("");
  }
  async function open() {
    if (!selected || locked) return;
    setBusy(true);
    setError("");
    setOutcome(null);
    setPreview(null);
    setDetail(null);
    setEdit(null);
    try {
      const data = await command<AdminManufacturerRegistryDetail>({
        action: "get",
        manufacturerId: selected,
      });
      setDetail(data);
      setEdit(data.profile);
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function check(afterId = 0, maxId?: number) {
    if (!edit || locked) return;
    setBusy(true);
    setError("");
    setOutcome(null);
    setPreview(null);
    const next = {
      ...edit,
      canonicalName: edit.canonicalName.trim(),
      nameJa: edit.nameJa.trim(),
      nameEn: edit.nameEn.trim(),
      ...(edit.alias ? { alias: { ...edit.alias, alias: edit.alias.alias.trim() } } : {}),
    };
    setEdit(next);
    try {
      const result = await command<AdminManufacturerPreview<AdminExtractionResult>>({
        action: "preview",
        edit: next,
        afterId,
        ...(maxId === undefined ? {} : { maxId }),
      });
      setPreview(result);
      setDetail(result.before);
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function apply(input: Extract<AdminManufacturerCommand, { action: "apply" }>) {
    setBusy(true);
    setError("");
    setPending(input);
    try {
      const result = await command<AdminManufacturerApplyResult>(input);
      setOutcome(result);
      setPending(null);
      setPreview(null);
      onDataChanged();
      // Keep the acknowledged result visible even if the follow-up detail read fails.
      try {
        const data = await command<AdminManufacturerRegistryDetail>({
          action: "get",
          manufacturerId: input.edit.manufacturerId,
        });
        setDetail(data);
        setEdit(data.profile);
      } catch (reason) {
        setError(genericErrorText(reason));
      }
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function retryAcceptance(operationId: string) {
    setBusy(true);
    setError("");
    try {
      setOutcome(await command<AdminManufacturerApplyResult>({ action: "replay", operationId }));
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="メーカー・別名の管理">
      <p>
        正式名称と表記揺れを管理します。保存前に変更差分と影響する商品のサンプルを確認できます。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {outcome ? (
        <div role="status">
          <p>{outcome.message}</p>
          <a href={`/?jobId=${outcome.operationId}#jobs`}>再判定の処理を開く</a>
          {outcome.replay === "pending" ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => void retryAcceptance(outcome.operationId)}
            >
              再判定の受付を再試行
            </button>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <div>
          <p>適用結果を確認中です。同じ操作を再送して結果を確かめてください。</p>
          <button type="button" disabled={busy} onClick={() => void apply(pending)}>
            同じ操作を再送
          </button>
        </div>
      ) : null}
      <fieldset disabled={locked}>
        <legend>管理するメーカー</legend>
        <AdminManufacturerPicker value={selected} onChange={choose} disabled={locked} />
        <label>
          メーカーID（新規登録にも使用）
          <input
            value={selected}
            maxLength={100}
            onChange={(event) => choose(event.target.value)}
            placeholder="例: luxman"
          />
        </label>
        <button type="button" disabled={!selected || locked} onClick={() => void open()}>
          メーカーを開く
        </button>
      </fieldset>
      {detail && edit ? (
        <>
          <h3>{detail.exists ? `${detail.profile.canonicalName} の編集` : "メーカーを新規登録"}</h3>
          <p>
            メーカーID: <code>{edit.manufacturerId}</code> · 確認日時 {dateText(detail.observedAt)}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void check();
            }}
          >
            <fieldset disabled={locked}>
              <legend>登録内容</legend>
              {fieldNames.map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={edit[key]}
                    maxLength={100}
                    required={key === "canonicalName"}
                    onChange={(event) => change({ ...edit, [key]: event.target.value })}
                  />
                </label>
              ))}
              <p>追加・変更した正式名称、日本語・英語表記は共通の別名としても登録されます。</p>
              <label>
                <input
                  type="checkbox"
                  checked={!!edit.alias}
                  onChange={(event) =>
                    change(
                      event.target.checked
                        ? { ...edit, alias: { alias: "", shopKey: "", enabled: true } }
                        : {
                            manufacturerId: edit.manufacturerId,
                            canonicalName: edit.canonicalName,
                            nameJa: edit.nameJa,
                            nameEn: edit.nameEn,
                          },
                    )
                  }
                />
                別名も変更する
              </label>
              {edit.alias ? (
                <div>
                  <label>
                    別名
                    <input
                      value={edit.alias.alias}
                      required
                      maxLength={100}
                      onChange={(event) =>
                        change({ ...edit, alias: { ...edit.alias!, alias: event.target.value } })
                      }
                    />
                  </label>
                  <label>
                    別名の適用範囲
                    <select
                      value={edit.alias.shopKey}
                      onChange={(event) =>
                        change({ ...edit, alias: { ...edit.alias!, shopKey: event.target.value } })
                      }
                    >
                      <option value="">全ショップ共通</option>
                      {edit.alias.shopKey &&
                      !shops.some((shop) => shop.key === edit.alias!.shopKey) ? (
                        <option value={edit.alias.shopKey}>{edit.alias.shopKey}</option>
                      ) : null}
                      {shops.map((shop) => (
                        <option key={shop.key} value={shop.key}>
                          {shop.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={edit.alias.enabled}
                      onChange={(event) =>
                        change({
                          ...edit,
                          alias: { ...edit.alias!, enabled: event.target.checked },
                        })
                      }
                    />
                    この別名を有効にする
                  </label>
                  <p>
                    無効化は組み込みの別名にも適用されます。他メーカーと同じ表記になった場合は未確定候補として残します。
                  </p>
                </div>
              ) : null}
              <button type="submit">変更の影響を確認</button>
            </fieldset>
          </form>
          {metadataError ? (
            <p role="alert">
              ショップ情報を取得できません。{metadataError}
              <button
                type="button"
                disabled={busy}
                onClick={() => setAttempt((value) => value + 1)}
              >
                ショップ情報を再取得
              </button>
            </p>
          ) : null}
          {preview ? (
            <section aria-label="メーカー変更の確認">
              <h3>変更差分</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>項目</th>
                      <th>変更前</th>
                      <th>変更後</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldNames.map(([key, label]) => (
                      <tr key={key}>
                        <th>{label}</th>
                        <td>{preview.before.profile[key] || "—"}</td>
                        <td>
                          {preview.edit[key] || "—"}
                          {preview.before.profile[key] !== preview.edit[key] ? "（変更）" : ""}
                        </td>
                      </tr>
                    ))}
                    {preview.edit.alias ? (
                      <tr>
                        <th>別名</th>
                        <td>
                          {preview.aliasBefore
                            ? `${preview.aliasBefore.alias} / ${preview.aliasBefore.status === "verified" ? "有効" : preview.aliasBefore.status === "rejected" ? "無効" : "未確認"}`
                            : "登録なし"}
                        </td>
                        <td>
                          {preview.edit.alias.alias} / {shopName(preview.edit.alias.shopKey)} /{" "}
                          {preview.edit.alias.enabled ? "有効" : "無効"}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {preview.collisions.length ? (
                <div role="status">
                  <p>次の表記は他メーカーと重複し、確定できない場合があります。</p>
                  <ul>
                    {preview.collisions.map((row, index) => (
                      <li key={index}>
                        {row.alias} / {shopName(row.shopKey)} → {row.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <h3>影響する商品の候補</h3>
              <p>
                {shopName(preview.scope.shopKey)}、商品ID {preview.scope.afterId + 1}〜
                {preview.scope.maxId} の範囲から今回 {preview.scope.scanned}件を確認し、候補{" "}
                {preview.scope.matched}件を表示しています。全商品の影響件数ではありません。確認日時{" "}
                {dateText(preview.samples.observedAt)}
              </p>
              <p>
                保存後は適用時点の対象範囲をバックグラウンドで順に確認します。下表はカタログ再照合前の抽出結果です。
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>保存済み</th>
                      <th>現在の抽出</th>
                      <th>変更後の抽出</th>
                      <th>手動補正を保持</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.samples.items.map((row) => (
                      <tr key={row.listingId}>
                        <td>
                          #{row.listingId} {row.title}
                          <br />
                          {shopName(row.shopKey)}
                          {row.error ? <p>{row.error}</p> : null}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setDiagnosing(row.listingId)}
                          >
                            判定理由を見る
                          </button>
                        </td>
                        <td>{extracted(row.saved)}</td>
                        <td>{extracted(row.current)}</td>
                        <td>{extracted(row.proposed)}</td>
                        <td>
                          {extracted(row.withOverrides)}
                          {row.overrides.length ? (
                            <p>手動補正: {row.overrides.join("・")}</p>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!preview.samples.items.length ? <p>今回確認した範囲に候補はありません。</p> : null}
              <div className="pagination">
                <button
                  type="button"
                  disabled={locked || preview.scope.afterId === 0}
                  onClick={() => void check()}
                >
                  先頭から確認
                </button>
                <button
                  type="button"
                  disabled={locked || !preview.scope.hasMore}
                  onClick={() => void check(preview.scope.nextAfterId, preview.scope.maxId)}
                >
                  次の範囲を確認
                </button>
              </div>
              <button
                type="button"
                disabled={locked}
                onClick={() =>
                  void apply({
                    action: "apply",
                    edit: preview.edit,
                    revision: preview.revision,
                    operationId: crypto.randomUUID(),
                  })
                }
              >
                この内容で保存して再判定
              </button>
            </section>
          ) : null}
          <h3>登録済み・組み込みの別名</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>別名</th>
                  <th>範囲</th>
                  <th>状態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.aliases.map((row, index) => (
                  <tr key={index}>
                    <td>
                      {row.alias}
                      {row.source === "code_bootstrap" ? "（組み込み）" : ""}
                    </td>
                    <td>{shopName(row.shopKey)}</td>
                    <td>
                      {row.status === "verified"
                        ? "有効"
                        : row.status === "rejected"
                          ? "無効"
                          : "未確認"}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          change({
                            ...edit,
                            alias: {
                              alias: row.alias,
                              shopKey: row.shopKey,
                              enabled: row.status === "verified",
                            },
                          })
                        }
                      >
                        この別名を編集
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>最近の変更（最大25件）</h3>
          {detail.history.length ? (
            <ol>
              {detail.history.map((row) => (
                <li key={row.operationId}>
                  {dateText(row.createdAt)} · {row.edit.canonicalName}
                  {row.edit.alias
                    ? ` · ${row.edit.alias.alias} / ${shopName(row.edit.alias.shopKey)} / ${row.edit.alias.enabled ? "有効" : "無効"}`
                    : ""}{" "}
                  <a href={`/?jobId=${row.operationId}#jobs`}>再判定の状況</a>{" "}
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void retryAcceptance(row.operationId)}
                  >
                    再判定の受付を再試行
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p>管理画面からの変更履歴はありません。</p>
          )}
        </>
      ) : null}
      {diagnosing !== null ? (
        <AdminListingDiagnosisPanel listingId={diagnosing} onClose={() => setDiagnosing(null)} />
      ) : null}
    </section>
  );
}
