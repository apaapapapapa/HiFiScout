/**
 * Which category-detail pages a crawl run intends to fetch, and how far through them it has got.
 *
 * Planning is the expensive half of the detail-enrichment phase: it reads the run's staged listing
 * inventory out of D1 and resolves every staged listing against the catalog. That answer does not
 * change between Alarms of the same run, so doing it per Alarm made enriching M pages cost M
 * inventory reads and M catalog resolutions, on top of walking the target list from the front and
 * asking D1 about every already-fetched page -- O(M^2) fence lookups for one page of progress.
 *
 * This owns the policy: plan once, remember it, walk it with a cursor. The record is split in two,
 * because the two halves change at completely different rates. The target list is decided once and
 * never touched again; the cursor changes on every Alarm. Keeping them in one record meant each
 * cursor increment re-serialised and rewrote the entire target list -- trading the D1 amplification
 * this replaces for a Durable Object one. So the targets live in immutable chunk records and the
 * cursor lives in a small progress record, and an Alarm writes only the latter.
 *
 * It is deliberately separate from `crawl-scheduler-do.ts`, which imports `cloudflare:workers` and
 * so cannot be executed by the unit suite; here the storage, the planner and the fence are all
 * parameters, which is what lets the behaviour that matters -- planned once, cursor order, empty
 * plans, crash recovery, run isolation, bounded writes -- be asserted rather than inspected.
 */

/** The Durable Object storage surface this needs, and nothing else. */
export interface DetailEnrichmentPlanStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Durable Object storage key for the mutable half of the plan.
 *
 * Stable across deployments for the same reason as the execution key: an Alarm scheduled by an
 * older isolate has to find the record the older isolate wrote, or it replans and undoes the point.
 * {@link DETAIL_PLAN_VERSION} is what makes that safe across a *shape* change -- see below.
 */
export const DETAIL_PLAN_PROGRESS_KEY = "phase5_detail_enrichment_progress";

/** Key prefix for the immutable half. One record per chunk of targets. */
export const DETAIL_PLAN_TARGETS_KEY_PREFIX = "phase5_detail_enrichment_targets:";

/**
 * Where the previous release kept the whole plan, targets inline.
 *
 * A separate key rather than a reuse of it, so that rolling *back* to that release finds its own
 * shape rather than one it would read as a plan with no targets. The cost of that choice is that
 * this release cannot see an in-flight run's plan either -- which is what {@link adoptLegacyPlan}
 * exists to fix, because silently replanning is not free: replanning evaluates the time-dependent
 * eligibility policy at a later instant, and a cache entry that expired since the original plan
 * would add a target the fence has never seen, costing the run a seller request it had not budgeted.
 */
export const LEGACY_DETAIL_PLAN_KEY = "phase5_detail_enrichment_plan";

/** The previous release's record, read only to carry a run that spans this deployment. */
interface LegacyDetailEnrichmentPlan {
  runId: string;
  targets: string[];
  cursor: number;
  decidedAt: string;
}

/**
 * Shape version of the stored progress record.
 *
 * A record written by an isolate that stored the plan differently is not readable as this shape, and
 * guessing at it would be worse than replanning. So an unrecognised version is treated as no plan:
 * the run replans once, which the D1 fence makes free of extra seller requests. At most one run per
 * shop pays that, and only across a deployment that changes this shape.
 */
export const DETAIL_PLAN_VERSION = 2;

/**
 * Targets per chunk record.
 *
 * The list is bounded by the shop's own detail budget -- `maxRequestsPerCrawl`, 10 and 20 in the
 * current inventory -- because the planner stops selecting targets once the budget is spent. At a
 * detail URL of roughly 50-60 bytes this holds every plan those shops can produce in a single
 * record, so the common case is one chunk read per Alarm and no chunk writes at all after planning.
 * It is a chunk size rather than "one record" so that raising a shop's budget changes how many
 * records a plan occupies, not how much a cursor increment has to read.
 */
export const DETAIL_PLAN_CHUNK_SIZE = 64;

export function detailPlanTargetsKey(chunkIndex: number): string {
  return `${DETAIL_PLAN_TARGETS_KEY_PREFIX}${chunkIndex}`;
}

/**
 * The mutable half: where the run has got to, and the facts an Alarm needs before reading a target.
 *
 * `runId` is part of the record rather than the key so a plan belonging to a previous run is
 * recognised and replaced instead of silently reused. That is also why a finished plan is not
 * deleted: deleting it would make "this run has nothing left to fetch" indistinguishable from "this
 * run has not planned yet", and the next Alarm would replan. One superseded record per shop is the
 * cheaper end of that trade.
 */
export interface DetailEnrichmentProgress {
  runId: string;
  targetCount: number;
  chunkCount: number;
  cursor: number;
  /**
   * The instant the enrichment policy was evaluated, carried so finalization can evaluate it again
   * at the same instant.
   *
   * Eligibility is time-dependent: a listing whose unresolved category was checked recently is
   * suppressed until `cacheHours` elapses, and then becomes a target. Planning once and finalizing
   * later therefore asks the same question of two different clocks, and a cache entry expiring
   * between them yields a URL that finalization requires but the plan never fetched -- which
   * `requireStagedDetailFetches` turns into a failed crawl. Freezing the instant makes the two
   * agree by construction rather than by how long the paced fetches happened to take.
   */
  decidedAt: string;
  version: number;
}

/** The immutable half: a slice of the target list, written once at planning time. */
export interface DetailEnrichmentTargetChunk {
  runId: string;
  chunkIndex: number;
  targets: string[];
}

export interface DetailEnrichmentPlanContext {
  storage: DetailEnrichmentPlanStorage;
  /** The expensive planning pass. Called at most once per run, at the instant it is given. */
  planTargets(runId: string, decidedAt: Date): Promise<string[]>;
  /** `crawl_fetch_detail_pages`: whether this run already committed an attempt for the URL. */
  isCommitted(runId: string, targetUrl: string): Promise<boolean>;
  /** Structured logging, shaped by the caller so the DO keeps its own event vocabulary. */
  log?(event: DetailEnrichmentPlanEvent): void;
  /** Overridable clock; the planning instant is stored on the progress record. */
  now?(): Date;
}

export type DetailEnrichmentPlanEvent =
  | {
      kind: "plan_created";
      runId: string;
      targetCount: number;
      chunkCount: number;
      /** Whether the targets were computed now, or carried over from the previous release. */
      source: "planned" | "adopted";
    }
  | {
      kind: "already_committed";
      runId: string;
      skipped: number;
      cursor: number;
      targetCount: number;
    };

function chunkCountFor(targetCount: number): number {
  return Math.ceil(targetCount / DETAIL_PLAN_CHUNK_SIZE);
}

function isCurrentProgress(
  stored: DetailEnrichmentProgress | undefined,
  runId: string,
): stored is DetailEnrichmentProgress {
  return Boolean(stored && stored.version === DETAIL_PLAN_VERSION && stored.runId === runId);
}

/**
 * This run's progress record, computed on first use and read back afterwards.
 *
 * An empty plan is stored like any other. "Nothing to fetch" and "not planned yet" have to be
 * distinguishable, or a run with no detail targets replans on every Alarm -- the worst case of the
 * behaviour this replaces.
 */
export async function detailEnrichmentProgress(
  context: DetailEnrichmentPlanContext,
  runId: string,
): Promise<DetailEnrichmentProgress> {
  const stored = await context.storage.get<DetailEnrichmentProgress>(DETAIL_PLAN_PROGRESS_KEY);
  // Read before the guard below narrows `stored` away: a record this run is about to supersede is
  // exactly the one whose chunk keys may outlive it.
  const supersededChunkCount = stored?.chunkCount ?? 0;
  // A plan from an earlier run is not a plan for this one. Matching on the stored id rather than
  // trusting the key keeps a previous run's targets out of this run's cursor.
  if (isCurrentProgress(stored, runId)) return stored;

  const adopted = await adoptLegacyPlan(context, runId, supersededChunkCount);
  if (adopted) return adopted;

  const decidedAt = context.now?.() ?? new Date();
  const targets = await context.planTargets(runId, decidedAt);
  return storePlan(context, {
    runId,
    targets,
    cursor: 0,
    decidedAt: decidedAt.toISOString(),
    supersededChunkCount,
    source: "planned",
  });
}

/**
 * Writes a plan as a progress record plus its immutable target chunks.
 *
 * Chunks first, then the progress record that makes them reachable. The reverse order would publish
 * a target count whose targets are not all stored yet, and a kill in between would leave an Alarm
 * reading past the end of what exists.
 */
async function storePlan(
  context: DetailEnrichmentPlanContext,
  input: {
    runId: string;
    targets: readonly string[];
    cursor: number;
    decidedAt: string;
    supersededChunkCount: number;
    source: "planned" | "adopted";
  },
): Promise<DetailEnrichmentProgress> {
  const chunkCount = chunkCountFor(input.targets.length);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const offset = chunkIndex * DETAIL_PLAN_CHUNK_SIZE;
    await context.storage.put<DetailEnrichmentTargetChunk>(detailPlanTargetsKey(chunkIndex), {
      runId: input.runId,
      chunkIndex,
      targets: input.targets.slice(offset, offset + DETAIL_PLAN_CHUNK_SIZE),
    });
  }
  // A previous run's plan may have occupied more chunks than this one does. Those records are never
  // read -- reads are bounded by this run's `chunkCount` and check the id they carry -- but leaving
  // them would let a shop's storage keep the high-water mark of every plan it has ever made.
  for (let chunkIndex = chunkCount; chunkIndex < input.supersededChunkCount; chunkIndex += 1) {
    await context.storage.delete(detailPlanTargetsKey(chunkIndex));
  }

  const progress: DetailEnrichmentProgress = {
    runId: input.runId,
    targetCount: input.targets.length,
    chunkCount,
    cursor: input.cursor,
    decidedAt: input.decidedAt,
    version: DETAIL_PLAN_VERSION,
  };
  await context.storage.put<DetailEnrichmentProgress>(DETAIL_PLAN_PROGRESS_KEY, progress);
  context.log?.({
    kind: "plan_created",
    runId: input.runId,
    targetCount: input.targets.length,
    chunkCount,
    source: input.source,
  });
  return progress;
}

/**
 * Carries a run that was already in flight when this release was deployed.
 *
 * Without this the run would find no progress record and replan -- which is not the free operation
 * it looks like. Replanning evaluates the time-dependent eligibility policy at a *later* instant, so
 * an unresolved check that expired since the original plan turns into a target the fence has never
 * seen, and the run makes a seller request its budget never accounted for. Adopting the previous
 * record keeps the run's targets, its position in them, and above all the instant they were decided
 * at, so nothing about what it fetches changes.
 *
 * The legacy record is removed either way: adopted, it has been superseded; belonging to another
 * run, it is a leftover that nothing will read again.
 */
async function adoptLegacyPlan(
  context: DetailEnrichmentPlanContext,
  runId: string,
  supersededChunkCount: number,
): Promise<DetailEnrichmentProgress | null> {
  const legacy = await context.storage.get<LegacyDetailEnrichmentPlan>(LEGACY_DETAIL_PLAN_KEY);
  const usable =
    legacy?.runId === runId &&
    Array.isArray(legacy.targets) &&
    legacy.targets.every((target) => typeof target === "string") &&
    typeof legacy.decidedAt === "string" &&
    Boolean(legacy.decidedAt);
  if (!legacy || !usable) {
    if (legacy) await context.storage.delete(LEGACY_DETAIL_PLAN_KEY);
    return null;
  }

  const adopted = await storePlan(context, {
    runId,
    targets: legacy.targets,
    // A cursor outside the target list would let the walk read past the end; the fence would still
    // prevent a repeated request, but the plan would look finished when it is not.
    cursor: Math.min(Math.max(Math.trunc(legacy.cursor) || 0, 0), legacy.targets.length),
    decidedAt: legacy.decidedAt,
    supersededChunkCount,
    source: "adopted",
  });
  // After the new records exist, never before: a kill in between leaves the legacy record readable
  // and the adoption simply happens again.
  await context.storage.delete(LEGACY_DETAIL_PLAN_KEY);
  return adopted;
}

/**
 * The instant an existing plan for `runId` was decided at, or nothing if it has none.
 *
 * Read-only on purpose: finalization needs the instant, and a run that never entered the detail
 * phase must not be made to plan just to answer that.
 */
export async function storedDetailDecisionAt(
  storage: DetailEnrichmentPlanStorage,
  runId: string,
): Promise<string | undefined> {
  const stored = await storage.get<DetailEnrichmentProgress>(DETAIL_PLAN_PROGRESS_KEY);
  return isCurrentProgress(stored, runId) ? stored.decidedAt : undefined;
}

async function readTargetChunk(
  context: DetailEnrichmentPlanContext,
  progress: DetailEnrichmentProgress,
  chunkIndex: number,
): Promise<DetailEnrichmentTargetChunk> {
  const chunk = await context.storage.get<DetailEnrichmentTargetChunk>(
    detailPlanTargetsKey(chunkIndex),
  );
  // The progress record says these targets exist. If they do not, the plan is not walkable and
  // quietly skipping the missing ones would drop detail pages that finalization goes on to require.
  if (!chunk || chunk.runId !== progress.runId) {
    throw new Error(`detail enrichment plan chunk ${chunkIndex} missing for run ${progress.runId}`);
  }
  return chunk;
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
 * In the ordinary case the loop runs once, on a target the fence has never seen, and reads the one
 * chunk the cursor points into.
 */
export async function nextUncommittedDetailTarget(
  context: DetailEnrichmentPlanContext,
  progress: DetailEnrichmentProgress,
): Promise<string | null> {
  let cursor = progress.cursor;
  let skipped = 0;
  let found: string | null = null;
  let loaded: DetailEnrichmentTargetChunk | null = null;

  while (cursor < progress.targetCount) {
    const chunkIndex = Math.floor(cursor / DETAIL_PLAN_CHUNK_SIZE);
    if (loaded?.chunkIndex !== chunkIndex) {
      loaded = await readTargetChunk(context, progress, chunkIndex);
    }
    const candidate = loaded.targets[cursor % DETAIL_PLAN_CHUNK_SIZE];
    if (!candidate) {
      cursor += 1;
      continue;
    }
    if (!(await context.isCommitted(progress.runId, candidate))) {
      found = candidate;
      break;
    }
    skipped += 1;
    cursor += 1;
  }

  if (cursor !== progress.cursor) await advanceDetailPlanCursor(context, progress, cursor);
  if (skipped > 0) {
    context.log?.({
      kind: "already_committed",
      runId: progress.runId,
      skipped,
      cursor,
      targetCount: progress.targetCount,
    });
  }
  return found;
}

/**
 * Moves the plan forward.
 *
 * Writes the progress record and nothing else: the targets are immutable, so an Alarm's write is a
 * handful of fields whatever the plan's size. Only ever called once the corresponding detail page is
 * committed to the fence -- advancing first would mean a failure between the two silently drops a
 * target, because the cursor would already have passed it and nothing else names it.
 */
export async function advanceDetailPlanCursor(
  context: DetailEnrichmentPlanContext,
  progress: DetailEnrichmentProgress,
  cursor: number,
): Promise<void> {
  progress.cursor = cursor;
  await context.storage.put<DetailEnrichmentProgress>(DETAIL_PLAN_PROGRESS_KEY, progress);
}
