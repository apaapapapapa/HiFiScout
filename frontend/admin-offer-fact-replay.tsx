import { useEffect, useRef, useState } from "react";
import { adminJson, genericErrorText } from "./admin-shared.js";
import { OFFER_FACT_GROUPS } from "../src/api/contracts.js";
import { submitAdminReplayJob } from "./admin-job-client.js";
import type { OfferFactCoverageRow } from "../src/api/contracts.js";
interface Progress {
  ruleVersion: number;
  scannedCount: number;
  activeCount: number;
  completedAt: string | null;
  coverage: { byShop: OfferFactCoverageRow[]; byCategory: OfferFactCoverageRow[] };
}
interface CoverageMeta {
  shops?: { key: string; name: string }[];
  categoryFacets: { id: string; name: string }[];
}
const PATH = "/api/admin/offer-facts/replay";

export function AdminOfferFactReplay({
  active,
  revision,
  onSubmitted,
}: {
  active: boolean;
  revision: number;
  onSubmitted: () => void;
}) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState("進捗を読み込んでいます…");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [scope, setScope] = useState<"byShop" | "byCategory">("byShop");
  const jobId = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedJob, setSubmittedJob] = useState<string | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [meta, setMeta] = useState<CoverageMeta | null>(null);
  const [metaError, setMetaError] = useState("");
  const [metaAttempt, setMetaAttempt] = useState(0);
  const shops = meta?.shops ?? [];
  const categories = meta?.categoryFacets ?? [];

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setReady(false);
    void adminJson<Progress | null>(PATH)
      .then((value) => {
        if (cancelled) return;
        setProgress(value);
        setReady(true);
        setError("");
        if (value?.completedAt) setStatus("再処理は完了しています。");
        else if (!submittedJob) setStatus("保存済みの情報から再処理できます。");
      })
      .catch((reason) => {
        if (!cancelled) setError(`進捗を取得できませんでした: ${genericErrorText(reason)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [active, revision, attempt]);

  useEffect(() => {
    if (!active || !coverageOpen || meta) return;
    let cancelled = false;
    setMetaError("");
    void adminJson<CoverageMeta>("/api/meta")
      .then((value) => {
        if (!cancelled) setMeta(value);
      })
      .catch((reason) => {
        if (!cancelled) setMetaError(genericErrorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [active, coverageOpen, meta, metaAttempt]);

  const startBackground = async () => {
    if (!ready || submitting) return;
    jobId.current ||= crypto.randomUUID();
    setSubmitting(true);
    setError("");
    try {
      const job = await submitAdminReplayJob(jobId.current);
      jobId.current = job.id;
      setSubmittedJob(job.id);
      setStatus(
        job.status === "queued" || job.status === "running"
          ? "再処理を受け付けました。画面を閉じても処理は続きます。"
          : "既存の処理があります。現在の状態は下の処理一覧で確認してください。",
      );
      onSubmitted();
    } catch (reason) {
      setError(
        `受付を確認できませんでした。同じ処理として再試行できます: ${genericErrorText(reason)}`,
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="model-replay-launch" aria-label="出品条件の再処理・充足率">
      <h2>出品条件の再処理</h2>
      <p>
        保存済みの全商品（掲載終了を含む）の出品条件を再判定します。店舗への再アクセスは行わず、手動修正は保持します。
      </p>
      <p>
        保存済みの続きから少量ずつ処理します。受付後は画面を閉じても継続し、下の処理一覧から停止・再開できます。
      </p>
      <p role="status">{status}</p>
      {error ? <p role="alert">{error}</p> : null}
      {submittedJob ? (
        <p>
          <a href={`/?jobId=${submittedJob}#jobs`}>処理一覧で進捗と結果を確認</a>
        </p>
      ) : null}
      <button
        type="button"
        disabled={!ready || submitting || !!submittedJob || Boolean(progress?.completedAt)}
        onClick={() => {
          if (
            window.confirm(
              "全商品（掲載終了を含む）の出品条件を、保存済みの続きから完了まで再処理します。手動修正は保持します。受付後は画面を閉じても継続します。開始しますか？",
            )
          )
            void startBackground();
        }}
      >
        全商品を再処理
      </button>
      {!ready && error ? (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          出品条件の進捗を再取得
        </button>
      ) : null}
      <details
        className="admin-offer-coverage"
        open={coverageOpen}
        onToggle={(event) => setCoverageOpen(event.currentTarget.open)}
      >
        <summary>出品条件の充足率を確認</summary>
        <p>
          {progress
            ? `処理済み ${progress.scannedCount}件 / うち掲載中 ${progress.activeCount}件`
            : ready
              ? "未実行"
              : "進捗は未取得です。"}
        </p>
        <p>
          再処理した掲載中の出品のうち、店舗の明記がある件数です。「なし」の明記も含みます。完了前は途中集計です。
        </p>
        {metaError ? (
          <p role="alert">
            表示名を取得できませんでした: {metaError}{" "}
            <button type="button" onClick={() => setMetaAttempt((value) => value + 1)}>
              表示名を再取得
            </button>
          </p>
        ) : null}
        {progress ? (
          <>
            <label>
              集計単位{" "}
              <select
                value={scope}
                onChange={(event) =>
                  setScope(event.currentTarget.value === "byCategory" ? "byCategory" : "byShop")
                }
              >
                <option value="byShop">店舗別</option>
                <option value="byCategory">カテゴリ別</option>
              </select>
            </label>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>区分</th>
                    <th>掲載中</th>
                    {OFFER_FACT_GROUPS.map((group) => (
                      <th key={group.id}>{group.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {progress.coverage[scope].map((row) => (
                    <tr key={row.key}>
                      <th>
                        {(scope === "byShop"
                          ? shops.find((shop) => shop.key === row.key)?.name
                          : categories.find((category) => category.id === row.key)?.name) ||
                          row.key}
                      </th>
                      <td>{row.listings}</td>
                      {OFFER_FACT_GROUPS.map((group) => (
                        <td key={group.id} data-label={group.name}>
                          {row[group.id] == null ? "未集計" : `${row[group.id]} / ${row.listings}`}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </details>
    </section>
  );
}
