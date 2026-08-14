/**
 * Bounded fetching for manufacturer pages.
 *
 * Verification reads third-party sites from a Worker, so every request is capped in both time and
 * bytes and no failure escapes as an exception — a manufacturer being slow or hostile must degrade
 * one candidate's verification, not the batch.
 */

import { errorMessage } from "../../types.js";
import type { FetchTextResult } from "./types.js";

/** HTML-only pages. The index and product-page strategies use this. */
export const HTML_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

/** Discovery also reads `sitemap.xml` and `robots.txt`. */
export const DISCOVERY_ACCEPT =
  "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8";

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  /** Defaults to {@link DISCOVERY_ACCEPT}. */
  accept?: string;
}

/**
 * Reads at most `maxBytes` of a response body.
 *
 * Streams so an unexpectedly huge page is abandoned rather than buffered, and cancels the reader
 * once the cap is hit so the connection is not left open.
 */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total >= maxBytes) break;
    }
    text += decoder.decode();
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => {});
  }
  return text;
}

/** Never throws. A timeout is reported as `error: "timeout"` with `status: 0`. */
export async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  { timeoutMs, maxBytes, userAgent, accept = DISCOVERY_ACCEPT }: FetchTextOptions,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept, "user-agent": userAgent },
    });
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      text: response.ok ? await readLimitedText(response, maxBytes) : "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      text: "",
      error:
        error instanceof Error && error.name === "AbortError" ? "timeout" : errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Content hash recorded with a verification. Returns `""` where WebCrypto is unavailable. */
export async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return "";
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
