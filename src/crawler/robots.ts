function normalizePath(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}` || "/";
}

function parseGroups(text) {
  const groups = [];
  let current = null;
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

function applicableGroups(text, userAgent) {
  const groups = parseGroups(text);
  const ua = userAgent.toLowerCase().split("/")[0];
  const exact = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  return exact.length ? exact : groups.filter((g) => g.agents.includes("*"));
}

function matchesRule(path, rulePath) {
  if (!rulePath) return false;
  const escaped = rulePath
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\$$/, "$");
  return new RegExp(`^${escaped}`).test(path);
}

export function isPathAllowed(robotsText, targetUrl, userAgent = "HiFiScoutBot") {
  if (robotsText == null) return true;
  const applicable = applicableGroups(robotsText, userAgent);
  const path = normalizePath(targetUrl);
  const rules = applicable.flatMap((g) => g.rules).filter((r) => matchesRule(path, r.path));
  if (!rules.length) return true;
  rules.sort((a, b) => b.path.length - a.path.length || (a.type === "allow" ? -1 : 1));
  return rules[0].type === "allow";
}

export function getCrawlDelayMs(robotsText, userAgent = "HiFiScoutBot") {
  if (robotsText == null) return 0;
  const delays = applicableGroups(robotsText, userAgent)
    .map((group) => group.crawlDelaySeconds)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!delays.length) return 0;
  return Math.max(...delays) * 1000;
}

export async function fetchRobotsPolicy(fetchFn, baseUrl, userAgent) {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  const response = await fetchFn(robotsUrl, { headers: { "User-Agent": userAgent } });
  if (response.status === 429) throw new Error("robots.txt temporarily unavailable (429)");
  // RFC 9309 classifies 4xx responses as "unavailable": crawlers may access other resources.
  // A 403 for robots.txt alone is therefore not equivalent to an explicit Disallow rule.
  if (response.status >= 400 && response.status < 500) return null;
  if (response.status >= 500)
    throw new Error(`robots.txt temporarily unavailable (${response.status})`);
  if (!response.ok) return null;
  return response.text();
}
