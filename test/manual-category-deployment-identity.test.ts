import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";

const workflow = readFileSync(".github/workflows/apply-manual-category-authority.yml", "utf8");
const script = workflow
  .split("      - name: Resolve confirmed production deployment\n")[1]!
  .split("\n      - uses:")[0]!
  .split("        run: |\n")[1]!
  .replace(/^ {10}/gmu, "");
const REQUESTED = "a".repeat(40);
const DEPLOYED = "b".repeat(40);

const cases = [
  { name: "matching push", event: "push", sha: REQUESTED, available: true },
  { name: "quota-deferred push", event: "push", missing: true, available: false },
  { name: "expired identity", event: "push", expired: true, available: false },
  { name: "mismatched push identity", event: "push", sha: DEPLOYED, failure: true },
  { name: "invalid identity", event: "push", sha: "not-a-sha", failure: true },
  {
    name: "manual dispatch uses production",
    event: "workflow_dispatch",
    sha: DEPLOYED,
    available: true,
  },
  {
    name: "manual dispatch needs an identity",
    event: "workflow_dispatch",
    missing: true,
    failure: true,
  },
  { name: "API errors fail closed", event: "push", apiFailure: true, failure: true },
  {
    name: "manual dispatch rejects an untrusted producer",
    event: "workflow_dispatch",
    untrusted: true,
    failure: true,
  },
] as const;

for (const scenario of cases) {
  test(`category maintenance identity: ${scenario.name}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "category-deployment-"));
    const output = join(directory, "output");
    writeFileSync(output, "");
    writeFileSync(
      join(directory, "gh"),
      `#!/usr/bin/env bash
set -eu
case "$*" in
  *workflows/deploy.yml/runs*) printf '%s\\n' "$RUNS_JSON" ;;
  */actions/runs/123) printf '%s\\n' "$PRODUCER_JSON" ;;
  *artifacts/*/zip*) printf 'archive' ;;
  *artifacts*)
    if [[ "$API_FAILURE" == "true" ]]; then exit 1; fi
    printf '%s\\n' "$ARTIFACTS_JSON" ;;
  *) echo "Unexpected API call" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(directory, "unzip"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$ARTIFACT_SHA\"\n",
      { mode: 0o755 },
    );
    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_EVENT_NAME: scenario.event,
          GITHUB_REPOSITORY: "test/repository",
          GITHUB_SHA: REQUESTED,
          GITHUB_OUTPUT: output,
          RUNS_JSON: JSON.stringify({
            workflow_runs: [
              {
                id: 123,
                head_sha: REQUESTED,
                status: "completed",
                conclusion: "success",
                created_at: "2026-09-05",
              },
            ],
          }),
          PRODUCER_JSON: JSON.stringify({
            path:
              "untrusted" in scenario ? ".github/workflows/ci.yml" : ".github/workflows/deploy.yml",
            head_branch: "main",
            status: "completed",
            conclusion: "success",
          }),
          ARTIFACTS_JSON: JSON.stringify({
            artifacts:
              "missing" in scenario
                ? []
                : [
                    {
                      id: 456,
                      workflow_run: { id: 123 },
                      name: "deployment-identity",
                      expired: "expired" in scenario,
                      created_at: "2026-09-05",
                    },
                  ],
          }),
          ARTIFACT_SHA: "sha" in scenario ? scenario.sha : REQUESTED,
          API_FAILURE: String("apiFailure" in scenario),
        },
        timeout: 5000,
      });
      const outputs = readFileSync(output, "utf8");
      if ("failure" in scenario) {
        assert.notEqual(result.status, 0, result.stdout);
        assert.doesNotMatch(outputs, /available=true/u);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(outputs, new RegExp(`available=${scenario.available}`, "u"));
        if (scenario.available && "sha" in scenario) {
          assert.match(outputs, new RegExp(`sha=${scenario.sha}`, "u"));
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("every category-maintenance D1 step requires confirmed deployment identity", () => {
  for (const name of [
    "Resolve production D1 binding",
    "Reclassify resolved Knowledge Catalog products",
    "Apply manual category authority and refresh projections",
  ]) {
    const section = workflow.split(`      - name: ${name}\n`)[1]!.split("\n      - ")[0]!;
    assert.match(section, /if: steps\.deployment\.outputs\.available == 'true'/u);
  }
  assert.match(workflow, /ref: \$\{\{ steps\.deployment\.outputs\.sha \}\}/u);
  assert.doesNotMatch(
    workflow,
    /workflow_run:/u,
    "maintenance must not become an autonomous repair fan-out",
  );
});
