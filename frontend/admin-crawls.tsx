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
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      setData(await adminJson<AdminCrawlOverview>("/api/admin/crawls"));
    } catch (reason) {
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
      await load();
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
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
        毎日23:00〜翌8:00（日本時間）は予定停止します。一時停止は途中位置を保持し、現在の1ステップが完了する場合があります。
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
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ショップ / 状態</th>
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
              return (
                <tr key={item.shopKey}>
                  <td>
                    {item.name}
                    <br />
                    {!item.enabled
                      ? "設定で無効"
                      : !item.configured
                        ? "接続未設定"
                        : paused
                          ? "手動停止中"
                          : data.quietHours
                            ? "夜間停止中"
                            : item.control?.running
                              ? "実行中"
                              : "待機"}
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
                      disabled={busy || !item.control}
                      onClick={() => void control(item.shopKey, paused ? "resume" : "pause")}
                    >
                      {paused ? "再開" : "一時停止"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !item.control || paused || !configured}
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
        定期枠は予定です。手動停止・夜間停止・既存の実行・接続設定によって開始が遅れる場合があります。自動更新は行わず、再読み込みと操作後に状態を取得します。
      </p>
    </section>
  );
}
