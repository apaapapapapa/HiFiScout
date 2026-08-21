/** Presentation primitives: escaping, currency, dates. No DOM access, so directly unit-testable. */

const HTML_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Every interpolation into an `innerHTML` template goes through this.
 *
 * Product text is retailer-controlled, so it is untrusted input even though it arrives from our
 * own API.
 */
export function escapeHtml(value: string | null = ""): string {
  return String(value).replace(/[&<>"']/g, (character) => HTML_REPLACEMENTS[character]);
}

/**
 * Only web URLs may become clickable retailer links.
 *
 * `escapeHtml` protects markup syntax, not URL schemes: `javascript:` survives HTML escaping and
 * executes when clicked. Source URLs originate on retailer pages, so keep this independent guard
 * at the final DOM boundary even when crawler-side validation is also present.
 */
export function safeExternalUrl(value: string | null = ""): string {
  const raw = String(value || "").trim();
  if (!raw) return "#";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "#";
  } catch {
    return "#";
  }
}

export const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

export const dateFmt = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** `new Date(null)` is the epoch, which is what the untyped version produced for a null column. */
export function safeDate(value: string | null): Date | null {
  const date = new Date(value ?? 0);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function relativeTime(value: string | null, now = Date.now()): string {
  const date = safeDate(value);
  if (!date) return "未取得";
  const diff = Math.max(0, now - date.getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}
