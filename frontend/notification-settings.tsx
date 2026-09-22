import { useEffect, useState } from "react";
import type { NotificationWatch } from "../src/api/contracts.js";
import type { SavedSearch } from "./saved-searches.js";
import {
  disableNotification,
  enableNotification,
  notificationQuery,
  pushAvailable,
} from "./notifications.js";

export function NotificationSettings({
  entry,
  watch,
  known,
  refresh,
}: {
  entry: SavedSearch;
  watch?: NotificationWatch;
  known: boolean;
  refresh: () => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [newListings, setNew] = useState(true);
  const [priceDrops, setDrops] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    setTarget(new URLSearchParams(watch?.query ?? entry.query).get("maxPrice") ?? "");
    setNew(watch?.newListings ?? true);
    setDrops(watch?.priceDrops ?? true);
  }, [watch, entry.query]);
  const apply = async (enable: boolean) => {
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      if (enable)
        await enableNotification({
          id: entry.id,
          query: notificationQuery(entry.query, target),
          newListings,
          priceDrops,
        });
      else await disableNotification(entry.id);
      await refresh();
      setMessage(
        enable
          ? "通知を有効にしました。登録後に確認した新着・値下げをお知らせします。"
          : "この検索の通知を解除しました。",
      );
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : "通知設定を更新できませんでした。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="notification-settings">
      <summary>{!known ? "通知設定を確認中" : watch ? "通知中" : "新着・値下げを通知"}</summary>
      <div className="notification-settings-content">
        <p>この検索に合う在庫ありの出品を通知します。収集後、通常15分間隔で順次確認します。</p>
        <p>
          通知を有効にすると、この検索条件・希望価格と通知先をサーバーに保存します。検索名・検討メモは送信しません。
        </p>
        {!pushAvailable() ? (
          <p>
            iPhone／iPadは、共有メニューから「ホーム画面に追加」し、追加したHiFiScoutを開いて通知を設定してください。
          </p>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={newListings}
            disabled={busy}
            onChange={(event) => setNew(event.currentTarget.checked)}
          />
          新着
        </label>
        <label>
          <input
            type="checkbox"
            checked={priceDrops}
            disabled={busy}
            onChange={(event) => setDrops(event.currentTarget.checked)}
          />
          値下げ
        </label>
        <label>
          希望価格（上限・円）
          <input
            inputMode="numeric"
            type="text"
            value={target}
            maxLength={12}
            disabled={busy}
            onChange={(event) => setTarget(event.currentTarget.value)}
          />
        </label>
        <small>検索条件の上限価格がある場合は、より低い方を使用します。</small>
        <div>
          <button
            type="button"
            disabled={busy || !known || !pushAvailable() || (!newListings && !priceDrops)}
            onClick={() => void apply(true)}
          >
            {busy ? "設定中…" : watch ? "通知条件を更新" : "通知を有効にする"}
          </button>
          {watch ? (
            <button type="button" disabled={busy} onClick={() => void apply(false)}>
              通知を解除
            </button>
          ) : null}
        </div>
        <p role={error ? "alert" : "status"}>{message}</p>
      </div>
    </details>
  );
}
