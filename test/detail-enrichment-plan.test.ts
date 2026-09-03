import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  advanceDetailPlanCursor,
  detailEnrichmentProgress,
  detailPlanTargetsKey,
  DETAIL_PLAN_CHUNK_SIZE,
  DETAIL_PLAN_PROGRESS_KEY,
  DETAIL_PLAN_TARGETS_KEY_PREFIX,
  DETAIL_PLAN_VERSION,
  nextUncommittedDetailTarget,
  storedDetailDecisionAt,
  type DetailEnrichmentPlanContext,
  type DetailEnrichmentProgress,
  type DetailEnrichmentTargetChunk,
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
  /** Every storage key read, so a walk that loads the whole plan is visible. */
  reads: string[];
  /** Every storage key written, so rewriting the immutable half is visible. */
  writes: string[];
  /** Every storage key deleted. */
  deletes: string[];
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
  const reads: string[] = [];
  const writes: string[] = [];
  const deletes: string[] = [];
  return {
    planCalls,
    planInstants,
    fenceLookups,
    reads,
    writes,
    deletes,
    committed,
    context: {
      storage: {
        async get<T>(key: string) {
          reads.push(key);
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          writes.push(key);
          // Structured-clone semantics: a stored record must not alias the caller's object, or a
          // mutation after the put would look persisted when it was not.
          storage.set(key, JSON.parse(JSON.stringify(value)));
        },
        async delete(key: string) {
          deletes.push(key);
          storage.delete(key);
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

function targetKeysWritten(held: Harness): string[] {
  return held.writes.filter((key) => key.startsWith(DETAIL_PLAN_TARGETS_KEY_PREFIX));
}

test("the plan is built once per crawl run, however many Alarms run", async () => {
  // The expensive half is planning: it reads the run's staged listing inventory and resolves every
  // staged listing against the catalog. Repeating it per Alarm is the amplification being removed.
  const storage = durableStorage();
  const { context, planCalls } = harness(storage, { [RUN]: TARGETS });

  for (let alarm = 0; alarm < 5; alarm += 1) {
    await detailEnrichmentProgress(context, RUN);
  }

  assert.deepEqual(planCalls, [RUN], "staged inventory load and catalog resolution run once");
});

test("the cursor visits every target in order, one per Alarm", async () => {
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });
  const visited: string[] = [];

  for (let alarm = 0; alarm < TARGETS.length; alarm += 1) {
    const progress = await detailEnrichmentProgress(held.context, RUN);
    const target = await nextUncommittedDetailTarget(held.context, progress);
    assert.ok(target, `alarm ${alarm} should have a target`);
    visited.push(target);
    // What the Durable Object does after the page is committed to the fence.
    held.committed.add(target);
    await advanceDetailPlanCursor(held.context, progress, progress.cursor + 1);
  }

  assert.deepEqual(visited, TARGETS);
  const exhausted = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(await nextUncommittedDetailTarget(held.context, exhausted), null);
  assert.deepEqual(held.planCalls, [RUN]);
});

test("advancing the cursor writes progress only, never the target list", async () => {
  // The Durable Object side of the same amplification: a plan kept in one record re-serialised and
  // rewrote every target on each cursor increment, so walking M targets wrote the list M times.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });

  const created = await detailEnrichmentProgress(held.context, RUN);
  assert.deepEqual(targetKeysWritten(held), [detailPlanTargetsKey(0)], "targets written once");
  const writesAfterPlanning = held.writes.length;

  for (let cursor = 0; cursor < TARGETS.length; cursor += 1) {
    const before = held.writes.length;
    await advanceDetailPlanCursor(held.context, created, cursor + 1);
    assert.deepEqual(
      held.writes.slice(before),
      [DETAIL_PLAN_PROGRESS_KEY],
      `advancing to ${cursor + 1} writes the progress record and nothing else`,
    );
  }

  assert.equal(targetKeysWritten(held).length, 1, "no cursor advance rewrote the immutable half");
  assert.equal(held.writes.length, writesAfterPlanning + TARGETS.length);
});

test("an empty plan is stored, so a run with no targets never replans", async () => {
  // The distinction that matters: "nothing to fetch" and "not planned yet" must not look the same,
  // or the cheapest run pays the planning cost on every Alarm.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: [] });

  const first = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(first.targetCount, 0);
  assert.equal(first.chunkCount, 0);
  assert.equal(await nextUncommittedDetailTarget(held.context, first), null);
  const stored = storage.get(DETAIL_PLAN_PROGRESS_KEY) as DetailEnrichmentProgress;
  assert.equal(stored.targetCount, 0, "the empty plan is persisted");
  assert.deepEqual(targetKeysWritten(held), [], "an empty plan occupies no target records");

  const second = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(await nextUncommittedDetailTarget(held.context, second), null);
  assert.deepEqual(held.planCalls, [RUN], "the second Alarm must not replan");
});

test("a target committed before the cursor advanced is skipped, not re-fetched", async () => {
  // The kill window this exists for: the detail page reached D1, the cursor update did not. The
  // fence is the authority, so the next Alarm must move past the target without asking the seller.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });

  const progress = await detailEnrichmentProgress(held.context, RUN);
  const first = await nextUncommittedDetailTarget(held.context, progress);
  assert.equal(first, TARGETS[0]);
  held.committed.add(TARGETS[0]!); // D1 commit succeeded...
  // ...and the isolate died here, before advanceDetailPlanCursor.

  const recovered = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(recovered.cursor, 0, "the lost cursor update really is lost");
  const next = await nextUncommittedDetailTarget(held.context, recovered);

  assert.equal(next, TARGETS[1], "recovery advances rather than repeating the seller request");
  const persisted = storage.get(DETAIL_PLAN_PROGRESS_KEY) as DetailEnrichmentProgress;
  assert.equal(persisted.cursor, 1, "the skip is persisted so it is paid once");
});

test("a plan belonging to an earlier run is replaced, not inherited", async () => {
  const storage = durableStorage();
  const held = harness(storage, { "run-a": TARGETS, "run-b": ["https://shop.test/z"] });

  const runA = await detailEnrichmentProgress(held.context, "run-a");
  await advanceDetailPlanCursor(held.context, runA, 2);

  const runB = await detailEnrichmentProgress(held.context, "run-b");

  assert.equal(runB.runId, "run-b");
  assert.equal(runB.targetCount, 1);
  assert.equal(runB.cursor, 0, "run B must not inherit run A's position");
  assert.equal(await nextUncommittedDetailTarget(held.context, runB), "https://shop.test/z");
  const chunk = storage.get(detailPlanTargetsKey(0)) as DetailEnrichmentTargetChunk;
  assert.equal(chunk.runId, "run-b", "the target record carries the run it belongs to");
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
    const progress = await detailEnrichmentProgress(held.context, RUN);
    const target = await nextUncommittedDetailTarget(held.context, progress);
    assert.ok(target);
    held.committed.add(target);
    await advanceDetailPlanCursor(held.context, progress, progress.cursor + 1);
    lookupsPerAlarm.push(held.fenceLookups.length - before);
  }

  assert.deepEqual(lookupsPerAlarm, [1, 1, 1]);
});

test("a restarted Durable Object resumes from stored state instead of replanning", async () => {
  const storage = durableStorage();
  const first = harness(storage, { [RUN]: TARGETS });
  const progress = await detailEnrichmentProgress(first.context, RUN);
  const target = await nextUncommittedDetailTarget(first.context, progress);
  assert.ok(target);
  first.committed.add(target);
  await advanceDetailPlanCursor(first.context, progress, progress.cursor + 1);

  // A new instance over the same durable storage: fresh context, nothing carried in memory.
  const restarted = harness(storage, { [RUN]: TARGETS }, first.committed);
  const resumed = await detailEnrichmentProgress(restarted.context, RUN);

  assert.deepEqual(restarted.planCalls, [], "the surviving plan is read, not rebuilt");
  assert.equal(resumed.cursor, 1);
  assert.equal(resumed.targetCount, TARGETS.length, "the immutable half survived too");
  assert.equal(await nextUncommittedDetailTarget(restarted.context, resumed), TARGETS[1]);
});

test("the decided instant is recorded once and survives every later read", async () => {
  // Enrichment eligibility is time-dependent, so finalization has to evaluate it at the instant the
  // plan did rather than at its own. That only works if the instant is part of the record and is not
  // refreshed by the Alarms that walk it.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });
  const planned = new Date("2026-09-01T00:00:00.000Z");
  held.context.now = () => planned;

  const progress = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(progress.decidedAt, planned.toISOString());
  assert.deepEqual(
    held.planInstants,
    [planned.toISOString()],
    "the planner is asked the question at the instant the record keeps",
  );

  // A later Alarm, well past the shop's cache window, and then a cursor advance on top of it.
  held.context.now = () => new Date("2026-09-08T00:00:00.000Z");
  const later = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(later.decidedAt, planned.toISOString(), "the clock moved; the decision did not");
  await advanceDetailPlanCursor(held.context, later, 2);

  assert.equal(
    await storedDetailDecisionAt(held.context.storage, RUN),
    planned.toISOString(),
    "what the Durable Object hands finalization",
  );
  assert.equal(await storedDetailDecisionAt(held.context.storage, "run-b"), undefined);
});

test("a large plan is walked without rewriting or reading all of it per Alarm", async () => {
  // Chunking is what keeps an Alarm's cost independent of the plan's size: the whole point of
  // splitting the record is lost if a cursor increment still touches every target.
  const storage = durableStorage();
  const large = Array.from(
    { length: DETAIL_PLAN_CHUNK_SIZE * 2 + 5 },
    (_, index) => `https://shop.test/large/${index}`,
  );
  const held = harness(storage, { [RUN]: large });

  const created = await detailEnrichmentProgress(held.context, RUN);
  assert.equal(created.targetCount, large.length);
  assert.equal(created.chunkCount, 3);
  assert.deepEqual(targetKeysWritten(held), [
    detailPlanTargetsKey(0),
    detailPlanTargetsKey(1),
    detailPlanTargetsKey(2),
  ]);

  // Walk the whole plan, one Alarm at a time, the way the Durable Object does.
  const writesAfterPlanning = held.writes.length;
  const readsPerAlarm: number[] = [];
  for (let alarm = 0; alarm < large.length; alarm += 1) {
    const before = held.reads.length;
    const progress = await detailEnrichmentProgress(held.context, RUN);
    const target = await nextUncommittedDetailTarget(held.context, progress);
    assert.equal(target, large[alarm]);
    held.committed.add(target);
    await advanceDetailPlanCursor(held.context, progress, progress.cursor + 1);
    readsPerAlarm.push(held.reads.length - before);
  }

  assert.equal(
    targetKeysWritten(held).length,
    3,
    "the target records are written at planning time and never again",
  );
  assert.equal(
    held.writes.length - writesAfterPlanning,
    large.length,
    "one progress write per Alarm, whatever the plan's size",
  );
  assert.deepEqual(
    [...new Set(readsPerAlarm)],
    [2],
    "each Alarm reads the progress record and the one chunk its cursor points into",
  );
});

test("a shorter plan releases the target records the longer one occupied", async () => {
  // Storage the run no longer needs must not accumulate at the high-water mark of every plan the
  // shop has ever made.
  const storage = durableStorage();
  const long = Array.from(
    { length: DETAIL_PLAN_CHUNK_SIZE + 1 },
    (_, index) => `https://shop.test/long/${index}`,
  );
  const held = harness(storage, { "run-a": long, "run-b": ["https://shop.test/short"] });

  await detailEnrichmentProgress(held.context, "run-a");
  assert.equal(storage.has(detailPlanTargetsKey(1)), true);

  await detailEnrichmentProgress(held.context, "run-b");

  assert.deepEqual(held.deletes, [detailPlanTargetsKey(1)]);
  assert.equal(storage.has(detailPlanTargetsKey(1)), false, "the superseded chunk is released");
  assert.equal(storage.has(detailPlanTargetsKey(0)), true, "the chunk run B uses is not");
  assert.equal(
    [...storage.keys()].filter((key) => key.startsWith(DETAIL_PLAN_TARGETS_KEY_PREFIX)).length,
    1,
  );
});

test("a plan stored in an older shape is replanned rather than misread", async () => {
  // A deployment that changes the stored shape leaves records an older isolate wrote. Guessing at
  // them would be worse than replanning, which the D1 fence already makes free of seller requests.
  const storage = durableStorage();
  storage.set(DETAIL_PLAN_PROGRESS_KEY, {
    runId: RUN,
    targets: TARGETS,
    cursor: 2,
    decidedAt: "2026-09-01T00:00:00.000Z",
  });
  const held = harness(storage, { [RUN]: TARGETS });

  const progress = await detailEnrichmentProgress(held.context, RUN);

  assert.deepEqual(held.planCalls, [RUN], "the unreadable record is replaced, not trusted");
  assert.equal(progress.version, DETAIL_PLAN_VERSION);
  assert.equal(progress.cursor, 0);
  assert.equal(await nextUncommittedDetailTarget(held.context, progress), TARGETS[0]);
});

test("a plan whose target records are gone fails loudly instead of skipping targets", async () => {
  // Silently walking past missing targets would drop detail pages finalization goes on to require,
  // which surfaces as a failed crawl far from the cause.
  const storage = durableStorage();
  const held = harness(storage, { [RUN]: TARGETS });
  const progress = await detailEnrichmentProgress(held.context, RUN);
  storage.delete(detailPlanTargetsKey(0));

  await assert.rejects(
    nextUncommittedDetailTarget(held.context, progress),
    /detail enrichment plan chunk 0 missing/u,
  );
});
