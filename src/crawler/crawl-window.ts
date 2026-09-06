const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
// Japan has no daylight-saving changes: 23:00–08:00 JST is 14:00–23:00 UTC.
const QUIET_START_MS = 14 * HOUR_MS;
const QUIET_END_MS = 23 * HOUR_MS;
const ACTIVE_DAY_MS = DAY_MS - (QUIET_END_MS - QUIET_START_MS);

/** Keep an eligible timestamp, or defer it to the next 08:00 JST. */
export function nextCrawlAllowedAt(timestampMs: number): number {
  const dayStart = Math.floor(timestampMs / DAY_MS) * DAY_MS;
  const timeOfDay = timestampMs - dayStart;
  return timeOfDay >= QUIET_START_MS && timeOfDay < QUIET_END_MS
    ? dayStart + QUIET_END_MS
    : timestampMs;
}

export function isCrawlQuietHours(timestampMs = Date.now()): boolean {
  return nextCrawlAllowedAt(timestampMs) !== timestampMs;
}

/** Elapsed collection time, excluding every planned overnight pause, in constant time. */
export function elapsedCrawlActiveMs(fromMs: number, toMs: number): number {
  function activeTime(timestampMs: number): number {
    const days = Math.floor(timestampMs / DAY_MS);
    const timeOfDay = timestampMs - days * DAY_MS;
    return (
      days * ACTIVE_DAY_MS +
      Math.min(timeOfDay, QUIET_START_MS) +
      Math.max(0, timeOfDay - QUIET_END_MS)
    );
  }
  return Math.max(0, activeTime(toMs) - activeTime(fromMs));
}
