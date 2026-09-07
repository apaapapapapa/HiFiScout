import { useEffect, useRef, useState } from "react";
import { adminJson, genericErrorText } from "./admin-shared.js";

interface CoverageGroup {
  key: string;
  listings: number;
  condition: number;
  included: number;
  warranty: number;
  sale_unit: number;
}
interface Progress {
  ruleVersion: number;
  scannedCount: number;
  activeCount: number;
  completedAt: string | null;
  coverage: { byShop: CoverageGroup[]; byCategory: CoverageGroup[] };
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

  const run = async (steps: number) => {
    if (running.current) return;
    running.current = true;
    started.current = true;
    stop.current = false;
    setBusy(true);
    setStatus("再処理しています…");
    try {
      for (let step = 0; step < steps && !stop.current; step++) {
        const next = await adminJson<Progress>(PATH, { method: "POST", body: "{}" });
        if (!mounted.current) return;
        setProgress(next);
        setStatus(
          next.completedAt
            ? "再処理が完了しました。"
            : "進捗を保存しました。続きから再開できます。",
        );
        if (next.completedAt) break;
      }
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
      <p>保存済みの出品を1回最大25件ずつ処理します。店舗への再アクセスは行いません。</p>
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
        {busy ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              stop.current = true;
            }}
          >
            この処理の後で停止
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
                  <th>状態</th>
                  <th>付属品</th>
                  <th>保証</th>
                  <th>販売単位</th>
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
                    {(["condition", "included", "warranty", "sale_unit"] as const).map((group) => (
                      <td key={group}>
                        {row[group]} / {row.listings}
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
