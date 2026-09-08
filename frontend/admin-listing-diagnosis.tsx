import { useEffect, useRef, useState } from "react";
import type { AdminListingDiagnosis } from "../src/api/admin-listing-contracts.js";
import { adminJson, dateText, genericErrorText, safeSourceUrl } from "./admin-shared.js";

export function AdminListingDiagnosisPanel({
  listingId,
  onClose,
}: {
  listingId: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<AdminListingDiagnosis | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!dialog.current?.open) dialog.current?.showModal();
    setData(null);
    setError("");
    void adminJson<AdminListingDiagnosis>(`/api/admin/listings/${listingId}/diagnosis`)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(genericErrorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [listingId, attempt]);
  const source = safeSourceUrl(data?.seller.url ?? "");
  return (
    <dialog ref={dialog} aria-labelledby="listing-diagnosis-heading" onClose={onClose}>
      <div className="edit-form">
        <div className="dialog-heading">
          <h2 id="listing-diagnosis-heading">判定理由を確認 · #{listingId}</h2>
          <button type="button" className="secondary-button" onClick={onClose}>
            閉じる
          </button>
        </div>
        {error ? (
          <p role="alert">
            取得に失敗しました: {error}{" "}
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              再試行
            </button>
          </p>
        ) : !data ? (
          <p role="status">読み込んでいます…</p>
        ) : null}
        {data ? (
          <>
            <p>
              <a href={`/?listingId=${listingId}#extraction`}>この商品で抽出テスト</a>
            </p>
            <h3>販売店から保存した情報</h3>
            <p>{data.seller.title}</p>
            <dl>
              <dt>メーカー / 型番 / カテゴリ</dt>
              <dd>
                {[data.seller.manufacturer, data.seller.model, data.seller.category]
                  .map((v) => v || "記載なし")
                  .join(" / ")}
              </dd>
              <dt>最終確認</dt>
              <dd>{dateText(data.observedAt)}</dd>
            </dl>
            {source ? (
              <a href={source} target="_blank" rel="noreferrer">
                販売店の記載を確認 ↗
              </a>
            ) : null}
            <h3>現在の正規化・判定</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>項目</th>
                    <th>保存値</th>
                    <th>判定方法・状態</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>メーカー</th>
                    <td>
                      {data.decision.manufacturer || "未確定"} (
                      {data.decision.manufacturerId || "—"})
                    </td>
                    <td>
                      {data.decision.manufacturerMethod} / {data.decision.manufacturerStatus} /{" "}
                      {data.decision.manufacturerConfidence}
                    </td>
                  </tr>
                  <tr>
                    <th>型番</th>
                    <td>
                      {data.decision.model || "未確定"} ({data.decision.normalizedModel || "—"})
                    </td>
                    <td>
                      {data.decision.modelMethod} / {data.decision.modelStatus} /{" "}
                      {data.decision.modelConfidence}
                    </td>
                  </tr>
                  <tr>
                    <th>カテゴリ</th>
                    <td>
                      {data.decision.category || "未分類"} ({data.decision.categoryId})
                    </td>
                    <td>{data.decision.categoryStatus}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3>手動補正</h3>
            <dl>
              {Object.entries(data.overrides).map(([field, value]) => (
                <div key={field}>
                  <dt>{field}</dt>
                  <dd>{value === null ? "補正なし" : value || "未確定として固定"}</dd>
                </div>
              ))}
            </dl>
            <p>
              手動補正がある項目は補正後の判定です。補正前の自動判定が保存されていない場合、その経路は復元できません。
            </p>
            <h3>カタログとの照合</h3>
            <p>
              {data.identity.catalogId
                ? `照合先: #${data.identity.catalogId} ${data.identity.catalogName || ""}`
                : "確定した照合先なし"}
            </p>
            {data.identity.candidateId ? (
              <p>
                未確定候補: #{data.identity.candidateId} {data.identity.candidateName}
                （確定扱いにはしません）
              </p>
            ) : null}
            <dl>
              <dt>判定方法 / 確度 / 評価日時</dt>
              <dd>
                {data.identity.method || "未評価"} / {data.identity.confidence || "—"} /{" "}
                {dateText(data.identity.evaluatedAt || "")}
              </dd>
              <dt>一致した情報</dt>
              <dd>{data.identity.matchedFields}</dd>
              <dt>一致を妨げた情報</dt>
              <dd>{data.identity.rejectedBy}</dd>
            </dl>
            <h3>検索への反映</h3>
            <p>
              {data.search.pending ? "反映待ち" : "保存済みの検索状態"} ·{" "}
              {data.search.active ? "掲載中" : "掲載終了"}
            </p>
            <p>
              検索カード: {data.search.key || "所属なし"} / {data.search.model || "—"} /{" "}
              {data.search.categoryId || "—"} / 出品 {data.search.offerCount ?? "—"}件
            </p>
            <h3>同じメーカー・正規化型番の掲載商品</h3>
            <p>
              型番の確定状態、カテゴリ、照合先により別カードになる場合があります。これは保存状態の比較で、自動統合の判断ではありません。
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>商品 / 販売店</th>
                    <th>カテゴリ / 型番状態</th>
                    <th>検索カード</th>
                  </tr>
                </thead>
                <tbody>
                  {data.peers.map((peer) => (
                    <tr key={peer.id}>
                      <td>
                        #{peer.id} / {peer.shop}
                      </td>
                      <td>
                        {peer.category} / {peer.modelStatus}
                      </td>
                      <td>{peer.entityKey || "所属なし"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.peersHasMore ? <p>先頭20件を表示しています。</p> : null}
          </>
        ) : null}
      </div>
    </dialog>
  );
}
