import { useEffect, useState } from "react";
import type { AdminOperations, AdminCrawlOverview } from "../src/api/admin-listing-contracts.js";
import type { AdminJobList } from "../src/api/admin-csv-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";
import { adminJobRequest } from "./admin-job-client.js";

const amount = (n: number | null | undefined) => (n == null ? "未集計" : n.toLocaleString("ja-JP"));
const quantity = (n: number | null | undefined, unit: string) =>
  n == null ? "未集計" : `${amount(n)}${unit}`;
const stale = (at: string, hours: number) => Date.now() - Date.parse(at) > hours * 3_600_000;
const sum = (rows: { requests: number | null }[]) =>
  rows.some((row) => row.requests === null) ? null : rows.reduce((n, row) => n + row.requests!, 0);

export function AdminOperationsPanel() {
  const [data, setData] = useState<AdminOperations | null>(null);
  const [crawls, setCrawls] = useState<AdminCrawlOverview | null>(null);
  const [jobs, setJobs] = useState<AdminJobList | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [operation, setOperation] = useState("");
  const [process, setProcess] = useState("");
  const [shop, setShop] = useState("");
  async function refresh() {
    setBusy(true);
    setErrors([]);
    const results = await Promise.allSettled([
      adminJson<AdminOperations>("/api/admin/operations").then(setData),
      adminJson<AdminCrawlOverview>("/api/admin/crawls").then(setCrawls),
      adminJobRequest<AdminJobList>({ action: "list" }).then(setJobs),
    ]);
    setErrors(
      results.flatMap((result, i) =>
        result.status === "rejected"
          ? [`${["集計", "ショップ", "処理"][i]}: ${genericErrorText(result.reason)}`]
          : [],
      ),
    );
    setBusy(false);
  }
  useEffect(() => {
    void refresh();
  }, []);
  const sql = data?.sql;
  const runtime = data?.runtime;
  const rankings = [
    ...new Map(
      [...(sql?.topReads ?? []), ...(sql?.topWrites ?? [])].map((row) => [row.fingerprint, row]),
    ).values(),
  ];
  const failures = [
    ...(crawls?.items ?? [])
      .filter((row) => row.lastError)
      .map((row) => ({
        id: row.shopKey,
        process: "crawl",
        shop: row.shopKey,
        label: row.name,
        message: row.lastError!,
        at: row.lastErrorAt,
        href: "/#crawls",
        state: row.consecutiveFailures ? "失敗継続" : "その後に成功",
      })),
    ...(jobs?.items ?? [])
      .filter((row) => row.status === "failed" || row.failed > 0)
      .map((row) => ({
        id: row.id,
        process: row.kind,
        shop: "",
        label: row.label,
        message: row.error || `${row.failed}件の対象で失敗しています。`,
        at: row.updatedAt,
        href: `/?jobId=${row.id}#jobs`,
        state: row.status === "failed" ? "要確認" : "処理中",
      })),
  ].filter((row) => (!process || row.process === process) && (!shop || row.shop === shop));
  return (
    <section className="panel workspace-panel" aria-label="負荷・稼働状況">
      <div className="panel-heading">
        <h2>負荷・稼働状況</h2>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          保存済み情報を再読み込み
        </button>
      </div>
      <p>
        集計済みの情報を表示します。自動更新は行いません。各欄の取得日時と対象期間を確認してください。
      </p>
      {busy ? <p role="status">状態を確認しています…</p> : null}
      {errors.map((error) => (
        <p role="alert" key={error}>
          {error}
        </p>
      ))}
      {data?.unavailable.length ? (
        <p role="alert">取得できない集計: {data.unavailable.join("、")}</p>
      ) : null}
      <section aria-label="本番バージョンと反映状況">
        <h3>本番バージョンと反映状況</h3>
        <p>
          応答中のバージョン: <code>{data?.version.id ?? "取得できません"}</code> · 確認日時{" "}
          {dateText(data?.observedAt)}
        </p>
        {data?.version.tag ? <p>バージョンタグ: {data.version.tag}</p> : null}
        {runtime?.deployment ? (
          <>
            <p>
              main <code>{runtime.deployment.targetSha.slice(0, 12)}</code>:{" "}
              {
                {
                  deferred: "D1使用量制限により反映保留",
                  success: "デプロイ処理完了（変更なしを含む）",
                  failure: "デプロイ処理に失敗",
                  pending: "反映結果を確認中",
                }[runtime.deployment.state]
              }
            </p>
            <p>
              状態記録日時 {dateText(runtime.deployment.updatedAt)} · 取得日時{" "}
              {dateText(runtime.generatedAt)}
            </p>
            {runtime.deployment.state === "deferred" ? (
              <p>
                使用量のリセット後に再試行されます。現在応答中のバージョンは上記を確認してください。
              </p>
            ) : null}
            {runtime.deployment.runUrl ? (
              <a href={runtime.deployment.runUrl} target="_blank" rel="noreferrer">
                反映処理を確認
              </a>
            ) : null}
          </>
        ) : (
          <p>mainの反映状況は未取得です。</p>
        )}
      </section>
      <section aria-label="D1の保存済み集計">
        <h3>D1の読み書き</h3>
        <p>
          読み取り {quantity(sql?.observedTotals.rowsRead, "行")} · 書き込み{" "}
          {quantity(sql?.observedTotals.rowsWritten, "行")} · SQL実行{" "}
          {quantity(sql?.observedTotals.count, "回")}
        </p>
        {sql ? (
          <>
            <p>
              集計日時 {dateText(sql.generatedAt)} · 対象 {dateText(sql.requestedHours[0])} 〜{" "}
              {dateText(
                sql.requestedHours.length
                  ? new Date(Date.parse(sql.requestedHours.at(-1)!) + 3_600_000).toISOString()
                  : null,
              )}{" "}
              · 欠測 {sql.missingHours.length}時間
            </p>
            {stale(sql.generatedAt, 8) ? (
              <p role="status">集計が8時間以上更新されていません。</p>
            ) : null}
            <p>
              Cloudflareが観測したSQLグループの集計です。課金明細や全実行の総数とは一致しない場合があります。ショップ別の使用量はこの統計から判定できません。
            </p>
            <details>
              <summary>時間別の集計と対象範囲</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>対象時間</th>
                      <th>取得日時</th>
                      <th>読み取り行</th>
                      <th>書き込み行</th>
                      <th>範囲</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sql.hours.map((hour) => (
                      <tr key={hour.windowStart}>
                        <td>{dateText(hour.windowStart)}</td>
                        <td>{dateText(hour.collectedAt)}</td>
                        <td>{amount(hour.totals.rowsRead)}</td>
                        <td>{amount(hour.totals.rowsWritten)}</td>
                        <td>
                          {hour.provisional ? "時間途中" : "時間終了後"}
                          {hour.limited ? " · 一部グループのみ" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sql.missingHours.length ? (
                <p>欠測: {sql.missingHours.map(dateText).join("、")}</p>
              ) : null}
            </details>
            <label>
              SQL種別{" "}
              <select value={operation} onChange={(event) => setOperation(event.target.value)}>
                <option value="">すべて</option>
                {[...new Set(rankings.map((row) => row.operation))].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SQL識別子 / 種別</th>
                    <th>読み取り行</th>
                    <th>書き込み行</th>
                    <th>累計SQL時間（ms）</th>
                  </tr>
                </thead>
                <tbody>
                  {rankings
                    .filter((row) => !operation || row.operation === operation)
                    .map((row) => (
                      <tr key={row.fingerprint}>
                        <td>
                          <code title={row.fingerprint}>{row.fingerprint.slice(0, 16)}</code> /{" "}
                          {row.operation}
                        </td>
                        <td>{amount(row.rowsRead)}</td>
                        <td>{amount(row.rowsWritten)}</td>
                        <td>{amount(row.durationMs)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p>読み取り・書き込みそれぞれ上位20件の識別子です。SQL本文は管理画面へ送信しません。</p>
          </>
        ) : (
          <p>集計は未取得です。使用量ゼロを意味しません。</p>
        )}
      </section>
      <section aria-label="CPU超過と実行失敗">
        <h3>CPU超過と実行失敗</h3>
        {runtime ? (
          <>
            <p>
              取得日時 {dateText(runtime.generatedAt)} · 対象 {dateText(runtime.windowStart)} 〜{" "}
              {dateText(runtime.windowEnd)}
            </p>
            {stale(runtime.generatedAt, 1) ? (
              <p role="status">実行統計が1時間以上更新されていません。</p>
            ) : null}
            <p>
              Cloudflareの実行統計です。抽出された標本を含み、ショップや個別処理への対応は記録されていません。
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>CPU超過</th>
                    <th>状態別の実行件数</th>
                  </tr>
                </thead>
                <tbody>
                  {runtime.workerStats.map((worker) => (
                    <tr key={worker.worker}>
                      <td>{worker.worker}</td>
                      <td>
                        {amount(
                          worker.available && !worker.limitHit && worker.statuses.length
                            ? sum(worker.statuses.filter((row) => row.status === "exceededCpu"))
                            : null,
                        )}
                      </td>
                      <td>
                        {worker.available
                          ? worker.statuses.length
                            ? worker.statuses
                                .map((row) => `${row.status}: ${amount(row.requests)}件`)
                                .join(" / ")
                            : "未観測"
                          : "取得できません"}
                        {worker.limitHit ? "（取得上限に到達）" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p>実行統計は未取得です。</p>
        )}
      </section>
      <section aria-label="ショップ・処理別の失敗">
        <h3>ショップ・処理別の失敗</h3>
        <p>
          各ショップの最終失敗と、最近25件のバックグラウンド処理を表示します。期間内の全失敗件数ではありません。
        </p>
        <p>ショップ状態の確認日時 {dateText(crawls?.observedAt)}</p>
        <label>
          処理{" "}
          <select value={process} onChange={(event) => setProcess(event.target.value)}>
            <option value="">すべて</option>
            <option value="crawl">クロール</option>
            <option value="csv">CSV取込</option>
            <option value="replay">出品条件再処理</option>
            <option value="manufacturer">メーカー再判定</option>
            <option value="model">型番・カテゴリ再判定</option>
          </select>
        </label>{" "}
        <label>
          ショップ{" "}
          <select value={shop} onChange={(event) => setShop(event.target.value)}>
            <option value="">すべて</option>
            {crawls?.items.map((row) => (
              <option key={row.shopKey} value={row.shopKey}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>対象</th>
                <th>記録日時</th>
                <th>状態・理由</th>
                <th>詳細</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td>{dateText(row.at)}</td>
                  <td>
                    {row.state}: {row.message}
                  </td>
                  <td>
                    <a href={row.href}>処理を確認</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!failures.length && crawls && jobs ? (
          <p>この表示範囲に該当する失敗記録はありません。</p>
        ) : null}
        <p>
          <a href="/#jobs">以前の処理を確認</a> · <a href="/#crawls">ショップ別の進捗を確認</a>
        </p>
      </section>
    </section>
  );
}
