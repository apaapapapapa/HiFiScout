import { useEffect, useRef, useState } from "react";
import type {
  AdminJobList,
  AdminJobDetail,
  AdminJobStatus,
} from "../src/api/admin-csv-contracts.js";
import { adminJobRequest, submitAdminReplayJob } from "./admin-job-client.js";
import { dateText, genericErrorText } from "./admin-shared.js";

const LABELS: Record<AdminJobStatus, string> = {
  uploading: "データ送信中",
  queued: "実行待ち",
  running: "実行中",
  paused: "一時停止",
  completed: "完了",
  failed: "要確認",
  cancelled: "中止",
};

export function AdminJobsPanel({ onDataChanged }: { onDataChanged: () => void }) {
  const replayId = useRef<string | null>(null);
  const seenProgress = useRef(new Map<string, { processed: number; failed: number }>());
  const [list, setList] = useState<AdminJobList | null>(null);
  const [before, setBefore] = useState<string | undefined>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [detail, setDetail] = useState<AdminJobDetail | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function remember(value: AdminJobList) {
    const changed = value.items.some((job) => {
      const previous = seenProgress.current.get(job.id);
      return (
        job.processed > (previous?.processed ?? 0) ||
        (previous !== undefined && job.failed < previous.failed)
      );
    });
    value.items.forEach((job) =>
      seenProgress.current.set(job.id, { processed: job.processed, failed: job.failed }),
    );
    setList(value);
    if (changed) onDataChanged();
  }
  async function refresh(cursor: string | undefined) {
    setBusy(true);
    setError("");
    try {
      remember(
        await adminJobRequest<AdminJobList>({
          action: "list",
          ...(cursor ? { before: cursor } : {}),
        }),
      );
      setBefore(cursor);
      if (detail)
        setDetail(
          await adminJobRequest<AdminJobDetail>({ action: "get", id: detail.job.id, failedOnly }),
        );
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function show(id: string, after?: number, onlyFailed = failedOnly) {
    setBusy(true);
    setError("");
    try {
      setDetail(
        await adminJobRequest<AdminJobDetail>({
          action: "get",
          id,
          failedOnly: onlyFailed,
          ...(after !== undefined ? { after } : {}),
        }),
      );
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        const id = new URLSearchParams(window.location.search).get("jobId");
        const [jobs, result] = await Promise.all([
          adminJobRequest<AdminJobList>({ action: "list" }),
          id ? adminJobRequest<AdminJobDetail>({ action: "get", id }) : Promise.resolve(null),
        ]);
        if (!cancelled) {
          remember(jobs);
          setDetail(result);
        }
      } catch (reason) {
        if (!cancelled) setError(genericErrorText(reason));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  async function control(id: string, action: "start" | "pause" | "resume" | "retry" | "cancel") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await adminJobRequest({ action, id });
      setMessage(
        action === "cancel"
          ? "処理を中止しました。適用済みの変更は保持されています。"
          : action === "pause"
            ? "停止を保存しました。実行中の1件は完了する場合があります。"
            : "続きの実行を予約しました。",
      );
      await refresh(before);
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function startModelReplay() {
    setBusy(true);
    setError("");
    setMessage("");
    replayId.current ||= crypto.randomUUID();
    try {
      const job = await submitAdminReplayJob(replayId.current, "model");
      replayId.current = null;
      setMessage(
        job.status === "queued" || job.status === "running"
          ? "型番の一括再判定を受け付けました。画面を閉じても継続します。"
          : "同じ判定ルールの処理があります。処理一覧から状態を確認して再開してください。",
      );
      setHistory([]);
      await refresh(undefined);
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel workspace-panel" aria-label="バックグラウンド処理一覧">
      <section aria-label="型番の一括再判定">
        <h2>型番の一括再判定</h2>
        <p>
          判定ルールの更新後、掲載中の旧バージョン商品を保存済み情報から再判定します。
          メーカー・カテゴリ・商品照合と検索表示も更新し、手動修正は保持します。
        </p>
        <p>少量ずつ完了まで継続します。進捗確認・一時停止・再開は下の処理一覧から行えます。</p>
        {list?.modelResolverVersion !== undefined ? (
          <p>現在の型番判定ルール: v{list.modelResolverVersion}</p>
        ) : null}
        <button
          type="button"
          disabled={busy || !list}
          onClick={() => {
            if (
              window.confirm(
                "掲載中の旧バージョン商品を一括再判定します。手動修正は保持され、画面を閉じても継続します。開始しますか？",
              )
            )
              void startModelReplay();
          }}
        >
          旧バージョンの商品を一括再判定
        </button>
      </section>
      <div className="panel-heading">
        <h2>処理一覧</h2>
        <button type="button" disabled={busy} onClick={() => void refresh(before)}>
          進捗を再読み込み
        </button>
      </div>
      <p>
        送信が完了した処理は画面を閉じても継続します。更新日時と進捗は保存済みの情報です。必要なときに再読み込みしてください。
      </p>
      {busy || message ? (
        <p role="status">
          {busy ? "処理の状態を確認しています… " : ""}
          {message}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {list?.items.length === 0 ? (
        <p>
          処理の記録はありません。型番の一括再判定、CSV入出力または出品条件の再処理から開始できます。
        </p>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>処理 / 作成日時</th>
              <th>状態 / 更新日時</th>
              <th>進捗</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list?.items.map((job) => (
              <tr key={job.id}>
                <td>
                  {job.label}
                  <br />
                  {dateText(job.createdAt)}
                  <details>
                    <summary>処理ID</summary>
                    <code>{job.id}</code>
                  </details>
                </td>
                <td>
                  {LABELS[job.status]}
                  <br />
                  {dateText(job.updatedAt)}
                  {job.error ? <p>{job.error}</p> : null}
                </td>
                <td>
                  {job.kind === "csv" ? (
                    <>
                      <p>
                        送信 {job.uploaded} / {job.total}件
                      </p>
                      <p>
                        処理済み {job.processed} / {job.total}件 · 失敗 {job.failed}件
                      </p>
                    </>
                  ) : job.modelReplay ? (
                    <>
                      <p>
                        確認済み {job.modelReplay.scanned}件 · 対象処理済み {job.processed}件
                      </p>
                      <p>型番判定ルール v{job.modelReplay.version}</p>
                    </>
                  ) : (
                    <p>
                      {job.kind === "manufacturer" ? "確認済み" : "処理済み"} {job.processed}件
                    </p>
                  )}
                  {!job.detailsAvailable ? <p>詳細の保持期限が切れています。</p> : null}
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void show(job.id)}
                  >
                    結果を見る
                  </button>
                  {["queued", "running"].includes(job.status) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void control(job.id, "pause")}
                    >
                      一時停止
                    </button>
                  ) : null}
                  {job.status === "paused" ||
                  job.status === "running" ||
                  (job.status === "failed" && (job.kind !== "csv" || job.processed < job.total)) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !job.detailsAvailable}
                      onClick={() => void control(job.id, "resume")}
                    >
                      続きから再開
                    </button>
                  ) : null}
                  {job.status === "uploading" && job.uploaded === job.total ? (
                    <button
                      type="button"
                      disabled={busy || !job.detailsAvailable}
                      onClick={() => void control(job.id, "start")}
                    >
                      送信済みの処理を開始
                    </button>
                  ) : null}
                  {job.status === "uploading" && job.uploaded < job.total ? (
                    <p>元のCSV画面で送信を再開するか、中止してファイルを読み込み直してください。</p>
                  ) : null}
                  {job.kind === "csv" &&
                  job.failed > 0 &&
                  job.processed === job.total &&
                  ["completed", "failed"].includes(job.status) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !job.detailsAvailable}
                      onClick={() => void control(job.id, "retry")}
                    >
                      失敗した対象だけ再試行
                    </button>
                  ) : null}
                  {!["completed", "cancelled"].includes(job.status) ? (
                    <button
                      type="button"
                      className="tertiary-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "未処理の対象を中止します。適用済みの変更は残ります。中止しますか？",
                          )
                        )
                          void control(job.id, "cancel");
                      }}
                    >
                      中止
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button
          type="button"
          disabled={busy || !history.length}
          onClick={() => {
            const previous = history.at(-1);
            setHistory(history.slice(0, -1));
            void refresh(previous);
          }}
        >
          前の処理
        </button>
        <button
          type="button"
          disabled={busy || !list?.nextBefore}
          onClick={() => {
            setHistory([...history, before]);
            void refresh(list!.nextBefore!);
          }}
        >
          以前の処理
        </button>
      </div>
      {detail ? (
        <section aria-label="処理結果">
          <h3>{detail.job.label} の結果</h3>
          <p>
            更新日時 {dateText(detail.job.updatedAt)} · 詳細保持期限{" "}
            {dateText(detail.job.expiresAt)}
          </p>
          {detail.job.kind === "csv" ? (
            <label>
              <input
                type="checkbox"
                checked={failedOnly}
                disabled={busy}
                onChange={(event) => {
                  setFailedOnly(event.target.checked);
                  void show(detail.job.id, undefined, event.target.checked);
                }}
              />
              失敗した対象のみ表示
            </label>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>対象</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((row) => (
                  <tr key={row.ordinal}>
                    <td>
                      {row.result
                        ? `${row.result.line}行 / ${row.result.kind === "listing" ? "登録商品" : "カタログ"} #${row.result.id ?? "新規"}`
                        : `対象 ${row.ordinal + 1}`}
                    </td>
                    <td>{row.result?.message ?? "未処理"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!detail.items.length ? (
            <p>
              {detail.job.kind === "model"
                ? "確認済み件数は保存済み商品の探索範囲です。旧バージョンの商品と検索表示の更新待ちを処理します。対象処理済みには、クロールなどで先に更新された商品も含みます。"
                : detail.job.kind === "manufacturer"
                  ? "確認済み件数は候補の探索範囲です。該当商品だけを最新の辞書で再判定しました。"
                  : detail.job.kind === "replay"
                    ? "充足率の集計は出品条件の再処理画面で確認できます。"
                    : "表示できる詳細はありません。"}
            </p>
          ) : null}
          <div className="pagination">
            <button
              type="button"
              disabled={busy || !detail.items.length || detail.items[0].ordinal === 0}
              onClick={() => void show(detail.job.id)}
            >
              結果の先頭へ
            </button>
            <button
              type="button"
              disabled={busy || detail.nextAfter === null}
              onClick={() => void show(detail.job.id, detail.nextAfter!)}
            >
              次の結果
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
