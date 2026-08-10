function normalizePath(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}` || '/';
}

function parseGroups(text) {
  const groups = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ type: key, path: value });
    }
  }
  return groups;
}

function matchesRule(path, rulePath) {
  if (!rulePath) return false;
  const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$$/, '$');
  return new RegExp(`^${escaped}`).test(path);
}

export function isPathAllowed(robotsText, targetUrl, userAgent = 'HiFiScoutBot') {
  if (robotsText == null) return true;
  const groups = parseGroups(robotsText);
  const ua = userAgent.toLowerCase().split('/')[0];
  const exact = groups.filter(g => g.agents.some(a => a !== '*' && ua.includes(a)));
  const applicable = exact.length ? exact : groups.filter(g => g.agents.includes('*'));
  const path = normalizePath(targetUrl);
  const rules = applicable.flatMap(g => g.rules).filter(r => matchesRule(path, r.path));
  if (!rules.length) return true;
  rules.sort((a, b) => b.path.length - a.path.length || (a.type === 'allow' ? -1 : 1));
  return rules[0].type === 'allow';
}

export async function fetchRobotsPolicy(fetchFn, baseUrl, userAgent) {
  const robotsUrl = new URL('/robots.txt', baseUrl).toString();
  const response = await fetchFn(robotsUrl, { headers: { 'User-Agent': userAgent } });
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) throw new Error(`robots.txt denied access (${response.status})`);
  if (response.status === 429 || response.status >= 500) throw new Error(`robots.txt temporarily unavailable (${response.status})`);
  if (!response.ok) return null;
  return response.text();
}
