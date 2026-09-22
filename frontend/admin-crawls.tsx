import { useEffect, useState } from "react";
import type { AdminCrawlOverview } from "../src/api/admin-listing-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";

const STAGES: Record<string, string> = {
  idle: "待機",
  initialize: "準備",
  fetch: "取得",
  parse: "解析",
  finalize: "保存・反映",
  detail: "詳細確認",
  inventory: "在庫確認",
};

export function AdminCrawls() {
  const [data, setData] = useState<AdminCrawlOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function refresh() {
    setData(await adminJson<AdminCrawlOverview>("/api/admin/crawls"));
    setStale(false);
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      await refresh();
    } catch (reason) {
      setStale(true);
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function control(shopKey: string, action: "pause" | "resume" | "run") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await adminJson<{ message: string }>("/api/admin/crawls/control", {
        method: "POST",
        body: JSON.stringify({ shopKey, action }),
      });
      setMessage(result.message);
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      // A lost response may follow a saved change. Always reconcile before another operation.
      try {
        await refresh();
      } catch (reason) {
        setStale(true);
        setError((previous) => [previous, genericErrorText(reason)].filter(Boolean).join(" "));
      }
      setBusy(false);
    }
  }
  return (
    <section className="panel workspace-panel" aria-label="ショップ別クロール管理">
      <div className="panel-heading">
        <h2>ショップ別の収集状況</h2>
        <button type="button" disabled={busy} onClick={() => void load()}>
          状態を再読み込み
        </button>
      </div>
      <p>
        収集スイッチの変更はすぐに保存されます。オフは再度オンにするまで維持され、定期収集と実行中の続きの処理を停止します。途中位置は保持し、現在の1ステップが完了する場合があります。
      </p>
      <p>
        オンに戻すと保留中の処理または次回予定から再開します。毎日23:00〜翌8:00（日本時間）は、オンでも予定停止します。
      </p>
      {data ? (
        <p>
          確認日時: {dateText(data.observedAt)} · 対象: 登録ショップの保存済み状態と実行中の進捗
        </p>
      ) : null}
      {data?.quietHours ? (
        <p role="status">夜間の予定停止中です。再開可能日時: {dateText(data.quietEndsAt)}</p>
      ) : null}
      {busy ? <p role="status">状態を確認しています…</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {stale ? (
        <p role="alert">最新の収集設定を確認できません。状態を再読み込みしてください。</p>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ショップ / 状態</th>
              <th>収集</th>
              <th>実行段階 / 次回予定</th>
              <th>最終成功 / 取得件数</th>
              <th>失敗理由</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((item) => {
              const paused = !!item.control?.paused || item.pausedIntent;
              const configured = item.enabled && item.configured;
              const known = !stale && !!item.control;
              const collectionEnabled = configured && !paused;
              return (
                <tr key={item.shopKey}>
                  <td>
                    {item.name}
                    <br />
                    {!item.enabled
                      ? "設定で無効"
                      : !item.configured
                        ? "接続未設定"
                        : !known
                          ? "状態不明"
                          : paused
                            ? "収集オフ"
                            : data.quietHours
                              ? "夜間停止中"
                              : item.control?.running
                                ? "実行中"
                                : "待機"}
                  </td>
                  <td>
                    {known ? (
                      <button
                        type="button"
                        role="switch"
                        aria-label={`${item.name}の収集`}
                        aria-checked={collectionEnabled}
                        className="secondary-button crawl-collection-switch"
                        disabled={busy || !configured}
                        onClick={() =>
                          void control(item.shopKey, collectionEnabled ? "pause" : "resume")
                        }
                      >
                        <span className="crawl-switch-track" aria-hidden="true" />
                        {collectionEnabled ? "オン" : "オフ"}
                      </button>
                    ) : (
                      "未確認"
                    )}
                  </td>
                  <td>
                    {item.error ? (
                      <p role="alert">{item.error}</p>
                    ) : (
                      <>
                        {STAGES[item.control?.stage ?? "idle"] ?? item.control?.stage}
                        {item.control?.pagesFetched != null ? (
                          <p>
                            取得 {item.control.pagesFetched}ページ / 解析{" "}
                            {item.control.pagesParsed ?? "不明"}ページ
                            <br />
                            進捗日時 {dateText(item.control.progressAt)}
                          </p>
                        ) : null}
                        {item.control?.jobId ? (
                          <details>
                            <summary>実行ID</summary>
                            <code>{item.control.jobId}</code>
                          </details>
                        ) : null}
                      </>
                    )}
                    <p>
                      {paused || !configured ? "再開後の定期枠" : "次の定期枠"}:{" "}
                      {dateText(item.nextScheduledAt)}
                    </p>
                    {item.control?.nextAlarmAt ? (
                      <p>次ステップ: {dateText(item.control.nextAlarmAt)}</p>
                    ) : null}
                  </td>
                  <td>
                    {dateText(item.lastSuccessAt)}
                    <br />
                    {item.lastItemCount === null ? "取得件数は未記録" : `${item.lastItemCount}件`}
                    {item.lastItemCount !== null && item.previousItemCount !== null ? (
                      <p>
                        前回比 {item.lastItemCount - item.previousItemCount > 0 ? "+" : ""}
                        {item.lastItemCount - item.previousItemCount}件
                      </p>
                    ) : null}
                    <p>検索への反映完了: {dateText(item.lastProjectionAt)}</p>
                  </td>
                  <td>
                    {item.lastError ? (
                      <>
                        {item.lastError}
                        <p>
                          {dateText(item.lastErrorAt)} · 連続 {item.consecutiveFailures}回
                        </p>
                        {item.backoffUntil ? (
                          <p>再試行待機の目安: {dateText(item.backoffUntil)}</p>
                        ) : null}
                      </>
                    ) : (
                      "記録なし"
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !known || !collectionEnabled}
                      onClick={() => void control(item.shopKey, "run")}
                    >
                      {item.control?.running ? "途中から再実行" : "再実行"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        定期枠は予定です。収集オフ・夜間停止・既存の実行・接続設定によって開始が遅れる場合があります。自動更新は行わず、再読み込みと操作後に状態を取得します。
      </p>
    </section>
  );
}
