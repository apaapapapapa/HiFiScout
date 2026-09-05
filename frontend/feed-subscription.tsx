import { useState } from "react";

export function FeedSubscription({ path }: { path: string }) {
  const [message, setMessage] = useState("");
  const url = new URL(path, location.origin).href;
  return (
    <details className="feed-subscription">
      <summary>RSS / Atomで購読</summary>
      <div className="feed-help">
        <p>
          この検索条件の新着・値下げをRSSリーダーで確認できます。URLをコピーして、お使いのリーダーに登録してください。
        </p>
        <label>
          購読URL
          <input
            aria-label="購読URL"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            void (
              navigator.clipboard
                ? navigator.clipboard.writeText(url)
                : Promise.reject(new Error("Clipboard unavailable"))
            ).then(
              () => setMessage("URLをコピーしました。"),
              () => setMessage("コピーできませんでした。URL欄を選択してコピーしてください。"),
            );
          }}
        >
          URLをコピー
        </button>
        <a href={path} rel="alternate" type="application/atom+xml">
          Atomフィードを開く
        </a>
        <p role="status">{message}</p>
      </div>
    </details>
  );
}
