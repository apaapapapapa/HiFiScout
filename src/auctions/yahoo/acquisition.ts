import { decodeHtmlResponse } from "../../crawler/fetch.js";
import { getCrawlDelayMs, isPathAllowed } from "../../crawler/robots.js";
import { readBoundedResponseText } from "../../crawler/response-limits.js";
import type { AuctionTask } from "../runtime-policy.js";
import { YAHOO_AUCTION_ORIGIN, yahooAuctionCategory, yahooAuctionIdentity } from "./policy.js";

export const AUCTION_USER_AGENT = "HiFiScoutBot/1.0 (+https://github.com/apaapapapapa/HiFiScout)";
export interface AuctionAcquisition {
  status: number | null;
  text: string | null;
  retryAfter: string | null;
  authenticationRequired: boolean;
}
export interface AuctionTransport {
  request(url: string, robots: boolean): Promise<AuctionAcquisition>;
}
export function auctionTaskUrl(task: AuctionTask): string {
  if (!yahooAuctionCategory(task.categoryId)) throw new Error("auction_category_not_allowed");
  if (task.kind === "confirm") {
    const identity = yahooAuctionIdentity(`${YAHOO_AUCTION_ORIGIN}/jp/auction/${task.auctionId}`);
    if (!identity) throw new Error("auction_id_not_allowed");
    return identity.sourceUrl;
  }
  if (!Number.isInteger(task.page) || task.page < 1 || task.page > 3)
    throw new Error("auction_page_not_allowed");
  return `${YAHOO_AUCTION_ORIGIN}/category/list/${task.categoryId}/?b=${1 + (task.page - 1) * 20}&n=20`;
}
/** Exactly one seller request per durable permit, including robots. Redirects require review. */
export const yahooAuctionTransport: AuctionTransport = {
  async request(url, robots) {
    const parsed = new URL(url);
    if (parsed.origin !== YAHOO_AUCTION_ORIGIN || parsed.username || parsed.password || parsed.hash)
      throw new Error("auction_origin_not_allowed");
    if (
      robots
        ? parsed.pathname !== "/robots.txt" || !!parsed.search
        : !yahooAuctionIdentity(url) &&
          !/^\/category\/list\/(2084037425|2084024118)\/$/u.test(parsed.pathname)
    )
      throw new Error("auction_path_not_allowed");
    const signal = AbortSignal.timeout(20_000);
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": AUCTION_USER_AGENT,
        Accept: robots ? "text/plain" : "text/html",
      },
    });
    const result: AuctionAcquisition = {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      text: null,
      authenticationRequired: response.status >= 300 && response.status < 400,
    };
    if (!response.ok) {
      await response.body?.cancel();
      return result;
    }
    if (robots) {
      const body = await readBoundedResponseText(response, { maxBytes: 64 * 1024, signal });
      if (body.truncated || !/^user-agent\s*:/imu.test(body.text))
        return { ...result, authenticationRequired: true };
      return { ...result, text: body.text };
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/html"))
      return { ...result, authenticationRequired: true };
    const text = await decodeHtmlResponse(response, { maxBytes: 1_048_576, signal });
    return {
      ...result,
      text,
      authenticationRequired: /(?:captcha|ログインしてください|認証が必要)/iu.test(text),
    };
  },
};
export function auctionRobotsPermit(
  text: string,
  url: string,
): { allowed: boolean; delayMs: number } {
  return {
    allowed: isPathAllowed(text, url, AUCTION_USER_AGENT),
    delayMs: Math.max(60_000, getCrawlDelayMs(text, AUCTION_USER_AGENT)),
  };
}
