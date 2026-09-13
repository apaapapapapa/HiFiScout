import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/types.js";
import { assessDelivery, deliverySource, requireRepository } from "./delivery.js";
import type { DeliverySnapshot, DeliveryTarget } from "./delivery.js";
import { requireSha } from "./report.js";

const exec = promisify(execFile);
// gh owns authentication and artifact transport, as in the existing Actions workflows. No
// shell interpolation, mutations, repair commands or production Cloudflare requests occur here.
export async function gh(args: string[], timeoutMs = 60_000): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("invalid_github_timeout");
  const { stdout } = await exec("gh", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function api(path: string, invoke: typeof gh): Promise<unknown> {
  return JSON.parse(await invoke(["api", "--hostname", "github.com", "--method", "GET", path]));
}

async function pages(path: string, invoke: typeof gh, property?: string): Promise<unknown[]> {
  const values: unknown = JSON.parse(
    await invoke([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      path,
    ]),
  );
  if (!Array.isArray(values)) throw new Error("invalid_github_pages");
  return values.flatMap((page: unknown) => {
    const rows = property && isRecord(page) ? page[property] : page;
    if (!Array.isArray(rows)) throw new Error("invalid_github_collection");
    return rows as unknown[];
  });
}

export async function collectDelivery(
  repository: string,
  number: number,
  outputDir: string,
  invoke: typeof gh = gh,
  target: DeliveryTarget = "deployment",
) {
  const repo = requireRepository(repository);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid_pr_number");
  const endpoint = `repos/${repo}`;
  const pull = await api(`${endpoint}/pulls/${number}`, invoke);
  const sha = deliverySource(pull);
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String) {
    repository(owner:$owner,name:$name) { pullRequest(number:$number) {
      headRefOid reviewDecision reviewThreads(first:100,after:$endCursor) {
        nodes { id isResolved isOutdated } pageInfo { hasNextPage endCursor }
      }
    } }
  }`;
  const [reviewText, ciRuns, statuses] = await Promise.all([
    invoke([
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]),
    pages(
      `${endpoint}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
      invoke,
      "workflow_runs",
    ),
    pages(`${endpoint}/commits/${sha}/statuses?per_page=100`, invoke),
  ]);
  const reviewPages: unknown = JSON.parse(reviewText);
  if (!Array.isArray(reviewPages)) throw new Error("invalid_review_pages");
  const deployStatus = statuses
    .filter(isRecord)
    .filter((s) => s.context === "deployment/cloudflare")
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  let deployment: DeliverySnapshot["deployment"] = null;
  const runPrefix = `https://github.com/${repo}/actions/runs/`;
  if (
    target === "deployment" &&
    typeof deployStatus?.target_url === "string" &&
    deployStatus.target_url.startsWith(runPrefix)
  ) {
    const runId = deployStatus.target_url.slice(runPrefix.length);
    if (!/^\d+$/u.test(runId)) throw new Error("invalid_deployment_run_url");
    const run = await api(`${endpoint}/actions/runs/${runId}`, invoke);
    const artifacts = await pages(
      `${endpoint}/actions/runs/${runId}/artifacts?per_page=100`,
      invoke,
      "artifacts",
    );
    const matches = artifacts
      .filter(isRecord)
      .filter((a) => a.name === "deployment-identity" && a.expired === false);
    if (matches.length === 1) {
      const dir = await mkdtemp(join(tmpdir(), "hifiscout-deployment-"));
      try {
        await invoke([
          "run",
          "download",
          runId,
          "--repo",
          repo,
          "--name",
          "deployment-identity",
          "--dir",
          dir,
        ]);
        deployment = {
          run,
          artifact: matches[0],
          sourceSha: requireSha((await readFile(join(dir, "deployment-sha.txt"), "utf8")).trim()),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  const snapshot: DeliverySnapshot = {
    repository: repo,
    collectedAt: new Date().toISOString(),
    pull,
    pullAfter: pull,
    reviewPages,
    ciRuns,
    statuses,
    deployment,
    downstream: [],
  };
  for (const context of target === "deployment"
    ? ["deployment/catalog-admin", "verification/e2e"]
    : []) {
    const status = statuses
      .filter(isRecord)
      .filter((s) => s.context === context)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (typeof status?.target_url !== "string" || !status.target_url.startsWith(runPrefix))
      continue;
    const id = status.target_url.slice(runPrefix.length);
    if (!/^\d+$/u.test(id)) throw new Error("invalid_downstream_run_url");
    const run = await api(`${endpoint}/actions/runs/${id}`, invoke);
    const artifacts = await pages(
      `${endpoint}/actions/runs/${id}/artifacts?per_page=100`,
      invoke,
      "artifacts",
    );
    const matches = artifacts
      .filter(isRecord)
      .filter((a) => a.name === "post-deploy-receipt" && a.expired === false);
    if (matches.length !== 1) continue;
    const dir = await mkdtemp(join(tmpdir(), "hifiscout-verification-"));
    try {
      await invoke([
        "run",
        "download",
        id,
        "--repo",
        repo,
        "--name",
        "post-deploy-receipt",
        "--dir",
        dir,
      ]);
      snapshot.downstream.push({
        run,
        artifact: matches[0],
        receipt: JSON.parse(await readFile(join(dir, "post-deploy-receipt.json"), "utf8")),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  snapshot.pullAfter = await api(`${endpoint}/pulls/${number}`, invoke);
  const report = assessDelivery(snapshot, target);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "github-snapshot.json"),
    JSON.stringify(snapshot, null, 2) + "\n",
  );
  await writeFile(join(outputDir, "delivery-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
