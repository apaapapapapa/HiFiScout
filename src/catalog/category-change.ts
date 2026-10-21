import { isRecord } from "../types.js";

/** Membership order is not a classification change; the primary is compared separately. */
export function categorySet(value: readonly string[] | string | null | undefined): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed)
    ? [
        ...new Set(parsed.filter((id): id is string => typeof id === "string" && Boolean(id))),
      ].sort()
    : [];
}

export interface CategorySnapshot {
  primary: string;
  categories: readonly string[] | string | null | undefined;
  direct: readonly string[] | string | null | undefined;
  status: string;
  aliases: string;
  display: string;
}

export function categoryMembershipChanged(
  previous: CategorySnapshot,
  next: CategorySnapshot,
): boolean {
  return (
    previous.primary !== next.primary ||
    JSON.stringify(categorySet(previous.categories)) !==
      JSON.stringify(categorySet(next.categories)) ||
    JSON.stringify(categorySet(previous.direct)) !== JSON.stringify(categorySet(next.direct))
  );
}

export function categoryResultChanged(previous: CategorySnapshot, next: CategorySnapshot): boolean {
  return (
    categoryMembershipChanged(previous, next) ||
    previous.status !== next.status ||
    previous.aliases !== next.aliases ||
    previous.display !== next.display
  );
}

export function metadataObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

export function categoryRuleVersion(metadata: unknown): number {
  const decision = metadataObject(metadata).categoryClassification;
  return isRecord(decision) &&
    typeof decision.version === "number" &&
    Number.isFinite(decision.version)
    ? decision.version
    : 0;
}

/** Canonicalize only classification audit sets, retaining all evidence and rule/version fields. */
export function canonicalCategoryAudit(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        const entry = value[key];
        if (
          ["categoryIds", "candidateCategoryIds", "directCategoryIds"].includes(key) &&
          Array.isArray(entry)
        )
          return [key, categorySet(entry)];
        if (key === "evidence" && Array.isArray(entry))
          return [
            key,
            entry.map(canonicalCategoryAudit).sort((a, b) => {
              const left = JSON.stringify(a),
                right = JSON.stringify(b);
              return left < right ? -1 : left > right ? 1 : 0;
            }),
          ];
        return [key, isRecord(entry) ? canonicalCategoryAudit(entry) : entry];
      }),
  );
}
