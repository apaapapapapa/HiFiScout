import { useEffect, useState } from "react";
import type { ProductFilters } from "./filters.js";
import { savedSearchFeedPath } from "./filters.js";
import { FeedSubscription } from "./feed-subscription.js";
import { readPreference, savePreference } from "./public-ui-state.js";
import { MAX_SAVED_SEARCHES, SAVED_SEARCHES_KEY, parseSavedSearches, savedSearchFilters, savedSearchName, savedSearchQuery } from "./saved-searches.js";
import type { SavedSearch } from "./saved-searches.js";

export function SavedSearches({ filters, onApply }: { filters: ProductFilters; onApply: (filters: ProductFilters) => void }) {
  const [entries, setEntries] = useState(() => parseSavedSearches(readPreference(SAVED_SEARCHES_KEY)));
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const query = savedSearchQuery(filters);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === SAVED_SEARCHES_KEY || event.key === null) setEntries(parseSavedSearches(readPreference(SAVED_SEARCHES_KEY)));
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
  return <details className="saved-searches">
    <summary>保存した検索 ({entries.length}/{MAX_SAVED_SEARCHES})</summary>
    <div className="saved-searches-content">
      <p>適用中の検索条件をこの端末に保存します。</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const validName = savedSearchName(name);
        if (!validName) { setError(true); setMessage("検索名を1〜80文字で入力してください。"); return; }
        if (!editing && query === null) { setError(true); setMessage("検索条件を修正してから保存してください。"); return; }
        const latest = parseSavedSearches(readPreference(SAVED_SEARCHES_KEY));
        if (editing && !latest.some((entry) => entry.id === editing)) { setError(true); setMessage("この保存検索は削除されています。"); return; }
        if (!editing && latest.length >= MAX_SAVED_SEARCHES) { setError(true); setMessage("保存できる検索は20件までです。"); return; }
        const updatedAt = new Date().toISOString();
        const next = editing ? latest.map((entry) => entry.id === editing ? { ...entry, name: validName, updatedAt } : entry) :
          [...latest, { id: crypto.randomUUID(), name: validName, query: query!, updatedAt }];
        if (persist(next, editing ? "検索名を変更しました。" : "検索条件を保存しました。")) { setName(""); setEditing(null); }
      }}>
        <label>検索名<input aria-label="検索名" value={name} maxLength={160} onChange={(event) => setName(event.currentTarget.value)} /></label>
        <button type="submit" disabled={!savedSearchName(name) || (!editing && (query === null || filters.favoritesOnly || entries.length >= MAX_SAVED_SEARCHES))}>{editing ? "検索名を変更" : "この検索を保存"}</button>
        {editing ? <button type="button" onClick={() => { setEditing(null); setName(""); }}>名前変更をやめる</button> : null}
      </form>
      <p role={error ? "alert" : "status"}>{message}</p>
      <ul>{entries.map((entry) => <li key={entry.id}>
        <strong>{entry.name}</strong>
        <button type="button" aria-label={`${entry.name}を検索`} onClick={() => onApply(savedSearchFilters(entry.query))}>検索する</button>
        <button type="button" aria-label={`${entry.name}の名前を変更`} onClick={() => { setEditing(entry.id); setName(entry.name); }}>名前を変更</button>
        <button type="button" aria-label={`${entry.name}を削除`} onClick={() => {
          if (!window.confirm(`「${entry.name}」を削除しますか？`)) return;
          const next = parseSavedSearches(readPreference(SAVED_SEARCHES_KEY)).filter((value) => value.id !== entry.id);
          if (persist(next, "保存検索を削除しました。") && editing === entry.id) { setEditing(null); setName(""); }
        }}>削除</button>
        <FeedSubscription path={savedSearchFeedPath(savedSearchFilters(entry.query))} />
      </li>)}</ul>
    </div>
  </details>;
}
