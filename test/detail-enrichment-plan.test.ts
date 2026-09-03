import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  advanceDetailPlanCursor,
  DETAIL_PLAN_STORAGE_KEY,
  detailEnrichmentPlan,
  nextUncommittedDetailTarget,
  type DetailEnrichmentPlanContext,
  type StoredDetailEnrichmentPlan,
} from "../src/crawler/detail-enrichment-plan.js";

/**
 * Durable Object storage survives the isolate, so the fake is a value that outlives the context
 * built around it -- that is what lets a "restart" be expressed as a second context over the same
 * map rather than as a mock of the runtime.
 */
function durableStorage(): Map<string, unknown> {
  return new Map<string, unknown>();
}

interface Harness {
  context: DetailEnrichmentPlanContext;
  /** Every call to the expensive planning pass. */
  planCalls: string[];
  /** The instant each planning pass was asked to evaluate the enrichment policy at. */
  planInstants: string[];
  /** Every fence lookup, so a linear rescan of processed targets is visible as growth. */
  fenceLookups: string[];
  /** URLs the fence considers already attempted by this run. */
  committed: Set<string>;
}

function harness(
  storage: Map<string, unknown>,
  targetsByRun: Record<string, string[]>,
  committed = new Set<string>(),
): Harness {
  const planCalls: string[] = [];
  const planInstants: string[] = [];
  const fenceLookups: string[] = [];
  return {
    planCalls,
    planInstants,
    fenceLookups,
    committed,
    context: {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          // Structured-clone semantics: a stored plan must not alias the caller's object, or a
          // mutation after the put would look persisted when it was not.
          storage.set(key, JSON.parse(JSON.stringify(value)));
        },
      },
      async planTargets(runId: string, decidedAt: Date) {
        planCalls.push(runId);
        planInstants.push(decidedAt.toISOString());
        return targetsByRun[runId] ?? [];
      },
      async isCommitted(_runId: string, targetUrl: string) {
        fenceLookups.push(targetUrl);
        return committed.has(targetUrl);
      },
    },
  };
}

const RUN = "run-a";
const TARGETS = ["https://shop.test/a", "https://shop.test/b", "https://shop.test/c"];

test("the plan is built once per crawl run, however many Alarms run", async () => {
  // The expensive half is planning: it reads the run's whole staged inventory and resolves every
  // staged listing against the catalog. Repeating it per Alarm is the amplification being removed.
  const storage = durableStorage();
  const { context, planCalls } = harness(storage, { [RUN]: TARGETS });

  for (let alarm = 0; alarm < 5; alarm += 1) {
    await detailEnrichmentPlan(context, RUN);
  }

  assert.deepEqual(planCalls, [RUN], "staged inventory load and catalog resolution run once");
});

test("the cursor visits every target in order, one per Alarm", async () => {
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });
  const visited: string[] = [];

  for (let alarm = 0; alarm < TARGETS.length; alarm += 1) {
    const plan = await detailEnrichmentPlan(held.context, RUN);
    const target = await nextUncommittedDetailTarget(held.context, plan);
    assert.ok(target, `alarm ${alarm} should have a target`);
    visited.push(target);
    // What the Durable Object does after the page is committed to the fence.
    held.committed.add(target);
    await advanceDetailPlanCursor(held.context, plan, plan.cursor + 1);
  }

  assert.deepEqual(visited, TARGETS);
  const exhausted = await detailEnrichmentPlan(held.context, RUN);
  assert.equal(await nextUncommittedDetailTarget(held.context, exhausted), null);
  assert.deepEqual(held.planCalls, [RUN]);
});

test("an empty plan is stored, so a run with no targets never replans", async () => {
  // The distinction that matters: "nothing to fetch" and "not planned yet" must not look the same,
  // or the cheapest run pays the planning cost on every Alarm.
  const storage = durableStorage();
  const { context, planCalls } = harness(storage, { [RUN]: [] });

  const first = await detailEnrichmentPlan(context, RUN);
  assert.deepEqual(first.targets, []);
  assert.equal(await nextUncommittedDetailTarget(context, first), null);
  assert.ok(storage.has(DETAIL_PLAN_STORAGE_KEY), "the empty plan is persisted");

  const second = await detailEnrichmentPlan(context, RUN);
  assert.equal(await nextUncommittedDetailTarget(context, second), null);
  assert.deepEqual(planCalls, [RUN], "the second Alarm must not replan");
});

test("a target committed before the cursor advanced is skipped, not re-fetched", async () => {
  // The kill window this exists for: the detail page reached D1, the cursor update did not. The
  // fence is the authority, so the next Alarm must move past the target without asking the seller.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });

  const plan = await detailEnrichmentPlan(held.context, RUN);
  const first = await nextUncommittedDetailTarget(held.context, plan);
  assert.equal(first, TARGETS[0]);
  held.committed.add(TARGETS[0]!); // D1 commit succeeded...
  // ...and the isolate died here, before advanceDetailPlanCursor.

  const recovered = await detailEnrichmentPlan(held.context, RUN);
  assert.equal(recovered.cursor, 0, "the lost cursor update really is lost");
  const next = await nextUncommittedDetailTarget(held.context, recovered);

  assert.equal(next, TARGETS[1], "recovery advances rather than repeating the seller request");
  const persisted = storage.get(DETAIL_PLAN_STORAGE_KEY) as StoredDetailEnrichmentPlan;
  assert.equal(persisted.cursor, 1, "the skip is persisted so it is paid once");
});

test("a plan belonging to an earlier run is replaced, not inherited", async () => {
  const storage = durableStorage();
  const held = harness(storage, { "run-a": TARGETS, "run-b": ["https://shop.test/z"] });

  const runA = await detailEnrichmentPlan(held.context, "run-a");
  await advanceDetailPlanCursor(held.context, runA, 2);

  const runB = await detailEnrichmentPlan(held.context, "run-b");

  assert.equal(runB.runId, "run-b");
  assert.deepEqual(runB.targets, ["https://shop.test/z"]);
  assert.equal(runB.cursor, 0, "run B must not inherit run A's position");
  assert.deepEqual(held.planCalls, ["run-a", "run-b"]);
});

test("walking the plan does not rescan the targets already behind the cursor", async () => {
  // The old shape asked the fence about every processed target on every Alarm, so the lookups grew
  // with progress. Bounded work per Alarm is the property; one lookup is the steady state.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });
  const lookupsPerAlarm: number[] = [];

  for (let alarm = 0; alarm < TARGETS.length; alarm += 1) {
    const before = held.fenceLookups.length;
    const plan = await detailEnrichmentPlan(held.context, RUN);
    const target = await nextUncommittedDetailTarget(held.context, plan);
    assert.ok(target);
    held.committed.add(target);
    await advanceDetailPlanCursor(held.context, plan, plan.cursor + 1);
    lookupsPerAlarm.push(held.fenceLookups.length - before);
  }

  assert.deepEqual(lookupsPerAlarm, [1, 1, 1]);
});

test("a restarted Durable Object resumes from stored state instead of replanning", async () => {
  const storage = durableStorage();
  const first = harness(storage, { [RUN]: TARGETS });
  const plan = await detailEnrichmentPlan(first.context, RUN);
  const target = await nextUncommittedDetailTarget(first.context, plan);
  assert.ok(target);
  first.committed.add(target);
  await advanceDetailPlanCursor(first.context, plan, plan.cursor + 1);

  // A new instance over the same durable storage: fresh context, nothing carried in memory.
  const restarted = harness(storage, { [RUN]: TARGETS }, first.committed);
  const resumed = await detailEnrichmentPlan(restarted.context, RUN);

  assert.deepEqual(restarted.planCalls, [], "the surviving plan is read, not rebuilt");
  assert.equal(resumed.cursor, 1);
  assert.equal(await nextUncommittedDetailTarget(restarted.context, resumed), TARGETS[1]);
});

test("the decided instant is recorded once and survives every later read", async () => {
  // Enrichment eligibility is time-dependent, so finalization has to evaluate it at the instant the
  // plan did rather than at its own. That only works if the instant is part of the plan and is not
  // refreshed by the Alarms that walk it.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });
  const planned = new Date("2026-09-01T00:00:00.000Z");
  held.context.now = () => planned;

  const plan = await detailEnrichmentPlan(held.context, RUN);
  assert.equal(plan.decidedAt, planned.toISOString());
  assert.deepEqual(
    held.planInstants,
    [planned.toISOString()],
    "the planner is asked the question at the instant the plan records",
  );

  // A later Alarm, well past the shop's cache window, and then a cursor advance on top of it.
  held.context.now = () => new Date("2026-09-08T00:00:00.000Z");
  const later = await detailEnrichmentPlan(held.context, RUN);
  assert.equal(later.decidedAt, planned.toISOString(), "the clock moved; the decision did not");
  await advanceDetailPlanCursor(held.context, later, 2);

  const persisted = storage.get(DETAIL_PLAN_STORAGE_KEY) as StoredDetailEnrichmentPlan;
  assert.equal(persisted.decidedAt, planned.toISOString());
  assert.equal(persisted.cursor, 2, "walking the plan rewrites it without disturbing the instant");
});
