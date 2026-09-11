import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs the real shell orchestration without network, D1 credentials or wall-clock sleeps. */
export function runHealthScript(
  script: string,
  responses: readonly unknown[][],
  environment: Record<string, string> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "health-cli-"));
  try {
    writeFileSync(join(directory, "calls"), "0");
    writeFileSync(join(directory, "clock"), "100");
    responses.forEach((results, index) =>
      writeFileSync(
        join(directory, `response-${index + 1}`),
        JSON.stringify([{ success: true, results, meta: { rows_read: 1, rows_written: 0 } }]),
      ),
    );
    writeFileSync(
      join(directory, "npx"),
      `#!/bin/bash
set -euo pipefail
count=$(($(cat "$HEALTH_CLI_DIRECTORY/calls") + 1))
printf '%s' "$count" > "$HEALTH_CLI_DIRECTORY/calls"
while [ "$#" -gt 0 ] && [ "$1" != '--command' ]; do shift; done
shift
printf '%s' "$1" > "$HEALTH_CLI_DIRECTORY/sql-$count"
cat "$HEALTH_CLI_DIRECTORY/response-$count"
`,
      { mode: 0o755 },
    );
    writeFileSync(join(directory, "date"), '#!/bin/sh\ncat "$HEALTH_CLI_DIRECTORY/clock"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(directory, "sleep"),
      '#!/bin/sh\nnow=$(cat "$HEALTH_CLI_DIRECTORY/clock")\nprintf "%s" "$((now + $1))" > "$HEALTH_CLI_DIRECTORY/clock"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HEALTH_INCLUDE_DIAGNOSTICS: "0",
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        ...environment,
        PATH: `${directory}:${process.env.PATH}`,
        HEALTH_CLI_DIRECTORY: directory,
        PROJECTION_CONVERGENCE_STATE_FILE: join(directory, "deadline"),
      },
    });
    assert.ifError(result.error);
    const calls = Number(readFileSync(join(directory, "calls"), "utf8"));
    const sql = Array.from({ length: calls }, (_, index) =>
      readFileSync(join(directory, `sql-${index + 1}`), "utf8"),
    );
    const labels = result.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"event":"operational_health_d1_query"'))
      .map((line) => (JSON.parse(line) as { query: string }).query);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, sql, labels };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
