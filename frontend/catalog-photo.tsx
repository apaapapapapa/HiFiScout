import { useState } from "react";
import { safePhotoUrl, type CatalogPhoto as Photo } from "../src/api/catalog-photo-contracts.js";

export function CatalogPhoto({
  photo,
  name,
  compact = false,
}: {
  photo: Photo | null | undefined;
  name: string;
  compact?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState("");
  const sourceUrl = safePhotoUrl(photo?.sourceUrl);
  if (!photo || !sourceUrl) return null;
  return (
    <figure className={`catalog-photo${compact ? " catalog-photo-compact" : ""}`}>
      {failedUrl === photo.imageUrl ? (
        <p className="catalog-photo-unavailable">写真を読み込めませんでした</p>
      ) : (
        <img
          src={photo.imageUrl}
          alt={`${name} のメーカー写真`}
          width="480"
          height="320"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(photo.imageUrl)}
        />
      )}
      <figcaption>
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
          メーカー写真{photo.credit ? `：${photo.credit}` : "（出典）"}
        </a>
        {!compact && <span>参考写真です。出品の色・付属品・状態は販売店でご確認ください。</span>}
      </figcaption>
    </figure>
  );
}
