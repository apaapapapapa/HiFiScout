import { isDeepStrictEqual } from "node:util";

export const evidenceBucket = "hifiscout-evidence";
export const requiredQueues = [
  "hifiscout-knowledge-verification",
  "hifiscout-knowledge-verification-dlq",
  "hifiscout-product-audit-export",
  "hifiscout-product-audit-export-dlq",
] as const;

export type LifecycleRule = Record<string, unknown> & { id: string };
export const requiredLifecycleRules: LifecycleRule[] = [
  ["hifiscout-evidence-short", "evidence/short/", 30],
  ["hifiscout-evidence-medium", "evidence/medium/", 90],
  ["hifiscout-evidence-long", "evidence/long/", 365],
  ["hifiscout-product-audit-exports", "product-audit-exports/", 10],
  ["hifiscout-knowledge-catalog-exports", "knowledge-catalog-exports/", 10],
].map(([id, prefix, days]) => ({
  id: String(id),
  enabled: true,
  conditions: { prefix },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: Number(days) * 86400 } },
}));

/** Preserve rules owned by operators/other services; replace only our named policies. */
export function reconcileLifecycleRules(existing: LifecycleRule[]): LifecycleRule[] | null {
  const desired = new Map(requiredLifecycleRules.map((rule) => [rule.id, rule]));
  const merged = existing.map((rule) => {
    const replacement = desired.get(rule.id);
    desired.delete(rule.id);
    return replacement ?? rule;
  });
  merged.push(...desired.values());
  return isDeepStrictEqual(existing, merged) ? null : merged;
}

export interface CloudflareResult {
  result: unknown;
  result_info?: { total_pages?: number };
}
export type ResourceApi = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<CloudflareResult>;

export class ResourceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A single process replaces repeated Wrangler startup; unchanged resources require no writes. */
export async function provisionProductionResources(api: ResourceApi): Promise<void> {
  const bucketPath = `/r2/buckets/${evidenceBucket}`;
  try {
    await api(bucketPath);
  } catch (error) {
    // Authentication, quota and transient failures must never masquerade as missing resources.
    if (!(error instanceof ResourceApiError) || error.status !== 404) throw error;
    await api("/r2/buckets", "POST", { name: evidenceBucket });
  }

  const lifecycle = await api(`${bucketPath}/lifecycle`);
  if (
    !record(lifecycle.result) ||
    !Array.isArray(lifecycle.result.rules) ||
    !lifecycle.result.rules.every((rule) => record(rule) && typeof rule.id === "string")
  ) {
    throw new Error(
      "Cloudflare returned an invalid R2 lifecycle policy; refusing to overwrite it.",
    );
  }
  const rules = reconcileLifecycleRules(lifecycle.result.rules as LifecycleRule[]);
  if (rules) await api(`${bucketPath}/lifecycle`, "PUT", { rules });

  const existing = new Set<string>();
  // Cloudflare returns paginated queues. An empty page is the terminal fallback if metadata is absent.
  for (let page = 1; ; page++) {
    const response = await api(`/queues?page=${page}`);
    if (
      !Array.isArray(response.result) ||
      !response.result.every((queue) => record(queue) && typeof queue.queue_name === "string")
    ) {
      throw new Error("Cloudflare returned an invalid Queue list; refusing to create duplicates.");
    }
    for (const queue of response.result) existing.add((queue as { queue_name: string }).queue_name);
    const totalPages = response.result_info?.total_pages;
    if (
      requiredQueues.every((name) => existing.has(name)) ||
      response.result.length === 0 ||
      (totalPages !== undefined && page >= totalPages)
    )
      break;
    if (page >= 100) throw new Error("Cloudflare Queue pagination exceeded the bounded scan.");
  }
  for (const name of requiredQueues) {
    if (!existing.has(name)) await api("/queues", "POST", { queue_name: name });
  }
  console.log(
    `Production resources reconciled; lifecycle ${rules ? "updated" : "unchanged"}, ${requiredQueues.filter((name) => !existing.has(name)).length} queues created.`,
  );
}

export function cloudflareResourceApi(account: string, token: string): ResourceApi {
  return async (path, method = "GET", body) => {
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Keep Wrangler's protection against lifecycle changes to a Data Catalog bucket.
        "cf-r2-data-catalog-check": "true",
      },
      signal: AbortSignal.timeout(30_000),
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
      options,
    );
    const payload: unknown = await response.json();
    if (!response.ok || !record(payload) || payload.success !== true) {
      throw new ResourceApiError(
        response.status,
        `Cloudflare resource request failed: ${method} ${path} (HTTP ${response.status}).`,
      );
    }
    return payload as unknown as CloudflareResult;
  };
}
