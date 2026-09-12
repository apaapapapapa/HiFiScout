/**
 * Byte ceilings for every external body a crawl transport reads into the Worker.
 *
 * The cap is enforced on the bytes actually read from the response stream, never on `Content-Length`
 * alone: a seller may omit the header entirely, and a small compressed payload can expand into a
 * body large enough to exhaust an isolate. `fetch()` hands back an already-decompressed body, so the
 * bytes counted here are exactly the ones that reach the decoder and the parser.
 *
 * These limits bound what the crawler may *fetch*. Evidence retention has its own, much smaller
 * budget (`EVIDENCE_MAX_BYTES`); the two are separate requirements and neither may stand in for the
 * other.
 */

import type { AugmentedCrawlError } from "./types.js";

/**
 * Largest listing/detail HTML body a transport will read.
 *
 * Seller listing pages observed in production stay well under 2 MB, and a crawl reads one page at a
 * time per shop, so 5 MB leaves room for an unusually large catalogue page while keeping the decoded
 * string and the parser's intermediate structures far below the isolate's memory limit.
 */
export const CRAWL_MAX_HTML_RESPONSE_BYTES = 5_000_000;

/** RFC 9309 requires parsing at least 500 KiB of `robots.txt`; nothing past that changes a decision. */
export const CRAWL_MAX_ROBOTS_RESPONSE_BYTES = 512 * 1024;

/** Relay control-plane JSON (a signed PREPARE permit) is a handful of short fields. */
export const CRAWL_MAX_RELAY_JSON_BYTES = 256 * 1024;

/** Relay failure detail is truncated to 200 characters; only enough to find it needs reading. */
export const CRAWL_MAX_RELAY_ERROR_BYTES = 16 * 1024;

/** Stable discriminator so callers can separate an oversized body from an ordinary crawl failure. */
export const CRAWL_RESPONSE_TOO_LARGE_CODE = "response_too_large";

/**
 * An external body exceeded its ceiling.
 *
 * This is a crawl failure, never an empty page: the collection that raised it must fail so existing
 * products keep their current state instead of being treated as delisted.
 */
export class CrawlResponseTooLargeError extends Error implements AugmentedCrawlError {
  readonly code = CRAWL_RESPONSE_TOO_LARGE_CODE;

  constructor(maxBytes: number) {
    super(`crawl response exceeded the ${maxBytes} byte limit`);
    this.name = "CrawlResponseTooLargeError";
  }
}

export function isCrawlResponseTooLargeError(error: unknown): error is CrawlResponseTooLargeError {
  return error instanceof CrawlResponseTooLargeError;
}

export interface LimitedResponseReadOptions {
  maxBytes: number;
  /**
   * Share the signal that bounded the request itself so a body that stalls halfway cannot outlive
   * the request deadline.
   */
  signal?: AbortSignal;
  /** Response charset label. An unknown label falls back to UTF-8, as it did before. */
  charset?: string;
}

function createDecoder(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder("utf-8");
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("crawl response read aborted");
}

/** Rejects when `signal` aborts. Raced against each read so a stalled body still ends. */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

export interface LimitedResponseRead {
  text: string;
  /** True when the body was longer than `maxBytes` and the remainder was abandoned. */
  truncated: boolean;
}

/**
 * Reads and decodes at most `maxBytes` of a response body, stopping there.
 *
 * Past the limit the read is abandoned and the reader cancelled, so the connection is released and
 * the oversized remainder is never buffered or decoded. No path re-reads the body with `text()` or
 * `arrayBuffer()` afterwards.
 */
export async function readBoundedResponseText(
  response: Response,
  { maxBytes, signal, charset = "utf-8" }: LimitedResponseReadOptions,
): Promise<LimitedResponseRead> {
  const decoder = createDecoder(charset);

  // Cheap early rejection only. A body already declared larger than the ceiling cannot fit under it,
  // but a missing or understated header never relaxes the streamed count below.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { text: "", truncated: true };
  }

  const body = response.body;
  if (!body?.getReader) {
    // A runtime without a readable stream still gets the ceiling, just after the platform buffered.
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes
      ? { text: decoder.decode(bytes.subarray(0, maxBytes)), truncated: true }
      : { text: decoder.decode(bytes), truncated: false };
  }

  const reader = body.getReader();
  const aborted = signal ? abortRejection(signal) : null;
  let total = 0;
  let text = "";
  let truncated = false;
  let completed = false;
  try {
    for (;;) {
      const result = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (result.done) break;
      const remaining = maxBytes - total;
      if (result.value.byteLength > remaining) {
        text += decoder.decode(result.value.subarray(0, remaining), { stream: true });
        truncated = true;
        break;
      }
      total += result.value.byteLength;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    completed = !truncated;
    return { text, truncated };
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
}

/**
 * {@link readBoundedResponseText} for bodies whose size is a correctness question rather than a
 * parsing budget: anything past the ceiling fails the read instead of silently losing content.
 */
export async function readLimitedResponseText(
  response: Response,
  options: LimitedResponseReadOptions,
): Promise<string> {
  const { text, truncated } = await readBoundedResponseText(response, options);
  if (truncated) throw new CrawlResponseTooLargeError(options.maxBytes);
  return text;
}
