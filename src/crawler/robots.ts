import type { RobotsCache, RobotsGroup } from "./types.js";
import { CRAWL_MAX_ROBOTS_RESPONSE_BYTES, readBoundedResponseText } from "./response-limits.js";
import { allowedOriginSet, fetchFollowingValidatedRedirects } from "./redirects.js";

const ROBOTS_HTTP_TIMEOUT_MS = 15_000;

function normalizePath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}` || "/";
}

function parseGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length || current.crawlDelaySeconds != null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ type: key, path: value });
    } else if (key === "crawl-delay" && current) {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

function applicableGroups(text: string, userAgent: string): RobotsGroup[] {
  const groups = parseGroups(text);
  const ua = userAgent.toLowerCase().split("/")[0];
  const exact = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  return exact.length ? exact : groups.filter((g) => g.agents.includes("*"));
}

function matchesRule(path: string, rulePath: string): boolean {
  if (!rulePath) return false;
  const escaped = rulePath
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\$$/, "$");
  return new RegExp(`^${escaped}`).test(path);
}

export function isPathAllowed(
  robotsText: string | null | undefined,
  targetUrl: string,
  userAgent = "HiFiScoutBot",
): boolean {
  if (robotsText == null) return true;
  const applicable = applicableGroups(robotsText, userAgent);
  const path = normalizePath(targetUrl);
  const rules = applicable.flatMap((g) => g.rules).filter((r) => matchesRule(path, r.path));
  if (!rules.length) return true;
  rules.sort((a, b) => b.path.length - a.path.length || (a.type === "allow" ? -1 : 1));
  return rules[0].type === "allow";
}

export function getCrawlDelayMs(
  robotsText: string | null | undefined,
  userAgent = "HiFiScoutBot",
): number {
  if (robotsText == null) return 0;
  const delays = applicableGroups(robotsText, userAgent)
    .map((group) => group.crawlDelaySeconds)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  if (!delays.length) return 0;
  return Math.max(...delays) * 1000;
}

export interface RobotsFetchOptions {
  /**
   * Origins `robots.txt` itself may be redirected to. Defaults to the policy's own origin, so the
   * policy fetch cannot become a second, unchecked route to somewhere else.
   */
  allowedOrigins?: ReadonlySet<string>;
}

export async function fetchRobotsPolicy(
  fetchFn: typeof fetch,
  baseUrl: string,
  userAgent: string,
  { allowedOrigins }: RobotsFetchOptions = {},
): Promise<string | null> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  // One deadline for the request and the body: a robots.txt that stalls mid-stream must not hold the
  // crawl open any longer than one that never answers.
  const deadline = AbortSignal.timeout(ROBOTS_HTTP_TIMEOUT_MS);
  // RFC 9309 expects redirects to be followed, but a policy redirect is subject to the same
  // destination rules as any other crawl request.
  const response = await fetchFollowingValidatedRedirects(
    robotsUrl,
    { headers: { "User-Agent": userAgent } },
    {
      fetchFn,
      allowedOrigins: allowedOrigins ?? allowedOriginSet([robotsUrl]),
      signal: deadline,
    },
  );
  if (response.status === 429) throw new Error("robots.txt temporarily unavailable (429)");
  // RFC 9309 classifies 4xx responses as "unavailable": crawlers may access other resources.
  // A 403 for robots.txt alone is therefore not equivalent to an explicit Disallow rule.
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`robots.txt temporarily unavailable (${response.status})`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  // RFC 9309 lets a crawler stop parsing at 500 KiB and requires the cut to land on a line boundary,
  // so an oversized robots.txt degrades to its first rules instead of failing the crawl. A partial
  // trailing line is dropped rather than parsed as a shorter, more permissive path.
  const { text, truncated } = await readBoundedResponseText(response, {
    maxBytes: CRAWL_MAX_ROBOTS_RESPONSE_BYTES,
    signal: deadline,
    charset: "utf-8",
  });
  if (!truncated) return text;
  const lastLineBreak = text.lastIndexOf("\n");
  return lastLineBreak < 0 ? "" : text.slice(0, lastLineBreak + 1);
}

/**
 * Per-destination robots gate used while following redirects.
 *
 * Every hop is evaluated against the policy of the origin it is about to reach, so a redirect cannot
 * carry the crawl onto a path the destination's own `robots.txt` disallows. A redirect chain is the
 * continuation of one already-paced request, so hops are not separately delayed.
 */
export function createRobotsGate({
  fetchFn,
  userAgent,
  robotsCache,
  allowedOrigins,
}: {
  fetchFn: typeof fetch;
  userAgent: string;
  robotsCache: RobotsCache;
  allowedOrigins: ReadonlySet<string>;
}): (targetUrl: string) => Promise<void> {
  return async (targetUrl: string) => {
    const origin = new URL(targetUrl).origin;
    if (!robotsCache.has(origin)) {
      robotsCache.set(
        origin,
        await fetchRobotsPolicy(fetchFn, origin, userAgent, { allowedOrigins }),
      );
    }
    if (!isPathAllowed(robotsCache.get(origin), targetUrl, userAgent)) {
      throw new Error(`robots.txt disallows ${new URL(targetUrl).pathname}`);
    }
  };
}
