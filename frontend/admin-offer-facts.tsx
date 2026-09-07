import { useEffect, useRef, useState } from "react";
import { OFFER_FACT_DEFINITIONS } from "../src/api/contracts.js";
import type { OfferFact } from "../src/api/contracts.js";
import { adminJson, genericErrorText, safeSourceUrl } from "./admin-shared.js";

interface Snapshot {
  listingId: number;
  title: string;
  conditionText: string;
  sourceUrl: string;
  facts: OfferFact[];
}

export function AdminOfferFacts({ listingId, onClose }: { listingId: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("読み込んでいます…");
  const [saving, setSaving] = useState(false);
  const path = `/api/admin/listings/${listingId}/offer-facts`;
  const manual = new Map(
    (snapshot?.facts ?? []).filter((fact) => fact.source === "manual").map((fact) => [fact.factId, fact.state]),
  );
  const changes = Object.fromEntries(
    OFFER_FACT_DEFINITIONS
      .filter((fact) => draft[fact.id] !== undefined && draft[fact.id] !== (manual.get(fact.id) ?? "inherit"))
      .map((fact) => [fact.id, draft[fact.id]]),
  );
  const dirty = Object.keys(changes).length > 0;

  useEffect(() => {
    let cancelled = false;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    void adminJson<Snapshot>(path).then((data) => {
      if (!cancelled) {
        setSnapshot(data);
        setStatus("");
      }
    }).catch((error) => {
      if (!cancelled) setStatus(`取得に失敗しました: ${genericErrorText(error)}`);
    });
    return () => { cancelled = true; };
  }, [path]);

  const close = () => {
    if (saving || (dirty && !window.confirm("未保存の変更を破棄しますか？"))) return;
    onClose();
  };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setStatus("保存しています…");
    try {
      const updated = await adminJson<Snapshot>(path, { method: "PATCH", body: JSON.stringify(changes) });
      setSnapshot(updated);
      setDraft({});
      setStatus("出品の条件を保存しました。");
    } catch (error) {
      setStatus(`保存に失敗しました: ${genericErrorText(error)}`);
    } finally {
      setSaving(false);
    }
  };
  const source = safeSourceUrl(snapshot?.sourceUrl ?? "");
  return (
    <dialog ref={dialog} aria-labelledby="offer-fact-editor-heading"
      onClose={onClose} onCancel={(event) => { event.preventDefault(); close(); }}>
      <form className="edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="dialog-heading">
          <h2 id="offer-fact-editor-heading">出品の条件を修正</h2>
          <button type="button" className="secondary-button" disabled={saving} onClick={close}>閉じる</button>
        </div>
        <p role="status">{status}</p>
        {snapshot ? <>
          <p>{snapshot.title}</p>
          <p>店舗の状態表記: {snapshot.conditionText || "記載なし"}</p>
          {source ? <a href={source} target="_blank" rel="noopener noreferrer">販売店の記載を確認</a> : null}
          <p>「自動判定に戻す」は手動補正を解除します。「不明」は自動判定より優先されます。</p>
          <fieldset disabled={saving}>
            <legend>状態・付属品・保証・販売単位</legend>
            {OFFER_FACT_DEFINITIONS.map((definition) => {
              const seller = snapshot.facts.find((fact) => fact.factId === definition.id && fact.source === "seller");
              return <label key={definition.id}>
                <span>{definition.name}</span>
                <select aria-label={definition.name} value={draft[definition.id] ?? manual.get(definition.id) ?? "inherit"}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((previous) => ({ ...previous, [definition.id]: value }));
                  }}>
                  <option value="inherit">自動判定に戻す</option>
                  <option value="present">あり（確認済み）</option>
                  <option value="absent">なし（確認済み）</option>
                  <option value="unknown">不明</option>
                </select>
                <small>店舗の記載: {seller?.state === "present" ? "あり" : seller?.state === "absent" ? "なし" : "不明"}</small>
              </label>;
            })}
          </fieldset>
          <button type="submit" className="primary-button" disabled={saving || !dirty}>出品条件を保存</button>
        </> : null}
      </form>
    </dialog>
  );
}
