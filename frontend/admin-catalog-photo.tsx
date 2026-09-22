import { useEffect, useRef, useState } from "react";
import {
  isCatalogPhotoSnapshot,
  parseCatalogPhoto,
  safePhotoUrl,
} from "../src/api/catalog-photo-contracts.js";
import type { CatalogPhoto, CatalogPhotoSnapshot } from "../src/api/catalog-photo-contracts.js";
import { CatalogPhoto as Photo } from "./catalog-photo.js";
import { adminJson } from "./admin-shared.js";

const EMPTY: CatalogPhoto = { imageUrl: "", sourceUrl: "", credit: "" };

export function AdminCatalogPhoto({
  productId,
  name,
  onClose,
}: {
  productId: number;
  name: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<CatalogPhotoSnapshot | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("読み込んでいます…");
  const path = `/api/admin/knowledge-catalog/products/${productId}/photo`;
  const valid = parseCatalogPhoto(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot?.photo ?? EMPTY);
  useEffect(() => {
    let active = true;
    dialog.current?.showModal();
    void adminJson<unknown>(path)
      .then((data) => {
        if (!active) return;
        if (!isCatalogPhotoSnapshot(data)) throw new Error("invalid_response");
        setSnapshot(data);
        setDraft(data.photo ?? EMPTY);
        setStatus("");
      })
      .catch(() => {
        if (active) setStatus("写真の登録情報を取得できませんでした。閉じて開き直してください。");
      });
    return () => {
      active = false;
    };
  }, [path]);
  const close = () => {
    if (busy || (dirty && snapshot && !window.confirm("未保存の写真を破棄しますか？"))) return;
    onClose();
  };
  const save = async (photo: CatalogPhoto | null) => {
    if (!snapshot) return;
    setBusy(true);
    setStatus("");
    try {
      const data = await adminJson<unknown>(path, {
        method: "PATCH",
        body: JSON.stringify({ photo, expectedRevision: snapshot.revision }),
      });
      if (!isCatalogPhotoSnapshot(data)) throw new Error("invalid_response");
      setSnapshot(data);
      setDraft(data.photo ?? EMPTY);
      setCandidates([]);
      setStatus(
        photo
          ? "写真を登録しました。公開画面を再読み込みしてください。キャッシュにより反映が少し遅れる場合があります。"
          : "写真の掲載を取り消しました。",
      );
    } catch (error) {
      setStatus(
        error instanceof Error && error.message === "catalog_photo_conflict"
          ? "別の操作で写真が更新されています。閉じて開き直し、最新の内容を確認してください。"
          : "保存できませんでした。内容を保持しているので、再度お試しください。",
      );
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    setBusy(true);
    setCandidates([]);
    setStatus("");
    try {
      const result = await adminJson<{ sourceUrl: string; imageUrls: string[] }>(
        `${path}/candidates`,
        {
          method: "POST",
          body: JSON.stringify({ sourceUrl: draft.sourceUrl }),
        },
      );
      const sourceUrl = safePhotoUrl(result.sourceUrl);
      if (
        !sourceUrl ||
        !Array.isArray(result.imageUrls) ||
        result.imageUrls.length > 8 ||
        result.imageUrls.some((url) => !safePhotoUrl(url))
      )
        throw new Error("invalid_response");
      setDraft((value) => ({ ...value, sourceUrl }));
      setCandidates(result.imageUrls);
      setStatus(
        result.imageUrls.length
          ? "候補を選び、型番・色・出典を確認して登録してください。"
          : "候補が見つかりませんでした。画像URLを直接入力できます。",
      );
    } catch (error) {
      setStatus(
        error instanceof Error && error.message === "catalog_photo_source_not_official"
          ? "候補取得は登録済みのメーカー公式サイトに対応しています。別の公式サイトの写真は画像URLを直接入力してください。"
          : "公式ページから取得できませんでした。画像URLを直接入力するか、再度お試しください。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="admin-editor"
      aria-labelledby="catalog-photo-heading"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        className="edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void save(valid);
        }}
      >
        <div className="dialog-heading">
          <h2 id="catalog-photo-heading">{name} のメーカー写真</h2>
          <button type="button" disabled={busy} onClick={close}>
            閉じる
          </button>
        </div>
        <p>
          この機種のメーカー写真を1枚掲載します。メーカーが案内する画像と出典を指定してください。
        </p>
        <fieldset disabled={!snapshot || busy}>
          <label>
            メーカー公式製品ページ（出典URL）
            <input
              type="url"
              maxLength={2048}
              required
              value={draft.sourceUrl}
              onChange={(event) => {
                setDraft({ ...draft, sourceUrl: event.target.value });
                setCandidates([]);
              }}
            />
          </label>
          <button
            type="button"
            disabled={!safePhotoUrl(draft.sourceUrl)}
            onClick={() => void discover()}
          >
            公式ページから候補を取得
          </button>
          {candidates.length > 0 && (
            <div className="photo-candidates">
              {candidates.map((imageUrl, index) => (
                <div key={imageUrl}>
                  <Photo
                    photo={{ imageUrl, sourceUrl: draft.sourceUrl, credit: "" }}
                    name={`${name} 候補${index + 1}`}
                    compact
                  />
                  <button type="button" onClick={() => setDraft({ ...draft, imageUrl })}>
                    候補{index + 1}を選択
                  </button>
                </div>
              ))}
            </div>
          )}
          <label>
            メーカー画像URL
            <input
              type="url"
              maxLength={2048}
              required
              value={draft.imageUrl}
              onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })}
            />
          </label>
          <label>
            写真のクレジット（任意）
            <input
              maxLength={200}
              value={draft.credit}
              onChange={(event) => setDraft({ ...draft, credit: event.target.value })}
            />
          </label>
          <Photo photo={valid} name={name} />
          <div className="dialog-actions">
            <button type="submit" disabled={!valid || !dirty}>
              写真を登録
            </button>
            <button type="button" disabled={!snapshot?.photo} onClick={() => void save(null)}>
              掲載を取り消す
            </button>
          </div>
        </fieldset>
        <p role="status">{status}</p>
      </form>
    </dialog>
  );
}
