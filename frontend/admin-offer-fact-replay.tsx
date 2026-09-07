import { useEffect, useRef, useState } from "react";
import { adminJson, genericErrorText } from "./admin-shared.js";
import { OFFER_FACT_GROUPS } from "../src/api/contracts.js";
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
}: {
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
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void adminJson<Progress | null>(PATH)
      .then((value) => {
        if (mounted.current && !started.current) {
          setProgress(value);
          setStatus(
            value?.completedAt ? "再処理は完了しています。" : "保存済みの情報から再処理できます。",
          );
        }
      })
      .catch((error) => {
        if (mounted.current && !started.current)
          setStatus(`取得できませんでした: ${genericErrorText(error)}`);
      });
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, []);

  const run = async (steps: number | "all") => {
    if (running.current) return;
    running.current = true;
    started.current = true;
    stop.current = false;
    setBusy(true);
    setStopping(false);
    const runningStatus =
      steps === "all" ? "全商品を再処理しています…（25件ずつ）" : "再処理しています…";
    setStatus(runningStatus);
    let previousCount = progress?.scannedCount ?? 0;
    let unchangedSteps = 0;
    try {
      for (let step = 0; (steps === "all" || step < steps) && !stop.current; step++) {
        const next = await adminJson<Progress>(PATH, { method: "POST", body: "{}" });
        if (!mounted.current) return;
        setProgress(next);
        if (next.completedAt) {
          setStatus("再処理が完了しました。");
          return;
        }
        // A fenced server step can make no progress. Do not spin indefinitely under contention.
        unchangedSteps = next.scannedCount > previousCount ? 0 : unchangedSteps + 1;
        previousCount = next.scannedCount;
        if (steps === "all" && unchangedSteps >= 3 && !stop.current) {
          throw new Error("進捗が更新されないため停止しました。少し待ってから再開してください。");
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
  return (
    <section className="panel table-panel" aria-labelledby="offer-replay-heading">
      <h2 id="offer-replay-heading">出品条件の再処理・充足率</h2>
      <p>
        保存済みの全商品（掲載終了を含む）を1回最大25件ずつ処理します。店舗への再アクセスは行わず、手動修正は保持します。
      </p>
      <p>
        「全商品を再処理」は保存済みの続きから完了まで自動で処理します。実行中はこのタブを開いたままにしてください。停止・タブを閉じた後も続きから再開できます。
      </p>
      <p role="status">{status}</p>
      <p>
        {progress
          ? `処理済み ${progress.scannedCount}件 / うち掲載中 ${progress.activeCount}件`
          : "未実行"}
      </p>
      <div className="button-row">
        <button
          className="secondary-button"
          type="button"
          disabled={busy || Boolean(progress?.completedAt)}
          onClick={() => void run(1)}
        >
          最大25件を再処理
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={busy || Boolean(progress?.completedAt)}
          onClick={() => void run(20)}
        >
          最大500件を再処理
        </button>
        <button
          type="button"
          disabled={busy || Boolean(progress?.completedAt)}
          onClick={() => {
            if (
              window.confirm(
                "全商品（掲載終了を含む）の出品条件を、保存済みの続きから完了まで再処理します。手動修正は保持します。実行中はこのタブを開いたままにしてください。開始しますか？",
              )
            )
              void run("all");
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
