import { isRecord } from "../../src/types.js";
import { assessHarnessReport, requireSha, requireTimestamp } from "./report.js";
import type { HarnessCheck } from "./report.js";
import { parsePostDeployReceipt } from "./post-deploy.js";

export interface DeliverySnapshot {
  repository: string;
  collectedAt: string;
  pull: unknown;
  pullAfter: unknown;
  reviewPages: unknown[];
  ciRuns: unknown[];
  statuses: unknown[];
  deployment: null | { run: unknown; artifact: unknown; sourceSha: string };
  downstream: { run: unknown; artifact: unknown; receipt: unknown }[];
}

export function requireRepository(value: unknown): string {
  if (typeof value !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(value)) {
    throw new Error("invalid_repository");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid_github_response");
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("incomplete_github_collection");
  return value;
}

export function deliverySource(pull: unknown): string {
  const pr = record(pull);
  if (typeof pr.merged !== "boolean") throw new Error("invalid_pull_state");
  return requireSha(pr.merged ? pr.merge_commit_sha : record(pr.head).sha);
}

function statusOf(value: unknown): "pass" | "fail" | "unknown" {
  return value === "success"
    ? "pass"
    : value === "failure" || value === "error"
      ? "fail"
      : "unknown";
}

export function assessDelivery(snapshot: DeliverySnapshot) {
  const repo = requireRepository(snapshot.repository);
  const pr = record(snapshot.pull);
  const sourceSha = deliverySource(pr);
  const at = requireTimestamp(snapshot.collectedAt);
  const prUrl = `https://github.com/${repo}/pull/${pr.number}`;
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0)
    throw new Error("invalid_pr_number");
  const checks: HarnessCheck[] = [];
  const add = (
    id: string,
    status: HarnessCheck["status"],
    reason: string,
    uri = prUrl,
    scope: HarnessCheck["scope"] = "source",
    required = true,
  ) => {
    checks.push({ id, required, scope, status, reason, evidence: [{ uri, sourceSha }] });
  };
  const after = record(snapshot.pullAfter);
  const stable =
    deliverySource(after) === sourceSha &&
    record(after.head).sha === record(pr.head).sha &&
    after.merged === pr.merged;
  add(
    "snapshot-stable",
    stable ? "pass" : "unknown",
    stable ? "PR identity unchanged during collection" : "PR changed; collect again",
  );
  add(
    "main-merge",
    pr.merged === true && record(pr.base).ref === "main" ? "pass" : "unknown",
    pr.merged ? "Merged pull request; target must be main" : "PR has not been merged",
  );

  const runs = list(snapshot.ciRuns)
    .map(record)
    .filter(
      (run) =>
        run.head_sha === sourceSha &&
        run.path === ".github/workflows/ci.yml" &&
        run.event === (pr.merged ? "push" : "pull_request") &&
        (!pr.merged || run.head_branch === "main"),
    );
  runs.sort((a, b) => Number(b.id) - Number(a.id));
  const ci = runs[0];
  add(
    "ci",
    ci?.status === "completed" ? statusOf(ci.conclusion) : "unknown",
    ci ? `Latest CI: ${ci.status}/${ci.conclusion}` : "No CI for this source SHA",
    ci ? `https://github.com/${repo}/actions/runs/${ci.id}` : prUrl,
  );

  let reviewComplete = snapshot.reviewPages.length > 0;
  let unresolved = 0;
  let changesRequested = false;
  let reviewRequired = false;
  snapshot.reviewPages.forEach((page, index) => {
    const data = record(record(page).data);
    const review = record(record(data.repository).pullRequest);
    if (review.headRefOid !== record(pr.head).sha) reviewComplete = false;
    changesRequested ||= review.reviewDecision === "CHANGES_REQUESTED";
    reviewRequired ||= review.reviewDecision === "REVIEW_REQUIRED";
    const threads = record(review.reviewThreads);
    const pageInfo = record(threads.pageInfo);
    if (typeof pageInfo.hasNextPage !== "boolean") throw new Error("invalid_review_pagination");
    if (pageInfo.hasNextPage !== index < snapshot.reviewPages.length - 1) reviewComplete = false;
    for (const thread of list(threads.nodes).map(record)) {
      if (typeof thread.isResolved !== "boolean") throw new Error("invalid_review_thread");
      if (!thread.isResolved) unresolved++;
    }
  });
  add(
    "review-threads",
    changesRequested
      ? "fail"
      : !reviewComplete || unresolved || reviewRequired
        ? "unknown"
        : "pass",
    `Review coverage=${reviewComplete}; unresolved=${unresolved}; changesRequested=${changesRequested}; reviewRequired=${reviewRequired}`,
  );

  const statuses = list(snapshot.statuses)
    .map(record)
    .sort((a, b) => Number(b.id) - Number(a.id));
  const latest = (context: string) => statuses.find((status) => status.context === context);
  const deployed = latest("deployment/cloudflare");
  let deploymentSha: string | null = null;
  if (snapshot.deployment) {
    const run = record(snapshot.deployment.run);
    const artifact = record(snapshot.deployment.artifact);
    const artifactRun = record(artifact.workflow_run);
    const linkedRun = `https://github.com/${repo}/actions/runs/${run.id}`;
    if (
      deployed?.target_url === linkedRun &&
      run.path === ".github/workflows/deploy.yml" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      artifact.name === "deployment-identity" &&
      artifact.expired === false &&
      artifactRun.id === run.id
    ) {
      deploymentSha = requireSha(snapshot.deployment.sourceSha);
    }
  }
  const deferred =
    typeof deployed?.description === "string" &&
    /deferred|unchanged|already current/iu.test(deployed.description);
  add(
    "deployment",
    deployed?.state === "failure" || deployed?.state === "error"
      ? "fail"
      : deployed?.state === "success" && !deferred && deploymentSha === sourceSha
        ? "pass"
        : "unknown",
    `${deployed?.description ?? "No deployment status"}; artifact SHA=${deploymentSha ?? "unconfirmed"}`,
    typeof deployed?.target_url === "string" ? deployed.target_url : prUrl,
    "deployment",
  );
  for (const context of ["deployment/catalog-admin", "verification/e2e"]) {
    const status = latest(context);
    let verified = false;
    for (const item of snapshot.downstream) {
      const run = record(item.run);
      const artifact = record(item.artifact);
      const receipt = parsePostDeployReceipt(item.receipt);
      const expectedPath =
        context === "verification/e2e"
          ? ".github/workflows/e2e.yml"
          : ".github/workflows/deploy-catalog-admin.yml";
      if (
        status?.target_url === `https://github.com/${repo}/actions/runs/${run.id}` &&
        run.path === expectedPath &&
        run.event === "workflow_run" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        artifact.name === "post-deploy-receipt" &&
        artifact.expired === false &&
        record(artifact.workflow_run).id === run.id &&
        receipt.context === context &&
        receipt.sourceSha === sourceSha &&
        receipt.runId === run.id &&
        receipt.runAttempt === run.run_attempt &&
        snapshot.deployment &&
        receipt.deploymentRunId === record(snapshot.deployment.run).id
      )
        verified = true;
    }
    add(
      context,
      statusOf(status?.state) === "fail"
        ? "fail"
        : status?.state === "success" && verified
          ? "pass"
          : "unknown",
      status
        ? `${status.description}; automatic deployment receipt=${verified}`
        : "No result for this SHA",
      typeof status?.target_url === "string" ? status.target_url : prUrl,
      "deployment",
    );
  }
  add(
    "production-effectiveness",
    "unknown",
    "Requires a separate fixed-deployment observation report with coverage and cost/correctness evidence",
    prUrl,
    "observation",
    false,
  );
  add(
    "paused-operational-health",
    "skipped",
    "Operational data-platform/catalog audits remain intentionally paused",
    prUrl,
    "observation",
    false,
  );
  return assessHarnessReport({
    schemaVersion: 1,
    runId: `delivery-pr-${pr.number}`,
    sourceSha,
    baselineSha: requireSha(record(pr.base).sha),
    deploymentSha,
    startedAt: at,
    finishedAt: at,
    checks,
  });
}
