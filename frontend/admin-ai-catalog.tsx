import { useEffect, useState } from "react";
import type {
  AiAdminCommand,
  AiCatalogDetail,
  AiCatalogPage,
  AiJobStatus,
  AiReviewOutcome,
} from "../src/api/admin-ai-contracts.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";

const LABELS: Record<AiJobStatus, string> = {
  suggested: "提案あり",
  no_suggestion: "判断できない",
  deferred: "保留",
  queued: "実行待ち",
  processing: "判定中",
  invalid: "出力を採用できない",
  stale: "情報が変更された",
  failed: "処理失敗",
  reviewed: "確認済み",
};
const OUTCOMES: Record<AiReviewOutcome, string> = {
  useful: "役に立った",
  incorrect: "誤り",
  insufficient_evidence: "証拠不足",
};
const call = <T,>(command: AiAdminCommand) =>
  adminJson<T>("/api/admin/ai-catalog", { method: "POST", body: JSON.stringify(command) });

export function AdminAiCatalog() {
  const [status, setStatus] = useState<AiJobStatus>("suggested");
  const [cursor, setCursor] = useState<AiCatalogPage["next"]>(null);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<AiCatalogPage | null>(null);
  const [detail, setDetail] = useState<AiCatalogDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [candidateId, setCandidateId] = useState(
    () => new URLSearchParams(window.location.search).get("candidateId") || "",
  );
  const [allowance, setAllowance] = useState("1000");
  const [evidence, setEvidence] = useState("");
  const [accounted, setAccounted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError("");
    setPage(null);
    void call<AiCatalogPage>({ action: "list", status, before: cursor })
      .then((value) => {
        if (!cancelled) setPage(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(genericErrorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [status, cursor, revision]);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setRevision((v) => v + 1);
    } catch (reason) {
      setError(genericErrorText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function review(outcome: AiReviewOutcome) {
    if (!detail) return;
    await call({ action: "review", id: detail.job.id, outcome });
    setDetail(await call<AiCatalogDetail>({ action: "detail", id: detail.job.id }));
    setNotice("提案の評価を記録しました。商品情報の変更は、既存のVerifyで別途確認します。");
  }
  const selected = detail?.snapshot?.candidates.find(
    (c) => c.id === detail.suggestion?.catalogProductId,
  );
  return (
    <div>
      <p>
        未解決の型番について、カタログ候補と根拠を確認します。提案の評価を記録した後、必要な修正をVerifyで確認してください。
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section className="panel">
        <h2>実行状況と当日の予算</h2>
        {page ? (
          <>
            <p>
              <strong>{page.enabled ? "AI判定を有効化済み" : "AI判定は停止中"}</strong> ·
              実モデル評価 {page.evaluationApproved ? "承認済み" : "未承認"}
            </p>
            {page.budget ? (
              <p>
                {page.budget.day}（UTC）: 予約 {page.budget.reserved.toFixed(3)} /{" "}
                {page.budget.allowance} Neurons · {page.budget.startedJobs} / 25 候補 ·{" "}
                {page.budget.blocked ? "当日の実行を停止" : "予算を設定済み"}
              </p>
            ) : (
              <p>当日の予算は未設定です。AI呼び出しは保留されます。</p>
            )}
            <p className="identity-note">
              無料枠はアカウント全体で共有されます。ここに表示する予算は本機能の予約額で、Cloudflare全体の残量ではありません。切り替わりは日本時間9時です。
            </p>
            <details>
              <summary>当日の予算を設定・停止する</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await call({
                      action: "grant",
                      allowanceNeurons: Number(allowance),
                      evidence,
                      checkedAt: new Date().toISOString(),
                      otherConsumersAccountedFor: true,
                    });
                    setNotice(
                      "当日の予算を記録しました。実モデル評価と有効化の条件も満たすまでAIは動作しません。",
                    );
                  });
                }}
              >
                <label>
                  本機能に確保した無料容量（1〜1,000 Neurons）
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={allowance}
                    onChange={(e) => setAllowance(e.target.value)}
                    required
                    disabled={busy || Boolean(page.budget)}
                  />
                </label>
                <label>
                  確認の記録
                  <textarea
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    maxLength={900}
                    required
                    placeholder="Cloudflareの当日使用量と、他のAI利用に確保した上限"
                    disabled={busy || Boolean(page.budget)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={accounted}
                    onChange={(e) => setAccounted(e.target.checked)}
                    disabled={busy || Boolean(page.budget)}
                  />
                  アカウントの当日使用量と他のAI利用を確認し、この無料容量を確保しました。
                </label>
                <button type="submit" disabled={busy || !accounted || Boolean(page.budget)}>
                  当日予算を記録
                </button>
              </form>
              <button
                type="button"
                disabled={busy || !page.budget || page.budget.blocked}
                onClick={() =>
                  void act(async () => {
                    await call({ action: "block" });
                    setNotice("当日のAI実行を停止しました。");
                  })
                }
              >
                当日のAI実行を停止
              </button>
              <p>記録済みの予算は当日中に増やせません。利用量が不明な処理の予約額も残ります。</p>
            </details>
          </>
        ) : (
          <p role="status">読み込み中…</p>
        )}
      </section>
      <section className="panel">
        <h2>候補をAI判定へ送る</h2>
        <p>公式情報の検証が完了した未解決候補を1件ずつ選びます。同じ証拠の結果は再利用されます。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const result = await call<{ id: string }>({
                action: "prepare",
                candidateId: Number(candidateId),
              });
              setDetail(await call<AiCatalogDetail>({ action: "detail", id: result.id }));
              setNotice(
                "候補を準備しました。保留中の場合は、有効化と予算を確認して「当日の予算で再開」を選んでください。",
              );
            });
          }}
        >
          <label>
            未検証候補ID
            <input
              type="number"
              min="1"
              step="1"
              value={candidateId}
              onChange={(e) => setCandidateId(e.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            候補を準備
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>提案一覧</h2>
        <label>
          状態
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as AiJobStatus);
              setCursor(null);
            }}
            disabled={busy}
          >
            {Object.entries(LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => setRevision((v) => v + 1)}>
          再読み込み
        </button>
        {page?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>候補</th>
                  <th>状態</th>
                  <th>試行</th>
                  <th>更新</th>
                  <th>確認</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      #{job.candidateId} {job.manufacturerId} {job.model}
                      <br />
                      {job.title}
                    </td>
                    <td>{LABELS[job.status]}</td>
                    <td>{job.attempts} / 2</td>
                    <td>{dateText(job.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setDetail(
                              await call<AiCatalogDetail>({ action: "detail", id: job.id }),
                            );
                          })
                        }
                      >
                        根拠を確認
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : page ? (
          <p>この状態の提案はありません。</p>
        ) : null}
        <button type="button" disabled={busy || !cursor} onClick={() => setCursor(null)}>
          先頭へ
        </button>
        <button
          type="button"
          disabled={busy || !page?.next}
          onClick={() => setCursor(page?.next || null)}
        >
          次の20件
        </button>
      </section>
      {detail ? (
        <section className="panel" aria-label="AI提案の詳細">
          <h2>候補 #{detail.job.candidateId} の根拠</h2>
          <p>
            <strong>{LABELS[detail.job.status]}</strong> ·{" "}
            {detail.fresh
              ? "現在の証拠と一致"
              : "証拠またはカタログが変わっています。再確認が必要です。"}
          </p>
          <p>
            販売店の型番: {detail.snapshot?.target.model}
            <br />
            代表タイトル: {detail.snapshot?.target.title}
          </p>
          {detail.job.error === "no_safe_candidate" ? (
            <p>既存ルールで候補を除外しました。AIは実行していません。</p>
          ) : null}
          <p>
            AIの候補:{" "}
            {selected
              ? `${selected.manufacturerId} ${selected.model}（Catalog #${selected.id}）`
              : "候補なし"}
          </p>
          {detail.suggestion?.evidence.length ? (
            <ul>
              {detail.suggestion.evidence.map((span, index) => (
                <li key={index}>
                  <q>{span}</q>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="identity-note">
            代表タイトルだけでグループ全体を確定しないでください。本体・付属品・セットの違いと公式の型番を、Verifyで確認します。
          </p>
          {detail.snapshot ? (
            <details>
              <summary>提示したカタログ候補をすべて表示</summary>
              <ul>
                {detail.snapshot.candidates.map((c) => (
                  <li key={c.id}>
                    #{c.id} {c.model} · {c.categoryIds.join(", ")}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {detail.job.error ? <p>保留・検証理由: {detail.job.error}</p> : null}
          {detail.attempts.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>試行</th>
                    <th>予約 / 実測 Neurons</th>
                    <th>入力 / 出力 tokens</th>
                    <th>時間</th>
                    <th>結果</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.attempts.map((attempt) => (
                    <tr key={attempt.ordinal}>
                      <td>{attempt.ordinal}</td>
                      <td>
                        {(attempt.reservedMilli / 1000).toFixed(3)} /{" "}
                        {attempt.actualMilli === null
                          ? "不明"
                          : (attempt.actualMilli / 1000).toFixed(3)}
                      </td>
                      <td>
                        {attempt.inputTokens ?? "不明"} / {attempt.outputTokens ?? "不明"}
                      </td>
                      <td>{attempt.latencyMs === null ? "不明" : `${attempt.latencyMs} ms`}</td>
                      <td>{attempt.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {(["suggested", "no_suggestion"] as AiJobStatus[]).includes(detail.job.status) ? (
            <div>
              {Object.entries(OUTCOMES).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  disabled={busy || !detail.fresh}
                  onClick={() => void act(() => review(key as AiReviewOutcome))}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {detail.job.reviewOutcome ? (
            <p>記録した評価: {OUTCOMES[detail.job.reviewOutcome as AiReviewOutcome]}</p>
          ) : null}
          {detail.handoffUrl ? (
            <a className="button" href={detail.handoffUrl}>
              未検証候補を開いてVerifyする
            </a>
          ) : null}
          {detail.job.status === "deferred" ? (
            <button
              type="button"
              disabled={
                busy ||
                !detail.fresh ||
                detail.job.attempts >= 2 ||
                !page?.enabled ||
                !page.budget ||
                page.budget.blocked
              }
              onClick={() =>
                void act(async () => {
                  await call({ action: "retry", id: detail.job.id });
                  setDetail(await call<AiCatalogDetail>({ action: "detail", id: detail.job.id }));
                })
              }
            >
              当日の予算で再開
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
