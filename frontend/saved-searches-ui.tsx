import { useEffect, useState } from "react";
import type { ProductFilters } from "./filters.js";
import { savedSearchFeedPath } from "./filters.js";
import { FeedSubscription } from "./feed-subscription.js";
import { readPreference, savePreference } from "./public-ui-state.js";
import {
  MAX_SAVED_SEARCHES,
  SAVED_SEARCHES_KEY,
  parseSavedSearches,
  savedSearchFilters,
  savedSearchName,
  savedSearchQuery,
} from "./saved-searches.js";
import type { SavedSearch } from "./saved-searches.js";
import type { NotificationStatus } from "../src/api/contracts.js";
import { NotificationSettings } from "./notification-settings.js";
import {
  disableNotification,
  disableAllNotifications,
  notificationStatus,
} from "./notifications.js";

export function SavedSearches({
  filters,
  onApply,
}: {
  filters: ProductFilters;
  onApply: (filters: ProductFilters) => void;
}) {
  const [entries, setEntries] = useState(() =>
    parseSavedSearches(readPreference(SAVED_SEARCHES_KEY)),
  );
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [notifications, setNotifications] = useState<NotificationStatus | null>(null);
  const refreshNotifications = async () => {
    setNotifications(await notificationStatus());
  };
  useEffect(() => {
    void refreshNotifications().catch(() => {
      setError(true);
      setMessage("通知設定を確認できませんでした。再確認してください。");
    });
  }, []);
  const query = savedSearchQuery(filters);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === SAVED_SEARCHES_KEY || event.key === null)
        setEntries(parseSavedSearches(readPreference(SAVED_SEARCHES_KEY)));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const persist = (next: SavedSearch[], success: string) => {
    if (!savePreference(SAVED_SEARCHES_KEY, JSON.stringify(next))) {
      setError(true);
      setMessage("保存できませんでした。ブラウザーの保存容量・設定を確認してください。");
      return false;
    }
    setEntries(next);
    setError(false);
    setMessage(success);
    return true;
  };
  return (
    <details className="saved-searches">
      <summary>
        保存した検索 ({entries.length}/{MAX_SAVED_SEARCHES})
      </summary>
      <div className="saved-searches-content">
        <p>適用中の検索条件をこの端末に保存します。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const validName = savedSearchName(name);
            if (!validName) {
              setError(true);
              setMessage("検索名を1〜80文字で入力してください。");
              return;
            }
            if (!editing && query === null) {
              setError(true);
              setMessage("検索条件を修正してから保存してください。");
              return;
            }
            const latest = parseSavedSearches(readPreference(SAVED_SEARCHES_KEY));
            if (editing && !latest.some((entry) => entry.id === editing)) {
              setError(true);
              setMessage("この保存検索は削除されています。");
              return;
            }
            if (!editing && latest.length >= MAX_SAVED_SEARCHES) {
              setError(true);
              setMessage("保存できる検索は20件までです。");
              return;
            }
            const updatedAt = new Date().toISOString();
            const next = editing
              ? latest.map((entry) =>
                  entry.id === editing ? { ...entry, name: validName, updatedAt } : entry,
                )
              : [...latest, { id: crypto.randomUUID(), name: validName, query: query!, updatedAt }];
            if (persist(next, editing ? "検索名を変更しました。" : "検索条件を保存しました。")) {
              setName("");
              setEditing(null);
            }
          }}
        >
          <label>
            検索名
            <input
              aria-label="検索名"
              value={name}
              maxLength={160}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            disabled={
              !savedSearchName(name) ||
              (!editing &&
                (query === null || filters.favoritesOnly || entries.length >= MAX_SAVED_SEARCHES))
            }
          >
            {editing ? "検索名を変更" : "この検索を保存"}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setName("");
              }}
            >
              名前変更をやめる
            </button>
          ) : null}
        </form>
        <p role={error ? "alert" : "status"}>{message}</p>
        {!notifications ? (
          <button
            type="button"
            onClick={() =>
              void refreshNotifications().catch(() => {
                setError(true);
                setMessage("通知設定を確認できませんでした。通信状態をご確認ください。");
              })
            }
          >
            通知設定を再確認
          </button>
        ) : null}
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.name}</strong>
              <button
                type="button"
                aria-label={`${entry.name}を検索`}
                onClick={() => onApply(savedSearchFilters(entry.query))}
              >
                検索する
              </button>
              <button
                type="button"
                aria-label={`${entry.name}の名前を変更`}
                onClick={() => {
                  setEditing(entry.id);
                  setName(entry.name);
                }}
              >
                名前を変更
              </button>
              <button
                type="button"
                aria-label={`${entry.name}を削除`}
                onClick={async () => {
                  if (!window.confirm(`「${entry.name}」を削除しますか？`)) return;
                  try {
                    if (
                      notifications === null ||
                      notifications.watches.some((watch) => watch.id === entry.id)
                    )
                      await disableNotification(entry.id);
                  } catch {
                    setError(true);
                    setMessage(
                      "通知の解除を確認できないため、保存検索を残しました。通信状態を確認して再度お試しください。",
                    );
                    return;
                  }
                  setNotifications((previous) =>
                    previous
                      ? {
                          ...previous,
                          watches: previous.watches.filter((watch) => watch.id !== entry.id),
                        }
                      : previous,
                  );
                  const next = parseSavedSearches(readPreference(SAVED_SEARCHES_KEY)).filter(
                    (value) => value.id !== entry.id,
                  );
                  if (persist(next, "保存検索を削除しました。") && editing === entry.id) {
                    setEditing(null);
                    setName("");
                  }
                }}
              >
                削除
              </button>
              <FeedSubscription path={savedSearchFeedPath(savedSearchFilters(entry.query))} />
              <NotificationSettings
                entry={entry}
                watch={notifications?.watches.find((watch) => watch.id === entry.id)}
                known={notifications !== null}
                refresh={refreshNotifications}
              />
            </li>
          ))}
        </ul>
        {notifications?.watches.length ? (
          <div className="notification-status">
            <p>
              通知はこの端末で最大5件です。設定は90日間有効で、通知の有効化・更新時に延長されます。
            </p>
            {notifications.lastCheck ? (
              <p>確認処理の最終完了：{new Date(notifications.lastCheck).toLocaleString("ja-JP")}</p>
            ) : (
              <p>最初の確認を待っています。</p>
            )}
            {notifications.delayed ? (
              <p role="status">通知の確認が遅れています。検索画面で最新の出品もご確認ください。</p>
            ) : null}
            {notifications.failed ? (
              <p role="status">
                配信できなかった通知があります。端末の通知許可を確認してください。
              </p>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                try {
                  await disableAllNotifications();
                  await refreshNotifications();
                  setError(false);
                  setMessage("この端末の通知をすべて停止しました。");
                } catch {
                  setError(true);
                  setMessage("通知の停止を確認できませんでした。再度お試しください。");
                }
              }}
            >
              この端末の通知をすべて停止
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
