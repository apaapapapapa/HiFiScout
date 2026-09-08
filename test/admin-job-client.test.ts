import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { submitAdminCsvJob } from "../frontend/admin-job-client.js";
import {
  ADMIN_CSV_MAX_REQUEST_BYTES,
  type AdminCsvApplyInput,
  type AdminJobCommand,
} from "../src/api/admin-csv-contracts.js";

test("upload bounds the full UTF-8 envelope and resumes after the acknowledged offset", async () => {
  const originalFetch = globalThis.fetch;
  const id = crypto.randomUUID();
  const values = {
    manufacturer_id: "luxman",
    model: "長".repeat(4096),
    primary_category_id: "unclassified",
  };
  const inputs: AdminCsvApplyInput[] = Array.from({ length: 44 }, (_, i) => ({
    change: { line: i + 1, original: { version: 1, kind: "listing", id: i + 1, values }, values },
    revision: "a".repeat(64),
    operationId: crypto.randomUUID(),
  }));
  const commands: AdminJobCommand[] = [];
  let uploaded = 7;
  globalThis.fetch = async (_url, init) => {
    const body = String(init?.body);
    assert.ok(new TextEncoder().encode(body).byteLength <= ADMIN_CSV_MAX_REQUEST_BYTES);
    const command = JSON.parse(body) as AdminJobCommand;
    commands.push(command);
    if (command.action === "append") {
      assert.equal(command.offset, uploaded);
      assert.ok(command.items.length <= 20);
      assert.deepEqual(command.items, inputs.slice(uploaded, uploaded + command.items.length));
      uploaded += command.items.length;
    }
    if (command.action === "start") assert.equal(uploaded, inputs.length);
    return Response.json({
      job: { id, status: command.action === "start" ? "queued" : "uploading", uploaded },
    });
  };
  try {
    const job = await submitAdminCsvJob(
      id,
      "large",
      inputs,
      new AbortController().signal,
      () => {},
    );
    assert.equal(job.status, "queued");
    assert.ok(commands.filter((c) => c.action === "append").length > 2);
    assert.equal(commands[0].action, "create");
    assert.equal(commands.at(-1)?.action, "start");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retrying an accepted job neither uploads nor starts it again", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ job: { status: "completed" } });
  };
  try {
    const job = await submitAdminCsvJob(
      crypto.randomUUID(),
      "accepted",
      [],
      new AbortController().signal,
      () => {},
    );
    assert.equal(job.status, "completed");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
