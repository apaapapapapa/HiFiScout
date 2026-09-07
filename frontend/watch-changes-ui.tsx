import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api-client.js";
import type { DisplayProduct } from "./types.js";
import { readPreference, savePreference } from "./public-ui-state.js";
import { validProductKey, productPermalinkPath } from "./product-permalink.js";
import { yen } from "./format.js";
import {
  WATCH_OBSERVATIONS_KEY,
  MAX_WATCH_REFRESH,
  captureWatchObservation,
  compareWatchObservations,
  mergeWatchObservations,
  parseWatchObservations,
  refreshWatchedProducts,
} from "./watch-changes.js";
import type { WatchChange, WatchObservation } from "./watch-changes.js";

interface Result {
  key: string;
  observation: WatchObservation | null;
  previousAt: string | null;
  changes: WatchChange[];
}

function changeText(change: WatchChange): string {
  if (change.kind === "new") return "新しい出品";
  if (change.kind === "sold_out") return "売り切れ表示に変更";
  if (change.kind === "missing") return "掲載を確認できず";
  return `${yen.format(change.previousPriceYen!)} → ${yen.format(change.offer.priceYen!)}`;
}

export function FavoriteWatch({
  products,
  api,
  onSnapshots,
  shopName,
}: {
  products: DisplayProduct[];
  api: ApiClient;
  onSnapshots: (products: DisplayProduct[]) => void;
  shopName: (key: string) => string;
}) {
  // Freeze this view's scope: updated prices/stock may change favorite filtering and ordering.
  const [scope] = useState(() => products.filter((product) => validProductKey(product.key)));
  const [batch, setBatch] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const onSnapshotsRef = useRef(onSnapshots);
  onSnapshotsRef.current = onSnapshots;
  useEffect(() => {
    const controller = new AbortController();
    const keys = scope
      .slice(batch * MAX_WATCH_REFRESH, (batch + 1) * MAX_WATCH_REFRESH)
      .map((product) => product.key);
    setResults([]);
    setSaveError(false);
    if (!keys.length) return () => controller.abort();
    setBusy(true);
    const baseline = parseWatchObservations(readPreference(WATCH_OBSERVATIONS_KEY));
    void refreshWatchedProducts(api, keys, controller.signal)
      .then((fresh) => {
        if (controller.signal.aborted) return;
        const checkedAt = new Date().toISOString();
        const observations: WatchObservation[] = [];
        setResults(
          fresh.map(({ key, detail }) => {
            const before = baseline.find((entry) => entry.key === key);
            const observation = detail ? captureWatchObservation(detail, checkedAt) : null;
            if (observation) observations.push(observation);
            return {
              key,
              observation,
              previousAt: before?.checkedAt ?? null,
              changes: observation ? compareWatchObservations(before, observation) : [],
            };
          }),
        );
        if (observations.length) {
          const merged = mergeWatchObservations(
            parseWatchObservations(readPreference(WATCH_OBSERVATIONS_KEY)),
            observations,
          );
          setSaveError(!savePreference(WATCH_OBSERVATIONS_KEY, JSON.stringify(merged)));
          onSnapshotsRef.current(
            fresh.flatMap((result) => (result.detail ? [result.detail.product] : [])),
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setResults(
            keys.map((key) => ({ key, observation: null, previousAt: null, changes: [] })),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [api, scope, batch, attempt]);
  if (!scope.length) return null;
  return (
    <section className="favorite-watch" aria-label="お気に入りの変化">
      <h2>前回確認からの変化</h2>
      <p>
        この表示の対象を10件ずつ確認します。収集済みの価格・在庫情報です。掲載を確認できない場合は、掲載終了や製品の再整理などが考えられ、成約を示すものではありません。
      </p>
      <div className="watch-refresh-actions">
        <span>
          {batch * MAX_WATCH_REFRESH + 1}〜{Math.min((batch + 1) * MAX_WATCH_REFRESH, scope.length)}{" "}
          / {scope.length}件
        </span>
        <button type="button" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
          この10件を再確認
        </button>
        <button
          type="button"
          disabled={busy || batch === 0}
          onClick={() => setBatch((value) => value - 1)}
        >
          前の10件
        </button>
        <button
          type="button"
          disabled={busy || (batch + 1) * MAX_WATCH_REFRESH >= scope.length}
          onClick={() => setBatch((value) => value + 1)}
        >
          次の10件
        </button>
      </div>
      {busy ? <p role="status">出品の変化を確認しています…</p> : null}
      {saveError ? (
        <p role="alert">今回の比較結果を保存できませんでした。次回は以前の記録と比較します。</p>
      ) : null}
      <ul>
        {results.map((result) => (
          <li key={result.key}>
            <a href={productPermalinkPath(result.key) || "/"}>
              {scope.find((product) => product.key === result.key)?.model || "製品"}
            </a>
            {!result.observation ? (
              <p>取得できませんでした。前回の記録を保持しています。</p>
            ) : (
              <>
                <p>
                  今回の確認：
                  <time dateTime={result.observation.checkedAt}>
                    {new Date(result.observation.checkedAt).toLocaleString("ja-JP")}
                  </time>
                </p>
                {!result.previousAt ? (
                  <p>初回の記録です。次回から比較できます。</p>
                ) : (
                  <>
                    <p>
                      比較元：
                      <time dateTime={result.previousAt}>
                        {new Date(result.previousAt).toLocaleString("ja-JP")}
                      </time>
                    </p>
                    {result.changes.length ? (
                      <details open>
                        <summary>{result.changes.length}件の変化</summary>
                        <ul>
                          {result.changes.slice(0, 20).map((change) => (
                            <li key={`${change.kind}:${change.offer.id}`}>
                              {shopName(change.offer.shopKey)}：{changeText(change)}
                            </li>
                          ))}
                        </ul>
                        {result.changes.length > 20 ? (
                          <p>先頭20件を表示しています。製品ページで出品を確認できます。</p>
                        ) : null}
                      </details>
                    ) : (
                      <p>比較できる出品に変化はありません。</p>
                    )}
                  </>
                )}
                {!result.observation.complete ? (
                  <p>出品の一部を確認しています。見つからない出品の掲載終了は判定していません。</p>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
