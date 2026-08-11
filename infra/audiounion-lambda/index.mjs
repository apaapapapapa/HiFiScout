import { timingSafeEqual } from 'node:crypto';

const DEFAULT_ENTRY_URL = 'https://www.audiounion.jp/st/new_arrival_used.html';
const DEFAULT_USER_AGENT = 'HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)';
const DEFAULT_MIN_DELAY_MS = 10_000;
const AUDIOUNION_HOST = 'www.audiounion.jp';
const HIFIDO_HOST = 'www.hifido.co.jp';
const HIFIDO_ALLOWED_QUERY_KEYS = new Set(['L', 'LNG', 'O', 'OD']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function jsonResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    },
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

function requestHeader(event, name) {
  const headers = event?.headers || {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value ?? '');
  }
  return '';
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeRequestBody(event) {
  const raw = event?.body || '';
  const decoded = event?.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  return decoded ? JSON.parse(decoded) : {};
}

function normalizePath(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}` || '/';
}

function parseGroups(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length || current.crawlDelaySeconds != null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ type: key, path: value });
    } else if (key === 'crawl-delay' && current) {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

function applicableGroups(text, userAgent) {
  const groups = parseGroups(text);
  const ua = String(userAgent || '').toLowerCase().split('/')[0];
  const exact = groups.filter(group => group.agents.some(agent => agent !== '*' && ua.includes(agent)));
  return exact.length ? exact : groups.filter(group => group.agents.includes('*'));
}

function matchesRule(path, rulePath) {
  if (!rulePath) return false;
  const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$$/, '$');
  return new RegExp(`^${escaped}`).test(path);
}

function isPathAllowed(robotsText, targetUrl, userAgent) {
  if (robotsText == null) return true;
  const applicable = applicableGroups(robotsText, userAgent);
  const path = normalizePath(targetUrl);
  const rules = applicable.flatMap(group => group.rules).filter(rule => matchesRule(path, rule.path));
  if (!rules.length) return true;
  rules.sort((a, b) => b.path.length - a.path.length || (a.type === 'allow' ? -1 : 1));
  return rules[0].type === 'allow';
}

function getCrawlDelayMs(robotsText, userAgent) {
  if (robotsText == null) return 0;
  const delays = applicableGroups(robotsText, userAgent)
    .map(group => group.crawlDelaySeconds)
    .filter(value => Number.isFinite(value) && value >= 0);
  return delays.length ? Math.max(...delays) * 1000 : 0;
}

async function fetchRobotsPolicy(fetchFn, baseUrl, userAgent) {
  const robotsUrl = new URL('/robots.txt', baseUrl).toString();
  const response = await fetchFn(robotsUrl, { headers: { 'User-Agent': userAgent }, redirect: 'follow' });
  if (response.status === 429) throw new Error('robots.txt temporarily unavailable (429)');
  if (response.status >= 400 && response.status < 500) return null;
  if (response.status >= 500) throw new Error(`robots.txt temporarily unavailable (${response.status})`);
  if (!response.ok) return null;
  return response.text();
}

function configuredEntryUrl(env) {
  const url = new URL(env.AUDIOUNION_ENTRY_URL || DEFAULT_ENTRY_URL);
  if (url.protocol !== 'https:' || url.hostname !== AUDIOUNION_HOST) {
    throw new Error('AUDIOUNION_ENTRY_URL must use https://www.audiounion.jp');
  }
  return url.toString();
}

function isAllowedAudioUnionDetailUrl(url) {
  return url.protocol === 'https:' &&
    url.hostname === AUDIOUNION_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    /^\/ct\/detail\/used\/\d+\/?$/.test(url.pathname) &&
    url.search === '' &&
    url.hash === '';
}

function isAllowedHifidoUrl(url) {
  if (url.protocol !== 'https:' || url.hostname !== HIFIDO_HOST || url.pathname !== '/') return false;
  for (const key of url.searchParams.keys()) {
    if (!HIFIDO_ALLOWED_QUERY_KEYS.has(key)) return false;
  }
  if (url.searchParams.get('L') !== '50') return false;
  if (url.searchParams.get('LNG') !== 'J') return false;
  if (url.searchParams.get('OD') !== '0') return false;
  const offset = Number.parseInt(url.searchParams.get('O') || '', 10);
  return Number.isSafeInteger(offset) && offset >= 0 && offset % 30 === 0;
}

function isAllowedTarget(requestedUrl, env) {
  if (requestedUrl.toString() === configuredEntryUrl(env)) return true;
  if (isAllowedAudioUnionDetailUrl(requestedUrl)) return true;
  return isAllowedHifidoUrl(requestedUrl);
}

function safeUserAgent(value, fallback) {
  const candidate = String(value || fallback || DEFAULT_USER_AGENT).trim();
  if (!candidate || candidate.length > 300 || /[\r\n]/.test(candidate)) return DEFAULT_USER_AGENT;
  return candidate;
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createHandler({ fetchFn = fetch, sleepFn = sleep, env = process.env } = {}) {
  return async function handler(event = {}) {
    try {
      const method = event?.requestContext?.http?.method || 'POST';
      if (method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { allow: 'POST' });

      const relayToken = String(env.RELAY_TOKEN || '');
      if (relayToken.length < 32) return jsonResponse(500, { error: 'relay_token_not_configured' });
      const authorization = requestHeader(event, 'authorization');
      const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!secureEqual(suppliedToken, relayToken)) return jsonResponse(401, { error: 'unauthorized' });

      let body;
      try {
        body = decodeRequestBody(event);
      } catch {
        return jsonResponse(400, { error: 'invalid_json' });
      }

      let requestedUrl;
      try {
        requestedUrl = new URL(String(body.url || ''));
      } catch {
        return jsonResponse(400, { error: 'invalid_target_url' });
      }
      if (!isAllowedTarget(requestedUrl, env)) return jsonResponse(400, { error: 'target_not_allowed' });

      const userAgent = safeUserAgent(body.userAgent, env.CRAWLER_USER_AGENT);
      const minimumDelayMs = nonNegativeNumber(env.MIN_REQUEST_DELAY_MS, DEFAULT_MIN_DELAY_MS);
      const requestedDelayMs = nonNegativeNumber(body.requestDelayMs, 0);
      const targetUrl = requestedUrl.toString();
      const robotsText = await fetchRobotsPolicy(fetchFn, targetUrl, userAgent);
      if (!isPathAllowed(robotsText, targetUrl, userAgent)) {
        return jsonResponse(409, { error: 'robots_disallowed' });
      }

      const effectiveDelayMs = Math.max(minimumDelayMs, requestedDelayMs, getCrawlDelayMs(robotsText, userAgent));
      if (effectiveDelayMs > 0) await sleepFn(effectiveDelayMs);

      const upstream = await fetchFn(targetUrl, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en;q=0.7',
          'Cache-Control': 'no-cache'
        },
        redirect: 'follow'
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';

      return {
        statusCode: upstream.status,
        headers: {
          'content-type': contentType,
          'cache-control': 'no-store',
          'x-hifiscout-upstream-status': String(upstream.status),
          'x-hifiscout-aws-region': env.AWS_REGION || 'unknown'
        },
        body: bytes.toString('base64'),
        isBase64Encoded: true
      };
    } catch (error) {
      return jsonResponse(502, {
        error: 'relay_failure',
        message: String(error instanceof Error ? error.message : String(error)).slice(0, 300)
      });
    }
  };
}

export const handler = createHandler();
