import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import example from "../.github/harness/loop.example.json";
import {
  appendLoopEvent,
  createLoopRun,
  parseLoopRun,
  readLoopRun,
} from "../scripts/harness/loop/state.js";

test("loop journals preserve prior history on stale writes, contract edits and abandoned locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-state-"));
  const path = join(dir, "state.json");
  try {
    const run = await createLoopRun(example, path, "2026-09-13T00:00:00Z");
    const next = await appendLoopEvent(
      path,
      run.revision,
      run.specDigest,
      "heartbeat",
      { stage: "triage" },
      "2026-09-13T00:00:01Z",
    );
    assert.equal(next.revision, 2);
    assert.deepEqual(await readLoopRun(path), next);
    const before = await readFile(path, "utf8");
    await assert.rejects(
      appendLoopEvent(path, 1, run.specDigest, "stopped", {}),
      /revision_conflict/u,
    );
    await assert.rejects(appendLoopEvent(path, 2, "changed", "stopped", {}), /contract_changed/u);
    await assert.rejects(
      appendLoopEvent(path, 2, run.specDigest, "stopped", {}, "2026-09-12T00:00:00Z"),
      /history_changed/u,
    );
    await writeFile(`${path}.lock`, "active writer");
    await assert.rejects(appendLoopEvent(path, 2, run.specDigest, "stopped", {}), /EEXIST/u);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(await readFile(`${path}.lock`, "utf8"), "active writer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edited or truncated history cannot silently become a valid resume point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-integrity-"));
  try {
    const run = await createLoopRun(example, join(dir, "state.json"));
    assert.throws(
      () => parseLoopRun({ ...run, spec: { ...run.spec, allowedPaths: ["src"] } }),
      /contract_changed/u,
    );
    assert.throws(
      () => parseLoopRun({ ...run, events: [{ ...run.events[0], data: { changed: true } }] }),
      /history_changed/u,
    );
    assert.throws(() => parseLoopRun({ ...run, revision: 2 }), /revision_or_interval/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
