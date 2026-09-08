import { useEffect, useState } from "react";
import type {
  AdminQualityCommand,
  AdminQualityOverview,
  AdminQualityShopIssue,
  AdminQualityReportPage,
  AdminQualityCandidatePage,
  AdminQualitySamples,
} from "../src/api/admin-listing-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";
import { AdminListingDiagnosisPanel } from "./admin-listing-diagnosis.js";
import { correctionReportReasonLabel } from "./admin-correction-reports.js";
const request = <T,>(input: AdminQualityCommand) =>
  adminJson<T>("/api/admin/quality", { method: "POST", body: JSON.stringify(input) });
const kindNames = {
  manufacturer: "メーカー未確定",
  category: "未分類",
  identity_veto: "カタログ照合の拒否",
  identity_candidate: "カタログ照合の未確定候補",
};
const severityNames = {
  critical: "優先対応",
  warning: "要確認",
  healthy: "点検",
  unknown: "判定不明",
};
const severityOrder = { critical: 3, warning: 2, healthy: 1, unknown: 0 };
const stale = (at: string) => Date.now() - Date.parse(at) > 24 * 3_600_000;
function candidateUrl(row: AdminQualityCandidatePage["items"][number]) {
  const params = new URLSearchParams({ q: row.model });
  if (row.manufacturerId) params.set("manufacturerId", row.manufacturerId);
  return `/?${params}#candidates`;
}

export function AdminQualityPanel() {
  const [overview, setOverview] = useState<AdminQualityOverview | null>(null);
  const [reports, setReports] = useState<AdminQualityReportPage | null>(null);
  const [candidates, setCandidates] = useState<AdminQualityCandidatePage | null>(null);
  const [samples, setSamples] = useState<AdminQualitySamples | null>(null);
  const [sampleIssue, setSampleIssue] = useState<AdminQualityShopIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [shop, setShop] = useState("");
  const [sort, setSort] = useState("severity");
  const [diagnosing, setDiagnosing] = useState<number | null>(null);
  async function refresh() {
    setBusy(true);
    setErrors([]);
    const results = await Promise.allSettled([
      request<AdminQualityOverview>({ action: "overview" }).then(setOverview),
      request<AdminQualityReportPage>({ action: "reports" }).then(setReports),
      request<AdminQualityCandidatePage>({ action: "candidates" }).then(setCandidates),
    ]);
    setErrors(
      results.flatMap((row, i) =>
        row.status === "rejected"
          ? [
              `${["ショップ集計", "報告", "未検証候補"][i]}を取得できません。前回の表示がある場合は取得日時を確認してください。${genericErrorText(row.reason)}`,
            ]
          : [],
      ),
    );
    setBusy(false);
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function page(kind: "reports" | "candidates", first = false) {
    setBusy(true);
    setErrors([]);
    try {
      if (kind === "reports")
        setReports(
          await request<AdminQualityReportPage>({
            action: "reports",
            ...(!first && reports?.nextBefore ? { before: reports.nextBefore } : {}),
          }),
        );
      else
        setCandidates(
          await request<AdminQualityCandidatePage>({
            action: "candidates",
            ...(!first && candidates?.nextBefore ? { before: candidates.nextBefore } : {}),
          }),
        );
    } catch (reason) {
      setErrors([
        `次の情報を取得できません。前回の表示を保持しています。${genericErrorText(reason)}`,
      ]);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(issue: AdminQualityShopIssue, afterId = 0) {
    setBusy(true);
    setErrors([]);
    if (afterId === 0 || sampleIssue?.shopKey !== issue.shopKey || sampleIssue?.kind !== issue.kind)
      setSamples(null);
    setSampleIssue(issue);
    try {
      setSamples(
        await request<AdminQualitySamples>({
          action: "samples",
          shopKey: issue.shopKey,
          kind: issue.kind,
          afterId,
        }),
      );
    } catch (reason) {
      setErrors([genericErrorText(reason)]);
    } finally {
      setBusy(false);
    }
  }
  const issues = (overview?.issues ?? [])
    .filter((row) => !shop || row.shopKey === shop)
    .sort(
      (a, b) =>
        (sort === "count"
          ? b.count - a.count
          : severityOrder[b.severity] - severityOrder[a.severity]) || b.count - a.count,
    );
  return (
    <section className="panel workspace-panel" aria-label="優先度付き品質点検">
      <div className="panel-heading">
        <h2>優先度付き品質点検</h2>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          点検情報を再読み込み
        </button>
      </div>
      <p>
        保存済みの件数と報告を使って対応順を確認します。各欄の対象範囲と集計日時を確認してください。
      </p>
      {busy ? <p role="status">点検情報を確認しています…</p> : null}
      {errors.map((error) => (
        <p role="alert" key={error}>
          {error}
        </p>
      ))}
      <section aria-label="優先する誤り報告">
        <h3>優先する誤り報告</h3>
        <p>
          未対応のある対象商品・理由を、補正後の再報告数、未対応数、更新日時の順に最大25グループ表示します。再報告は再発が確認されたことを意味しません。
        </p>
        {reports ? (
          <>
            <p>
              取得日時 {dateText(reports.observedAt)}
              。報告数は保持期間内の値です。関連出品数は検索カードの保存値で、個別の集計日時は未記録です。
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>対象・理由</th>
                    <th>補正後の再報告</th>
                    <th>未対応 / 保持報告</th>
                    <th>関連出品</th>
                    <th>更新日時</th>
                    <th>対応</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.items.map((row) => (
                    <tr key={`${row.targetKey}:${row.reason}`}>
                      <td>
                        {[row.manufacturer, row.model].filter(Boolean).join(" ") || row.productKey}
                        <br />
                        <small>
                          {row.shopKey || "商品全体"} · {correctionReportReasonLabel(row.reason)}
                        </small>
                      </td>
                      <td>{row.recurrenceCount}件</td>
                      <td>
                        {row.openCount}件 / {row.reportCount}件
                      </td>
                      <td>
                        {row.relatedOfferCount === null ? "不明" : `${row.relatedOfferCount}件`}
                      </td>
                      <td>{dateText(row.updatedAt)}</td>
                      <td>
                        {row.reportId !== null ? (
                          <a href={`/?reportId=${row.reportId}#reports`}>
                            報告 #{row.reportId} を確認
                          </a>
                        ) : (
                          "報告が見つかりません"
                        )}
                        {row.listingId !== null ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setDiagnosing(row.listingId)}
                          >
                            判定理由を見る
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!reports.items.length ? <p>今回の範囲に未対応の報告はありません。</p> : null}
            <div className="pagination">
              <button type="button" disabled={busy} onClick={() => void page("reports", true)}>
                報告の先頭へ
              </button>
              <button
                type="button"
                disabled={busy || !reports.nextBefore}
                onClick={() => void page("reports")}
              >
                次の報告グループ
              </button>
            </div>
          </>
        ) : (
          <p>報告の点検情報は未取得です。</p>
        )}
      </section>
      <section aria-label="ショップ別の品質課題">
        <h3>ショップ別の品質課題</h3>
        {overview ? (
          <>
            <p>
              取得日時 {dateText(overview.observedAt)}
              。件数は各ショップの品質集計時点の稼働中商品です。
            </p>
            <label>
              点検するショップ
              <select value={shop} onChange={(event) => setShop(event.target.value)}>
                <option value="">全ショップ</option>
                {[...overview.snapshots, ...overview.missingShops].map((row) => (
                  <option key={row.shopKey} value={row.shopKey}>
                    {row.shopName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              課題の並び順
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="severity">重症度を優先</option>
                <option value="count">影響商品数が多い順</option>
              </select>
            </label>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>優先度</th>
                    <th>ショップ・課題</th>
                    <th>影響商品 / 集計対象</th>
                    <th>集計日時</th>
                    <th>確認</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((row) => (
                    <tr key={`${row.shopKey}:${row.kind}`}>
                      <td>{severityNames[row.severity]}</td>
                      <td>
                        {row.shopName}
                        <br />
                        {kindNames[row.kind]}
                      </td>
                      <td>
                        {row.count}件 / {row.total}件
                      </td>
                      <td>
                        {dateText(row.snapshotAt)}
                        {stale(row.snapshotAt) ? <p>24時間以上前の集計</p> : null}
                      </td>
                      <td>
                        <button type="button" disabled={busy} onClick={() => void inspect(row)}>
                          該当商品を確認
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!issues.length ? <p>選択範囲の保存済み集計に、件数のある課題はありません。</p> : null}
            <details>
              <summary>全ショップの集計日時と対象範囲</summary>
              <ul>
                {overview.snapshots.map((row) => (
                  <li key={row.shopKey}>
                    {row.shopName}: {row.total}件、{dateText(row.snapshotAt)}
                    {stale(row.snapshotAt) ? "（24時間以上前）" : ""}
                  </li>
                ))}
                {overview.missingShops.map((row) => (
                  <li key={row.shopKey}>{row.shopName}: 未集計・品質不明</li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p>ショップ集計は未取得です。</p>
        )}
        {sampleIssue ? (
          <section aria-label="課題の商品サンプル">
            <h4>
              {sampleIssue.shopName} / {kindNames[sampleIssue.kind]}
            </h4>
            <p>
              集計時点 {dateText(sampleIssue.snapshotAt)}
              。現在の商品を最大200件ずつ調べ、該当する最大20件を表示します。
            </p>
            {samples ? (
              <>
                <p>
                  今回の確認: {samples.scanned}件、該当: {samples.items.length}件。商品ID{" "}
                  {samples.afterId} より後、{samples.nextAfterId} まで。確認日時{" "}
                  {dateText(samples.observedAt)}
                </p>
                <ul>
                  {samples.items.map((row) => (
                    <li key={row.id}>
                      <strong>
                        #{row.id} {row.title}
                      </strong>
                      <p>
                        {row.manufacturer || "メーカー未確定"} / {row.model || "型番未確定"} /{" "}
                        {row.categoryId}
                      </p>
                      <button type="button" disabled={busy} onClick={() => setDiagnosing(row.id)}>
                        判定理由を見る
                      </button>{" "}
                      <a href={`/?listingId=${row.id}#extraction`}>抽出テストを開く</a>
                    </li>
                  ))}
                </ul>
                {!samples.items.length ? (
                  <p>
                    今回確認した範囲には該当商品がありません。
                    {samples.hasMore ? "続きの範囲を確認できます。" : ""}
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={busy || !samples.hasMore}
                  onClick={() => void inspect(sampleIssue, samples.nextAfterId)}
                >
                  次の商品範囲を確認
                </button>
              </>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void inspect(sampleIssue)}>
              商品確認を先頭からやり直す
            </button>
          </section>
        ) : null}
      </section>
      <section aria-label="優先する未検証候補">
        <h3>優先する未検証候補</h3>
        <p>稼働中商品と関連する未検証候補を、保存済みの優先度順に最大25件表示します。</p>
        {candidates ? (
          <>
            <p>取得日時 {dateText(candidates.observedAt)}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>候補</th>
                    <th>優先度</th>
                    <th>関連商品 / ショップ</th>
                    <th>更新日時</th>
                    <th>対応</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.manufacturer} {row.model}
                      </td>
                      <td>{row.priorityScore}</td>
                      <td>
                        {row.listingCount}件 / {row.shopCount}店
                      </td>
                      <td>{dateText(row.updatedAt)}</td>
                      <td>
                        <a href={candidateUrl(row)}>候補を確認</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!candidates.items.length ? <p>今回の範囲に未検証候補はありません。</p> : null}
            <div className="pagination">
              <button type="button" disabled={busy} onClick={() => void page("candidates", true)}>
                候補の先頭へ
              </button>
              <button
                type="button"
                disabled={busy || !candidates.nextBefore}
                onClick={() => void page("candidates")}
              >
                次の優先候補
              </button>
            </div>
          </>
        ) : (
          <p>未検証候補の点検情報は未取得です。</p>
        )}
      </section>
      {diagnosing !== null ? (
        <AdminListingDiagnosisPanel listingId={diagnosing} onClose={() => setDiagnosing(null)} />
      ) : null}
    </section>
  );
}
