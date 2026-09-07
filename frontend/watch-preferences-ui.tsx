import { useEffect, useRef, useState } from "react";
import { normalizePrice } from "./public-ui-state.js";
import type { DisplayProduct } from "./types.js";
import type { WatchPreference } from "./watch-preferences.js";
import { yen } from "./format.js";

export function WatchSummary({
  product,
  preference,
}: {
  product: DisplayProduct;
  preference: WatchPreference;
}) {
  const offer = product.representative_offer;
  const targetMet =
    preference.targetPriceYen !== null &&
    offer?.stock_status === "in_stock" &&
    offer.price_yen !== null &&
    offer.price_yen <= preference.targetPriceYen;
  return (
    <div className="watch-summary">
      {preference.targetPriceYen !== null ? (
        <p>
          希望価格 {yen.format(preference.targetPriceYen)}以下
          {targetMet ? " · 表示中の出品が希望価格以下" : ""}
        </p>
      ) : null}
      {preference.note ? <p className="watch-note">メモ：{preference.note}</p> : null}
    </div>
  );
}

export function WatchPreferenceEditor({
  product,
  preference,
  onSave,
  onClose,
}: {
  product: DisplayProduct;
  preference: WatchPreference | undefined;
  onSave: (target: number | null, note: string, expectedUpdatedAt: string | null) => boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const initial = useRef(preference);
  const initialTarget =
    initial.current?.targetPriceYen == null ? "" : String(initial.current.targetPriceYen);
  const initialNote = initial.current?.note ?? "";
  const [target, setTarget] = useState(initialTarget);
  const [note, setNote] = useState(initialNote);
  const [error, setError] = useState("");
  const normalized = normalizePrice(target);
  const dirty = normalized !== initialTarget || note !== initialNote;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const close = () => {
    if (!dirty || window.confirm("保存していない希望価格・メモを破棄しますか？")) onClose();
  };
  return (
    <dialog
      ref={ref}
      className="watch-editor"
      aria-labelledby="watch-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2 id="watch-editor-title">希望価格・検討メモ</h2>
      <p>
        {product.manufacturer} {product.model}
      </p>
      <p>この端末だけに保存されます。希望価格は出品価格の目安です。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized === null || [...note].length > 1000) {
            setError("希望価格またはメモを確認してください。");
            return;
          }
          if (
            onSave(normalized ? Number(normalized) : null, note, initial.current?.updatedAt ?? null)
          )
            onClose();
          else
            setError(
              "保存できませんでした。別タブの変更、保存容量・設定、または登録上限200件を確認してください。入力内容は残しています。",
            );
        }}
      >
        <label>
          希望価格（円）
          <input
            aria-label="希望価格（円）"
            value={target}
            maxLength={40}
            inputMode="decimal"
            placeholder="例: 12.5万円"
            onChange={(event) => setTarget(event.currentTarget.value)}
          />
        </label>
        {normalized === null ? <p role="alert">0〜999,999,999,999円で入力してください。</p> : null}
        <label>
          検討メモ
          <textarea
            aria-label="検討メモ"
            value={note}
            maxLength={2000}
            rows={5}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <p>{[...note].length}/1000文字</p>
        <p role="alert">{error}</p>
        <button type="submit" disabled={!dirty || normalized === null || [...note].length > 1000}>
          希望価格・メモを保存
        </button>
        <button type="button" onClick={close}>
          閉じる
        </button>
      </form>
    </dialog>
  );
}
