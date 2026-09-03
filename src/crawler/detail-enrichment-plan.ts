/**
 * Which category-detail pages a crawl run intends to fetch, and how far through them it has got.
 *
 * Planning is the expensive half of the detail-enrichment phase: it reads the run's entire staged
 * inventory out of D1 and resolves every staged listing against the catalog. That answer does not
 * change between Alarms of the same run, so doing it per Alarm made enriching M pages cost M full
 * inventory reads and M catalog resolutions, on top of walking the target list from the front and
 * asking D1 about every already-fetched page -- O(M^2) fence lookups for one page of progress.
 *
 * This owns the policy: plan once, remember it, walk it with a cursor. It is deliberately separate
 * from `crawl-scheduler-do.ts`, which imports `cloudflare:workers` and so cannot be executed by the
 * unit suite; here the storage, the planner and the fence are all parameters, which is what lets the
 * behaviour that matters -- planned once, cursor order, empty plans, crash recovery, run isolation
 * -- be asserted rather than inspected.
 */

/** The Durable Object storage surface this needs, and nothing else. */
export interface DetailEnrichmentPlanStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * Durable Object storage key for the plan.
 *
 * Stable across deployments for the same reason as the execution key: an Alarm scheduled by an
 * older isolate has to find the plan the older isolate wrote, or it replans and undoes the point.
 */
export const DETAIL_PLAN_STORAGE_KEY = "phase5_detail_enrichment_plan";

/**
 * Only the target URLs are kept -- deliberately not the staged listings or their HTML, because this
 * lives in Durable Object storage and is rewritten on every cursor advance.
 *
 * `runId` is part of the record rather than the key so a plan belonging to a previous run is
 * recognised and replaced instead of silently reused. That is also why a finished plan is not
 * deleted: deleting it would make "this run has nothing left to fetch" indistinguishable from "this
 * run has not planned yet", and the next Alarm would replan. One superseded record per shop is the
 * cheaper end of that trade.
 */
export interface StoredDetailEnrichmentPlan {
  runId: string;
  targets: string[];
  cursor: number;
}

export interface DetailEnrichmentPlanContext {
  storage: DetailEnrichmentPlanStorage;
  /** The expensive planning pass. Called at most once per run. */
  planTargets(runId: string): Promise<string[]>;
  /** `crawl_fetch_detail_pages`: whether this run already committed an attempt for the URL. */
  isCommitted(runId: string, targetUrl: string): Promise<boolean>;
  /** Structured logging, shaped by the caller so the DO keeps its own event vocabulary. */
  log?(event: DetailEnrichmentPlanEvent): void;
}

export type DetailEnrichmentPlanEvent =
  | { kind: "plan_created"; runId: string; targetCount: number }
  | {
      kind: "already_committed";
      runId: string;
      skipped: number;
      cursor: number;
      targetCount: number;
    };

/**
 * The run's plan, computed on first use and read back afterwards.
 *
 * An empty plan is stored like any other. "Nothing to fetch" and "not planned yet" have to be
 * distinguishable, or a run with no detail targets replans on every Alarm -- the worst case of the
 * behaviour this replaces.
 */
export async function detailEnrichmentPlan(
  context: DetailEnrichmentPlanContext,
  runId: string,
): Promise<StoredDetailEnrichmentPlan> {
  const stored = await context.storage.get<StoredDetailEnrichmentPlan>(DETAIL_PLAN_STORAGE_KEY);
  // A plan from an earlier run is not a plan for this one. Matching on the stored id rather than
  // trusting the key keeps a previous run's targets out of this run's cursor.
  if (stored && stored.runId === runId) return stored;

  const targets = await context.planTargets(runId);
  const plan: StoredDetailEnrichmentPlan = { runId, targets, cursor: 0 };
  await context.storage.put<StoredDetailEnrichmentPlan>(DETAIL_PLAN_STORAGE_KEY, plan);
  context.log?.({ kind: "plan_created", runId, targetCount: targets.length });
  return plan;
}

/**
 * The next target the fence has no record of, advancing the cursor over any that it does.
 *
 * The cursor is an optimisation, not the authority: `crawl_fetch_detail_pages` remains the record of
 * what was actually fetched. That matters for the window between committing a detail page and
 * persisting the advanced cursor -- a kill there leaves the cursor pointing at a target already
 * committed, and re-fetching it would repeat a seller request this run has already made. Skipping it
 * here costs one indexed lookup and leaves the request count unchanged.
 *
 * In the ordinary case the loop runs once, on a target the fence has never seen.
 */
export async function nextUncommittedDetailTarget(
  context: DetailEnrichmentPlanContext,
  plan: StoredDetailEnrichmentPlan,
): Promise<string | null> {
  let cursor = plan.cursor;
  let skipped = 0;
  let found: string | null = null;

  while (cursor < plan.targets.length) {
    const candidate = plan.targets[cursor];
    if (!candidate) {
      cursor += 1;
      continue;
    }
    if (!(await context.isCommitted(plan.runId, candidate))) {
      found = candidate;
      break;
    }
    skipped += 1;
    cursor += 1;
  }

  if (cursor !== plan.cursor) await advanceDetailPlanCursor(context, plan, cursor);
  if (skipped > 0) {
    context.log?.({
      kind: "already_committed",
      runId: plan.runId,
      skipped,
      cursor,
      targetCount: plan.targets.length,
    });
  }
  return found;
}

/**
 * Moves the plan forward.
 *
 * Only ever called once the corresponding detail page is committed to the fence. Advancing first
 * would mean a failure between the two silently drops a target: the cursor would already have passed
 * it and nothing else names it.
 */
export async function advanceDetailPlanCursor(
  context: DetailEnrichmentPlanContext,
  plan: StoredDetailEnrichmentPlan,
  cursor: number,
): Promise<void> {
  plan.cursor = cursor;
  await context.storage.put<StoredDetailEnrichmentPlan>(DETAIL_PLAN_STORAGE_KEY, plan);
}
