import { useEffect, useRef, useState } from "react";
import type {
  AdminModelFact,
  ModelFactInput,
  ModelFactsAdminSnapshot,
} from "../src/api/contracts.js";
import { adminJson, dateText, genericErrorText, safeSourceUrl } from "./admin-shared.js";

const EMPTY: ModelFactInput = {
  kind: "successor",
  relatedProductId: null,
  familyName: "",
  position: null,
  state: "candidate",
  sourceId: null,
  manualNote: "",
  manufacturerJustification: "",
};
const STATES = {
  candidate: "候補",
  verified: "確認済み",
  rejected: "却下",
  removed: "削除済み",
  due: "再確認待ち",
};
interface Candidate {
  id: number;
  canonicalName: string;
  canonicalModel: string;
  manufacturerId: string;
}

export function AdminModelRelations({
  productId,
  onClose,
}: {
  productId: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const choiceSequence = useRef(0);
  const loadSequence = useRef(0);
  const [snapshot, setSnapshot] = useState<ModelFactsAdminSnapshot | null>(null);
  const [editing, setEditing] = useState<AdminModelFact | null>(null);
  const [draft, setDraft] = useState<ModelFactInput>(EMPTY);
  const [status, setStatus] = useState("読み込んでいます…");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [relatedLabel, setRelatedLabel] = useState("");
  const [otherSources, setOtherSources] = useState<ModelFactsAdminSnapshot["sources"]>([]);
  const path = `/api/admin/knowledge-catalog/products/${productId}/model-facts`;
  const dirty = JSON.stringify(draft) !== JSON.stringify(editing?.input ?? EMPTY);
  const discard = () => !dirty || window.confirm("未保存の変更を破棄しますか？");
  const sources = [
    ...new Map(
      [...(snapshot?.sources ?? []), ...otherSources].map((source) => [source.id, source]),
    ).values(),
  ];

  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const value = await adminJson<ModelFactsAdminSnapshot>(path);
      if (alive.current && sequence === loadSequence.current) {
        setSnapshot(value);
        setStatus("");
      }
    } catch (error) {
      if (alive.current && sequence === loadSequence.current)
        setStatus(`取得に失敗しました: ${genericErrorText(error)}`);
    } finally {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    void load();
    return () => {
      alive.current = false;
      choiceSequence.current++;
      loadSequence.current++;
    };
  }, [path]);

  const reset = (fact: AdminModelFact | null) => {
    if (saving || !discard()) return;
    choiceSequence.current++;
    setEditing(fact);
    setDraft(fact?.input ?? EMPTY);
    setRelatedLabel(fact?.relatedProductName ?? "");
    setMatches([]);
    setOtherSources([]);
    setStatus("");
  };
  const close = () => {
    if (!saving && discard()) onClose();
  };
  const search = async () => {
    if (searching || !query.trim()) return;
    setSearching(true);
    try {
      const result = await adminJson<{ items: Candidate[] }>(
        `/api/admin/knowledge-catalog/products?${new URLSearchParams({ q: query.trim(), limit: "20" })}`,
      );
      if (alive.current) {
        setMatches(result.items.filter((item) => item.id !== (editing?.productId ?? productId)));
        setStatus(
          result.items.length
            ? "関係先の機種を選択してください。"
            : "該当する確認済み機種がありません。",
        );
      }
    } catch (error) {
      if (alive.current) setStatus(genericErrorText(error));
    } finally {
      if (alive.current) setSearching(false);
    }
  };
  const choose = async (product: Candidate) => {
    const sequence = ++choiceSequence.current;
    setDraft((current) => ({ ...current, relatedProductId: product.id }));
    setRelatedLabel(`${product.manufacturerId} ${product.canonicalName || product.canonicalModel}`);
    setMatches([]);
    setOtherSources([]);
    try {
      const result = await adminJson<ModelFactsAdminSnapshot>(
        `/api/admin/knowledge-catalog/products/${product.id}/model-facts`,
      );
      if (alive.current && sequence === choiceSequence.current) setOtherSources(result.sources);
    } catch (error) {
      if (alive.current && sequence === choiceSequence.current)
        setStatus(`関係先の出典を取得できませんでした: ${genericErrorText(error)}`);
    }
  };
  const save = async (input = draft, reverify = false, fact = editing) => {
    if (saving) return;
    setSaving(true);
    setStatus("保存しています…");
    try {
      const updated = await adminJson<ModelFactsAdminSnapshot>(path, {
        method: "POST",
        body: JSON.stringify({
          id: fact?.id ?? null,
          expectedVersion: fact?.version ?? null,
          reverify,
          fact: input,
        }),
      });
      if (!alive.current) return;
      choiceSequence.current++;
      setSnapshot(updated);
      setEditing(null);
      setDraft(EMPTY);
      setRelatedLabel("");
      setOtherSources([]);
      setStatus("機種の関係を保存しました。候補や再確認待ちの情報は公開されません。");
    } catch (error) {
      if (alive.current)
        setStatus(
          error instanceof Error && error.message === "model_fact_conflict_or_invalid"
            ? "保存できませんでした。最新の情報を再読込し、重複・循環・メーカー・出典の有効性を確認してください。入力内容は残しています。"
            : genericErrorText(error),
        );
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="model-relations-heading"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="edit-form">
        <div className="dialog-heading">
          <h2 id="model-relations-heading">機種の関係・シリーズ</h2>
          <button type="button" className="secondary-button" disabled={saving} onClick={close}>
            閉じる
          </button>
        </div>
        <p role="status">{status}</p>
        <button
          type="button"
          className="secondary-button"
          disabled={saving}
          onClick={() => {
            if (discard()) {
              setEditing(null);
              setDraft(EMPTY);
              void load();
            }
          }}
        >
          最新の情報を再読込
        </button>
        {loading ? <p>最新の関係を読み込んでいます…</p> : null}
        {snapshot && !loading ? (
          <>
            <p>
              {snapshot.product.manufacturerId} / {snapshot.product.name} (Catalog #{productId})
            </p>
            <p>機種の前後関係やシリーズだけを登録します。仕上げの色違いは登録対象になりません。</p>
            <h3>登録されている関係</h3>
            {snapshot.facts.length ? (
              <ul>
                {snapshot.facts.map((fact) => {
                  const source = safeSourceUrl(fact.sourceUrl);
                  return (
                    <li key={fact.id}>
                      <strong>
                        {fact.input.kind === "family"
                          ? `${fact.input.familyName}${fact.input.position === null ? "（順序不明）" : ` / 順序 ${fact.input.position}`}`
                          : `${fact.productName} ${fact.input.kind === "successor" ? "→" : "↔"} ${fact.relatedProductName}`}
                      </strong>
                      <p>
                        {STATES[fact.reviewState]} / 確認日: {dateText(fact.verifiedAt)} /
                        再確認期限: {dateText(fact.reviewDueAt)}
                      </p>
                      {source ? (
                        <a href={source} target="_blank" rel="noopener noreferrer">
                          確認に使用した出典
                        </a>
                      ) : null}
                      <p>{fact.input.manualNote}</p>
                      <button type="button" disabled={saving} onClick={() => reset(fact)}>
                        この関係を編集
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          if (
                            discard() &&
                            window.confirm("この関係を削除しますか？監査履歴は残ります。")
                          )
                            void save(
                              { ...fact.input, state: "removed", sourceId: null },
                              false,
                              fact,
                            );
                        }}
                      >
                        この関係を削除
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>関係情報はまだ登録されていません。</p>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => reset(null)}
            >
              新しい関係を入力
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h3>{editing ? "関係を編集" : "関係を追加"}</h3>
              {editing ? (
                <p>
                  元機種: {editing.productName} / 版: {editing.version}
                </p>
              ) : null}
              <fieldset disabled={saving}>
                <legend>関係と根拠</legend>
                <label>
                  関係の種類
                  <select
                    aria-label="関係の種類"
                    value={draft.kind}
                    onChange={(event) => {
                      const kind = event.currentTarget.value as ModelFactInput["kind"];
                      choiceSequence.current++;
                      setDraft((current) => ({
                        ...current,
                        kind,
                        relatedProductId: null,
                        familyName: "",
                        position: null,
                      }));
                      setRelatedLabel("");
                    }}
                  >
                    <option value="successor">後継機種（元機種 → 後継）</option>
                    <option value="variant">別仕様・バリエーション</option>
                    <option value="family">シリーズへの所属</option>
                  </select>
                </label>
                {draft.kind === "family" ? (
                  <>
                    <label>
                      シリーズ名
                      <input
                        value={draft.familyName}
                        maxLength={100}
                        required
                        onChange={(event) =>
                          setDraft({ ...draft, familyName: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label>
                      シリーズ内の順序（不明なら空欄）
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        step={1}
                        value={draft.position ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            position:
                              event.currentTarget.value === ""
                                ? null
                                : Number(event.currentTarget.value),
                          })
                        }
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      関係先の機種を検索
                      <input
                        value={query}
                        maxLength={100}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={searching || !query.trim()}
                      onClick={() => void search()}
                    >
                      機種を検索
                    </button>
                    <ul>
                      {matches.map((product) => (
                        <li key={product.id}>
                          <button type="button" onClick={() => void choose(product)}>
                            {product.manufacturerId} /{" "}
                            {product.canonicalName || product.canonicalModel} (#{product.id})
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p>
                      選択した機種:{" "}
                      {draft.relatedProductId
                        ? `${relatedLabel || "Catalog"} (#${draft.relatedProductId})`
                        : "未選択"}
                    </p>
                  </>
                )}
                <label>
                  確認に使う出典
                  <select
                    aria-label="確認に使う出典"
                    value={draft.sourceId ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        sourceId: event.currentTarget.value
                          ? Number(event.currentTarget.value)
                          : null,
                      })
                    }
                  >
                    <option value="">手動確認メモで記録する</option>
                    {draft.sourceId && !sources.some((source) => source.id === draft.sourceId) ? (
                      <option value={draft.sourceId}>登録済みの出典 #{draft.sourceId}</option>
                    ) : null}
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        #{source.id} {source.sourceType} / {source.status} / {source.url}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  確認内容・資料の説明
                  <textarea
                    value={draft.manualNote}
                    maxLength={1000}
                    minLength={
                      draft.state === "verified" && draft.sourceId === null ? 10 : undefined
                    }
                    required={draft.state === "verified" && draft.sourceId === null}
                    onChange={(event) =>
                      setDraft({ ...draft, manualNote: event.currentTarget.value })
                    }
                  />
                </label>
                <label>
                  メーカーが異なる場合の確認理由
                  <textarea
                    value={draft.manufacturerJustification}
                    maxLength={1000}
                    onChange={(event) =>
                      setDraft({ ...draft, manufacturerJustification: event.currentTarget.value })
                    }
                  />
                </label>
                <label>
                  確認状態
                  <select
                    aria-label="確認状態"
                    value={draft.state}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        state: event.currentTarget.value as ModelFactInput["state"],
                      })
                    }
                  >
                    <option value="candidate">候補（非公開）</option>
                    <option value="verified">確認済み</option>
                    <option value="rejected">却下（非公開）</option>
                  </select>
                </label>
                <p>
                  確認済みには有効な出典、または10文字以上の手動確認メモが必要です。出典の変更・失効や180日経過で再確認待ちになります。
                </p>
              </fieldset>
              <div className="dialog-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    saving || !dirty || (draft.kind !== "family" && !draft.relatedProductId)
                  }
                >
                  関係を保存
                </button>
                {editing && draft.state === "verified" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => void save(draft, true)}
                  >
                    根拠を再確認して更新
                  </button>
                ) : null}
              </div>
            </form>
            <details>
              <summary>最近20件の監査履歴</summary>
              {snapshot.audits.map((audit) => (
                <article key={audit.id}>
                  <h4>
                    {dateText(audit.occurredAt)} / {audit.actor}
                  </h4>
                  <details>
                    <summary>変更前と変更後</summary>
                    <pre>
                      {JSON.stringify({ before: audit.before, after: audit.after }, null, 2)}
                    </pre>
                  </details>
                </article>
              ))}
            </details>
          </>
        ) : null}
      </div>
    </dialog>
  );
}
