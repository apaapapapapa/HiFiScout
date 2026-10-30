import { useState } from "react";

/**
 * Shares the applied search as a link.
 *
 * The address bar already carries the same state, but the installed app opens without one, so the
 * link is offered explicitly. A status belongs to the link it reported on and is hidden once the
 * applied search changes.
 */
export function SearchShare({ path }: { path: string }) {
  const [status, setStatus] = useState<{ path: string; text: string } | null>(null);
  const url = new URL(path, location.origin).href;
  const report = (text: string) => setStatus({ path, text });
  return (
    <details className="search-share">
      <summary>検索条件を共有</summary>
      <div className="share-help">
        <p>
          適用中の検索条件と表示形式を開くURLです。お気に入り、比較中の商品、保存した検索は含まれません。
        </p>
        <label>
          共有URL
          <input readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <button
          type="button"
          onClick={() => {
            void (
              navigator.clipboard
                ? navigator.clipboard.writeText(url)
                : Promise.reject(new Error("Clipboard unavailable"))
            ).then(
              () => report("URLをコピーしました。"),
              () => report("コピーできませんでした。URL欄を選択してコピーしてください。"),
            );
          }}
        >
          URLをコピー
        </button>
        {typeof navigator.share === "function" ? (
          <button
            type="button"
            onClick={() => {
              navigator.share({ title: document.title, url }).then(
                () => report(""),
                (error: unknown) => {
                  // Dismissing the share sheet is a choice, not a failure.
                  if (error instanceof DOMException && error.name === "AbortError") return;
                  report("共有できませんでした。URLをコピーしてください。");
                },
              );
            }}
          >
            ほかのアプリで共有
          </button>
        ) : null}
        <p role="status">{status?.path === path ? status.text : ""}</p>
      </div>
    </details>
  );
}
