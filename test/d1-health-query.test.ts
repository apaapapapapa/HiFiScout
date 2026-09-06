import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const helper = fileURLToPath(new URL("../scripts/lib/d1-health-query.sh", import.meta.url));
const meta = { rows_read: 42, rows_written: 0, duration: 1.5 };
const resultRows = [{ value: "private-result" }];
const success = JSON.stringify([{ success: true, results: resultRows, meta }]);

interface Usage {
  event: string;
  query: string;
  attempt: number;
  statementIndex: number;
  outcome: string;
  rowsRead: number | null;
  rowsWritten: number | null;
  durationMs: number | null;
  metadataPresent: boolean;
}

function runQuery(responses: readonly { body: string; status?: number }[]) {
  const directory = mkdtempSync(join(tmpdir(), "d1-health-query-"));
  try {
    writeFileSync(join(directory, "calls"), "0");
    responses.forEach((response, index) => {
      writeFileSync(join(directory, `body-${index + 1}`), response.body);
      writeFileSync(join(directory, `status-${index + 1}`), String(response.status ?? 0));
    });
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
        source "$1"
        D1_QUERY_RETRY_SECONDS=0
        npx() {
          local attempt
          attempt=$(($(cat "$D1_TEST_DIRECTORY/calls") + 1))
          printf '%s' "$attempt" > "$D1_TEST_DIRECTORY/calls"
          cat "$D1_TEST_DIRECTORY/body-$attempt"
          return "$(cat "$D1_TEST_DIRECTORY/status-$attempt")"
        }
        query "SELECT 'private-sql'" "test.health"
        `,
        "test",
        helper,
      ],
      { encoding: "utf8", env: { ...process.env, D1_TEST_DIRECTORY: directory }, timeout: 5_000 },
    );
    assert.ifError(result.error);
    const usage: Usage[] = result.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"event":"operational_health_d1_query"'))
      .map((line) => JSON.parse(line) as Usage);
    assert.doesNotMatch(result.stderr, /private-sql|private-result/);
    assert.ok(usage.every((item) => item.query === "test.health"));
    return { ...result, usage, calls: Number(readFileSync(join(directory, "calls"), "utf8")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("health query preserves result stdout and logs metadata without extra database requests", () => {
  const result = runQuery([{ body: success }]);
  assert.equal(result.status, 0);
  assert.equal(result.calls, 1);
  assert.deepEqual(JSON.parse(result.stdout), resultRows);
  assert.deepEqual(result.usage, [
    {
      event: "operational_health_d1_query",
      query: "test.health",
      attempt: 1,
      statementIndex: 0,
      outcome: "success",
      rowsRead: 42,
      rowsWritten: 0,
      durationMs: 1.5,
      metadataPresent: true,
    },
  ]);
});

test("health query reports each statement once, including zero-valued metadata", () => {
  const result = runQuery([
    {
      body: JSON.stringify([
        { success: true, results: resultRows, meta },
        { success: true, results: [], meta: { rows_read: 0, rows_written: 0, duration: 0 } },
      ]),
    },
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.calls, 1);
  assert.deepEqual(JSON.parse(result.stdout), resultRows);
  assert.deepEqual(
    result.usage.map((item) => [
      item.statementIndex,
      item.rowsRead,
      item.rowsWritten,
      item.durationMs,
    ]),
    [
      [0, 42, 0, 1.5],
      [1, 0, 0, 0],
    ],
  );
});

test("missing or invalid health metadata is unknown rather than a fabricated zero", () => {
  for (const metadata of [undefined, null, "invalid", { rows_read: -1, rows_written: "0" }]) {
    const result = runQuery([{ body: JSON.stringify([{ results: [], meta: metadata }]) }]);
    assert.equal(result.status, 0);
    assert.equal(result.calls, 1);
    assert.equal(result.usage.length, 1);
    assert.equal(result.usage[0]?.rowsRead, null);
    assert.equal(result.usage[0]?.rowsWritten, null);
    assert.equal(result.usage[0]?.durationMs, null);
    assert.equal(result.usage[0]?.metadataPresent, false);
  }
});

test("health query retains metadata for invalid results before a successful retry", () => {
  const result = runQuery([{ body: JSON.stringify([{ results: null, meta }]) }, { body: success }]);
  assert.equal(result.status, 0);
  assert.equal(result.calls, 2);
  assert.deepEqual(JSON.parse(result.stdout), resultRows);
  assert.deepEqual(
    result.usage.map((item) => [item.attempt, item.outcome, item.rowsRead]),
    [
      [1, "invalid_response", 42],
      [2, "success", 42],
    ],
  );
});

test("health query logs failed attempts and does not treat malformed JSON as empty success", () => {
  const result = runQuery([{ body: "", status: 1 }, { body: "not JSON" }, { body: success }]);
  assert.equal(result.status, 0);
  assert.equal(result.calls, 3);
  assert.deepEqual(JSON.parse(result.stdout), resultRows);
  assert.deepEqual(
    result.usage.map((item) => [item.attempt, item.outcome, item.rowsRead]),
    [
      [1, "request_failed", null],
      [2, "invalid_response", null],
      [3, "success", 42],
    ],
  );
});

test("health query fails closed after its bounded retries", () => {
  const result = runQuery([
    { body: "[]" },
    { body: JSON.stringify([{ success: false, results: [], meta }]) },
    { body: "", status: 1 },
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.calls, 3);
  assert.equal(result.stdout, "");
  assert.equal(result.usage.length, 3);
  assert.deepEqual(
    result.usage.map((item) => item.rowsRead),
    [null, 42, null],
  );
});
