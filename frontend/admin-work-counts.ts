import { useCallback, useEffect, useRef, useState } from "react";
import {
  ADMIN_WORK_COUNT_LIMIT,
  type AdminWorkCountsPage,
} from "../src/api/admin-work-counts-contract.js";
import { adminJson } from "./admin-shared.js";
import type { AdminView } from "./admin-navigation.js";

export type AdminWorkCounts = Record<"reports" | "duplicates" | "candidates", number | null>;
const UNKNOWN_COUNTS: AdminWorkCounts = { reports: null, duplicates: null, candidates: null };

export function adminWorkCountLabel(count: number | null): string {
  if (count === null) return "—";
  return count >= ADMIN_WORK_COUNT_LIMIT ? "99+" : String(count);
}

export async function loadAdminWorkCounts(
  publish: (counts: AdminWorkCounts) => void,
  signal: AbortSignal,
): Promise<void> {
  let path = "/api/admin/work-counts";
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const cursors = new Set<string>();
  while (!signal.aborted) {
    const page = await adminJson<AdminWorkCountsPage>(path, { signal });
    if (signal.aborted) return;
    if (
      ![page.reports, page.candidates].every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= ADMIN_WORK_COUNT_LIMIT,
      ) ||
      !Array.isArray(page.duplicateIdentities) ||
      !page.duplicateIdentities.every((key) => typeof key === "string")
    )
      throw new Error("invalid_work_counts");
    for (const identity of page.duplicateIdentities) {
      if (!identity) continue;
      if (seen.has(identity)) duplicates.add(identity);
      else seen.add(identity);
      if (duplicates.size >= ADMIN_WORK_COUNT_LIMIT) break;
    }
    const complete = !page.nextDuplicateCursor || duplicates.size >= ADMIN_WORK_COUNT_LIMIT;
    publish({
      reports: page.reports,
      candidates: page.candidates,
      duplicates: complete ? duplicates.size : null,
    });
    if (complete) return;
    const { bucketKey, afterId } = page.nextDuplicateCursor!;
    if (
      typeof bucketKey !== "string" ||
      !bucketKey ||
      !Number.isSafeInteger(afterId) ||
      afterId <= 0
    )
      throw new Error("invalid_work_count_cursor");
    path = `/api/admin/work-counts?${new URLSearchParams({ afterKey: bucketKey, afterId: String(afterId) })}`;
    if (cursors.has(path)) throw new Error("repeated_work_count_cursor");
    cursors.add(path);
  }
}

export function useAdminWorkCounts(view: AdminView) {
  const [counts, setCounts] = useState<AdminWorkCounts>(UNKNOWN_COUNTS);
  const [revision, setRevision] = useState(0);
  const startedAt = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    // Coalesce CSV writes and consecutive merges into one refresh; never poll while idle.
    const timer = window.setTimeout(() => {
      startedAt.current = Date.now();
      setCounts(UNKNOWN_COUNTS);
      void loadAdminWorkCounts(setCounts, controller.signal).catch(() => {
        // Unknown is not zero. Keep any completed categories if duplicate paging failed.
      });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);

  useEffect(() => {
    const refreshIfStale = () => {
      if (Date.now() - startedAt.current > 60_000) refresh();
    };
    refreshIfStale();
    window.addEventListener("focus", refreshIfStale);
    return () => window.removeEventListener("focus", refreshIfStale);
  }, [view, refresh]);

  return { counts, refresh };
}
