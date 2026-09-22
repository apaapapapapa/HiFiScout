import { useEffect, useState } from "react";
import type {
  AuctionAdminCommand,
  AuctionAdminStatus,
} from "../src/api/admin-auction-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";
const blockers: Record<string, string> = {
  collection: "取得の許可",
  redistribution: "再表示の許可",
  robots: "robotsの確認",
  accountBudget: "アカウント予算の確認",
  sourceContract: "取得元仕様の確認",
};
const at = (value: number | null) => (value ? dateText(new Date(value).toISOString()) : "未設定");
export function AdminAuctions() {
  const [data, setData] = useState<AuctionAdminStatus | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reviewed, setReviewed] = useState(false);
  async function refresh() {
    const next = await adminJson<AuctionAdminStatus>("/api/admin/auctions");
    if (!next?.state || !next.access || !next.limits || !Array.isArray(next.categories))
      throw new Error("管理状態の応答を確認できません。");
    setData(next);
    setCategories(next.state.categories);
    setReviewed(false);
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      await refresh();
    } catch (reason) {
      setData(null);
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function control(command: AuctionAdminCommand) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await adminJson("/api/admin/auctions/control", {
        method: "POST",
        body: JSON.stringify(command),
      });
      setMessage("管理設定を保存しました。取得・公開の可否は現在の停止理由も確認してください。");
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      // Responses can be lost after a commit. Re-read before permitting another operation.
      try {
        await refresh();
      } catch (reason) {
        setData(null);
        setError((old) => [old, genericErrorText(reason)].filter(Boolean).join(" "));
      }
      setBusy(false);
    }
  }
  const button = (label: string, command: AuctionAdminCommand, disabled = false) => (
    <button type="button" disabled={busy || disabled} onClick={() => void control(command)}>
      {label}
    </button>
  );
  return (
    <section className="panel workspace-panel" aria-label="Yahoo!オークション管理">
      <div className="panel-heading">
        <h2>Yahoo!オークション</h2>
        <button type="button" disabled={busy} onClick={() => void load()}>
          状態を再読み込み
        </button>
      </div>
      <p>
        収集・検索・表示の設定は独立しています。再開しても、許可未確認・取得元停止・予算・夜間停止は解除されません。
      </p>
      {busy ? <p role="status">状態を確認しています…</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!data ? (
        <>
          <p role="status">保存済み状態は未確認です。取得件数・使用量を0とは判断できません。</p>
          <p>
            状態の読取りに失敗していても、予備枠から停止を試みられます。失敗時は配備設定の収集・検索・表示スイッチを無効にしてください。
          </p>
          <div className="auction-admin-actions">
            {button("収集を停止", { action: "pause" })}
            {button("公開を停止", { action: "public_pause" })}
          </div>
        </>
      ) : (
        <>
          <p>
            確認日時: {dateText(data.observedAt)} · 取得範囲:{" "}
            {data.state.coverage === "partial" ? "一部" : "未確認"}
          </p>
          <dl className="auction-admin-status">
            <div>
              <dt>収集設定</dt>
              <dd>
                {data.state.paused ? "管理停止中" : "管理停止なし"} /{" "}
                {data.access.collect ? "配備条件を満たす" : "配備条件により無効"}
              </dd>
            </div>
            <div>
              <dt>公開設定</dt>
              <dd>
                {data.state.publicPaused ? "管理停止中" : "管理停止なし"} / API{" "}
                {data.access.search ? "有効" : "無効"} / UI {data.access.display ? "有効" : "無効"}
              </dd>
            </div>
            <div>
              <dt>未解決の前提条件</dt>
              <dd>
                {data.access.blockers
                  .map((key) =>
                    data.access.deniedBlockers?.includes(key)
                      ? key === "robots"
                        ? "robotsによる取得拒否（取得経路の見直しが必要）"
                        : `${blockers[key] || key}：拒否`
                      : blockers[key] || key,
                  )
                  .join("、") || "なし"}
              </dd>
            </div>
            <div>
              <dt>夜間停止</dt>
              <dd>
                {data.quietHours ? `予定停止中（${dateText(data.quietEndsAt)}まで）` : "時間外"} ·
                毎日23:00〜翌08:00 JST
              </dd>
            </div>
            <div>
              <dt>取得元の停止理由</dt>
              <dd>{data.state.halt || "保存された停止理由なし"}</dd>
            </div>
            <div>
              <dt>次の実行予定 / バックオフ</dt>
              <dd>
                {at(data.nextAlarm)} / {at(data.state.backoffUntil)}
              </dd>
            </div>
            <div>
              <dt>最終成功 / 失敗</dt>
              <dd>
                {data.state.lastSuccessAt ? dateText(data.state.lastSuccessAt) : "成功観測なし"} /{" "}
                {data.state.lastFailure || "保存された失敗なし"}
              </dd>
            </div>
            <div>
              <dt>保存 / 待機 / 試行上限</dt>
              <dd>
                {data.retainedItems}件 / {data.pendingTasks}件 / {data.exhaustedTasks}件
              </dd>
            </div>
            <div>
              <dt>終了確認待ち / 確認タスク</dt>
              <dd>
                {data.endCheckPending}件 / {data.confirmationTasks}件
              </dd>
            </div>
            <div>
              <dt>カタログ再判定</dt>
              <dd>
                {data.catalogPendingKeys}候補キー · 次回 {at(data.catalogNext)} ·{" "}
                {data.catalogError || "保存された失敗なし"}
              </dd>
            </div>
          </dl>
          <div className="auction-admin-actions">
            {button("収集を停止", { action: "pause" }, data.state.paused)}
            {button(
              "収集を再開",
              { action: "resume" },
              !data.access.collect || !!data.state.halt || !data.state.paused,
            )}
            {button("公開を停止", { action: "public_pause" }, data.state.publicPaused)}
            {button(
              "公開を再開",
              { action: "public_resume" },
              !data.access.search || !data.state.publicPaused,
            )}
            {button(
              "実行予定を修復",
              { action: "wake" },
              !data.access.collect || data.state.paused || !!data.state.halt,
            )}
            {button(
              "試行上限のタスクを再登録",
              { action: "retry_failed" },
              !data.access.collect ||
                data.state.paused ||
                !!data.state.halt ||
                !data.exhaustedTasks,
            )}
          </div>
          <fieldset className="auction-admin-fieldset" disabled={busy}>
            <legend>収集対象カテゴリ</legend>
            {data.categories.map((category) => (
              <label key={category.id}>
                <input
                  type="checkbox"
                  checked={categories.includes(category.id)}
                  onChange={(e) =>
                    setCategories((old) =>
                      e.target.checked
                        ? [...old, category.id]
                        : old.filter((id) => id !== category.id),
                    )
                  }
                />
                {category.label}
              </label>
            ))}
            {button("対象カテゴリを保存", { action: "wake", categories })}
          </fieldset>
          {data.state.halt ? (
            <fieldset className="auction-admin-fieldset" disabled={busy}>
              <legend>取得元の停止解除</legend>
              <p>
                取得元の許可・制限・仕様を再確認し、必要な修正を配備してから解除してください。収集の管理停止中にだけ解除できます。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                停止原因の確認と対応を完了した
              </label>
              {button(
                "確認済みの停止理由を解除",
                { action: "clear_halt", reviewed: true },
                !reviewed || !data.state.paused || !data.access.collect,
              )}
            </fieldset>
          ) : null}
          <h3>当日予算の予約量</h3>
          <p>
            UTC日単位（09:00
            JSTリセット）。予約は保守的な上限で、実際の課金使用量は未計測です。通常処理は上限の
            {Math.round((1 - data.limits.recoveryReserveRatio) * 100)}
            %までとし、残りを確認・停止・復旧に確保します。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>項目</th>
                  <th>予約量</th>
                  <th>暫定上限</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["DO呼出し", data.state.reserved.requests, data.limits.doRequestsPerUtcDay],
                    [
                      "公開読取り",
                      data.state.reserved.publicRequests,
                      data.limits.publicRequestsPerUtcDay,
                    ],
                    [
                      "取得元へのリクエスト",
                      data.state.reserved.sellerRequests,
                      data.limits.sellerRequestsPerUtcDay,
                    ],
                    ["新着ページ", data.state.reserved.pages, data.limits.listingPagesPerUtcDay],
                    ["新規出品", data.state.reserved.newItems, data.limits.newItemsPerUtcDay],
                    ["SQLite読取り行", data.state.reserved.reads, data.limits.rowsReadPerUtcDay],
                    [
                      "SQLite書込み行",
                      data.state.reserved.writes,
                      data.limits.rowsWrittenPerUtcDay,
                    ],
                    [
                      "Alarm操作",
                      data.state.reserved.alarmOperations,
                      data.limits.alarmOperationsPerUtcDay,
                    ],
                    [
                      "経過時間 GB-s",
                      data.state.reserved.durationGbSeconds,
                      data.limits.durationGbSecondsPerUtcDay,
                    ],
                  ] as const
                ).map(([label, used, limit]) => (
                  <tr key={label}>
                    <td data-label="項目">{label}</td>
                    <td data-label="予約量">{used.toLocaleString("ja-JP")}</td>
                    <td data-label="暫定上限">{limit.toLocaleString("ja-JP")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            保存サイズ: {data.storageBytes.toLocaleString("ja-JP")} bytes / 暫定上限{" "}
            {data.limits.storedBytes.toLocaleString("ja-JP")}{" "}
            bytes。アカウント全体の残容量は未確認です。
          </p>
        </>
      )}
    </section>
  );
}
