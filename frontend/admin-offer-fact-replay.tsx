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
const PATH = "/api/admin/offer-facts/replay";

export function AdminOfferFactReplay({
  shops,
  categories,
  active = true,
  revision = 0,
}: {
  active?: boolean;
  revision?: number;
  shops: readonly { key: string; name: string }[];
  categories: readonly { id: string; name: string }[];
}) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState("進捗を読み込んでいます…");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [scope, setScope] = useState<"byShop" | "byCategory">("byShop");
  const stop = useRef(false);
  const running = useRef(false);
  const loadedRevision = useRef<number | null>(null);
  const mounted = useRef(true);
  const jobId = useRef<string | null>(null);
  const [submittedJob, setSubmittedJob] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, []);
  useEffect(() => {
    if (!active || busy || submitting || loadedRevision.current === revision) return;
    let cancelled = false;
    void adminJson<Progress | null>(PATH)
      .then((value) => {
        if (cancelled) return;
        loadedRevision.current = revision;
        setProgress(value);
        setStatus(
          value?.completedAt ? "再処理は完了しています。" : "保存済みの情報から再処理できます。",
        );
      })
      .catch((error) => {
        if (!cancelled) setStatus(`取得できませんでした: ${genericErrorText(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [active, revision, busy, submitting]);

  const run = async (steps: number) => {
    if (running.current) return;
    running.current = true;
    loadedRevision.current = revision;
    stop.current = false;
    setBusy(true);
    setStopping(false);
    const runningStatus = "再処理しています…";
    setStatus(runningStatus);
    try {
      for (let step = 0; step < steps && !stop.current; step++) {
        const next = await adminJson<Progress>(PATH, { method: "POST", body: "{}" });
        if (!mounted.current) return;
        setProgress(next);
        if (next.completedAt) {
          setStatus("再処理が完了しました。");
          return;
        }
        if (!stop.current) setStatus(runningStatus);
      }
      if (mounted.current)
        setStatus(
          stop.current
            ? "停止しました。保存済みの続きから再開できます。"
            : "進捗を保存しました。続きから再開できます。",
        );
    } catch (error) {
      if (mounted.current)
        setStatus(`中断しました。再開時は保存済みの続きから処理します: ${genericErrorText(error)}`);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const startBackground = async () => {
    if (busy || submitting) return;
    loadedRevision.current = revision;
    jobId.current ||= crypto.randomUUID();
    setSubmitting(true);
    try {
      const job = await submitAdminReplayJob(jobId.current);
      jobId.current = job.id;
      setSubmittedJob(job.id);
      setStatus(
        job.status === "queued" || job.status === "running"
          ? "再処理を受け付けました。画面を閉じても処理は続きます。"
          : "既存の処理があります。現在の状態は処理一覧で確認してください。",
      );
    } catch (error) {
      setStatus(
        `受付を確認できませんでした。同じ処理として再試行できます: ${genericErrorText(error)}`,
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="panel table-panel" aria-labelledby="offer-replay-heading">
      <h2 id="offer-replay-heading">出品条件の再処理・充足率</h2>
      <p>
        保存済みの全商品（掲載終了を含む）を1回最大25件ずつ処理します。店舗への再アクセスは行わず、手動修正は保持します。
      </p>
      <p>
        「全商品を再処理」は保存済みの続きから処理します。受付完了後は画面を閉じても継続し、処理一覧から停止・再開できます。
      </p>
      <p role="status">{status}</p>
      {submittedJob ? (
        <p>
          <a href={`/?jobId=${submittedJob}#jobs`}>処理一覧で進捗と結果を確認</a>
        </p>
      ) : null}
      <p>
        {progress
          ? `処理済み ${progress.scannedCount}件 / うち掲載中 ${progress.activeCount}件`
          : "未実行"}
      </p>
      <div className="button-row">
        <button
          className="secondary-button"
          type="button"
          disabled={busy || submitting || !!submittedJob || Boolean(progress?.completedAt)}
          onClick={() => void run(1)}
        >
          最大25件を再処理
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={busy || submitting || !!submittedJob || Boolean(progress?.completedAt)}
          onClick={() => void run(20)}
        >
          最大500件を再処理
        </button>
        <button
          type="button"
          disabled={busy || submitting || !!submittedJob || Boolean(progress?.completedAt)}
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
        {busy ? (
          <button
            type="button"
            className="secondary-button"
            disabled={stopping}
            onClick={() => {
              stop.current = true;
              setStopping(true);
              setStatus("実行中の25件以内の処理が終わり次第、停止します…");
            }}
          >
            {stopping ? "停止しています…" : "この処理の後で停止"}
          </button>
        ) : null}
      </div>
      {progress ? (
        <>
          <p>
            再処理した掲載中の出品のうち、店舗の明記がある件数です。「なし」の明記も含みます。完了前は途中集計です。
          </p>
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
                        : categories.find((category) => category.id === row.key)?.name) || row.key}
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
    </section>
  );
}
