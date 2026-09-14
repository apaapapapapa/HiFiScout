import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../../src/types.js";
import { assessDelivery } from "../delivery.js";
import { deliverySource } from "../delivery.js";
import type { DeliverySnapshot } from "../delivery.js";
import { requireSha, requireTimestamp } from "../report.js";
import { integer } from "./contract.js";
import { recordLoopEvent } from "./controller.js";
import { sourceIsCurrent } from "./publication.js";
import { assessLoopDelivery, parseLoopReview } from "./review.js";
import { withLoopWorkspace } from "./workspace.js";

export type LoopHandoff = "publish" | "review" | "merge-ready" | "observe";

function arrayCollection(value: unknown, url: string, label: "review" | "status"): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new Error(`handoff_${label}_collection_missing`);
  const items: unknown[] = [],
    ids = new Set<number>();
  value.forEach((page, index) => {
    if (
      !isRecord(page) ||
      page.url !== `${url}?per_page=100&page=${index + 1}` ||
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      (index < value.length - 1 ? page.items.length !== 100 : page.items.length === 100)
    )
      throw new Error(`handoff_${label}_pagination_incomplete`);
    for (const item of page.items) {
      if (!isRecord(item)) throw new Error(`invalid_handoff_${label}_submission`);
      const id = integer(item.id, `${label}_id`, 1);
      if (ids.has(id)) throw new Error(`handoff_${label}_pagination_changed`);
      ids.add(id);
      items.push(item);
    }
  });
  return items;
}

function workflowCollection(value: unknown, url: string): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 10)
    throw new Error("handoff_workflow_collection_missing");
  const runs: unknown[] = [],
    ids = new Set<number>();
  let total: number | undefined;
  value.forEach((page, index) => {
    if (
      !isRecord(page) ||
      page.url !== `${url}&per_page=100&page=${index + 1}` ||
      !isRecord(page.response) ||
      !Array.isArray(page.response.workflow_runs)
    )
      throw new Error("handoff_workflow_pagination_incomplete");
    // GitHub caps filtered workflow searches at 1,000 results. Larger collections
    // cannot establish completeness and must not authorize delivery.
    const count = integer(page.response.total_count, "workflow_total_count", 0, 1000);
    total ??= count;
    if (
      count !== total ||
      value.length !== Math.max(1, Math.ceil(total / 100)) ||
      page.response.workflow_runs.length !== Math.min(100, total - index * 100)
    )
      throw new Error("handoff_workflow_pagination_incomplete");
    for (const run of page.response.workflow_runs) {
      if (!isRecord(run)) throw new Error("invalid_handoff_workflow_run");
      const id = integer(run.id, "run_id", 1);
      if (ids.has(id)) throw new Error("handoff_workflow_pagination_changed");
      ids.add(id);
      runs.push(run);
    }
  });
  return runs;
}

function validateThreadPages(value: unknown, repository: string, number: number) {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new Error("handoff_thread_pages_missing");
  let cursor: string | null = null;
  const ids = new Set<string>();
  value.forEach((page, index) => {
    if (
      !isRecord(page) ||
      page.after !== cursor ||
      !isRecord(page.data) ||
      !isRecord(page.data.repository) ||
      page.data.repository.nameWithOwner !== repository ||
      !isRecord(page.data.repository.pullRequest) ||
      page.data.repository.pullRequest.number !== number ||
      page.data.repository.pullRequest.url !== `https://github.com/${repository}/pull/${number}`
    )
      throw new Error("handoff_thread_page_identity_mismatch");
    const threads = page.data.repository.pullRequest.reviewThreads;
    if (
      !isRecord(threads) ||
      !Array.isArray(threads.nodes) ||
      !isRecord(threads.pageInfo) ||
      threads.pageInfo.hasNextPage !== index < value.length - 1
    )
      throw new Error("handoff_thread_pagination_incomplete");
    if (threads.pageInfo.hasNextPage) {
      if (
        typeof threads.pageInfo.endCursor !== "string" ||
        !threads.pageInfo.endCursor ||
        !threads.nodes.length
      )
        throw new Error("handoff_thread_cursor_missing");
      cursor = threads.pageInfo.endCursor;
    }
    for (const thread of threads.nodes) {
      if (!isRecord(thread) || typeof thread.id !== "string" || !thread.id || ids.has(thread.id))
        throw new Error("handoff_thread_pagination_changed");
      ids.add(thread.id);
    }
  });
}

function validateRunOwnership(value: unknown, repository: string) {
  if (
    !isRecord(value) ||
    !isRecord(value.repository) ||
    value.repository.full_name !== repository ||
    value.url !==
      `https://api.github.com/repos/${repository}/actions/runs/${integer(value.id, "run_id", 1)}`
  )
    throw new Error("handoff_run_repository_mismatch");
  return value;
}

function validateRunEvidence(
  snapshot: Record<string, unknown>,
  input: Record<string, unknown>,
  repository: string,
  number: number,
  branch: string,
) {
  const source = deliverySource(snapshot.pull),
    repoUrl = `https://api.github.com/repos/${repository}`;
  if (
    !isRecord(snapshot.pull) ||
    !Array.isArray(snapshot.ciRuns) ||
    !Array.isArray(snapshot.statuses) ||
    !Array.isArray(snapshot.downstream)
  )
    throw new Error("invalid_loop_handoff");
  const merged = snapshot.pull.merged,
    event = merged ? "push" : "pull_request",
    runs = workflowCollection(
      input.workflowRunPages,
      `${repoUrl}/actions/runs?head_sha=${source}&event=${event}`,
    ),
    statuses = arrayCollection(
      input.statusPages,
      `${repoUrl}/commits/${source}/statuses`,
      "status",
    ),
    ids = new Set<number>();
  for (const value of runs) {
    const run = validateRunOwnership(value, repository);
    if (run.head_sha !== source || run.event !== event)
      throw new Error("handoff_workflow_source_mismatch");
  }
  if (
    !isDeepStrictEqual(
      snapshot.ciRuns,
      runs.filter((run) => isRecord(run) && run.path === ".github/workflows/ci.yml"),
    ) ||
    !isDeepStrictEqual(snapshot.statuses, statuses)
  )
    throw new Error("handoff_collection_snapshot_mismatch");
  for (const value of snapshot.ciRuns) {
    const run = validateRunOwnership(value, repository),
      id = integer(run.id, "run_id", 1);
    if (ids.has(id)) throw new Error("handoff_duplicate_ci_run");
    ids.add(id);
    if (
      run.head_sha !== source ||
      run.path !== ".github/workflows/ci.yml" ||
      run.event !== (merged ? "push" : "pull_request") ||
      run.head_branch !== (merged ? "main" : branch) ||
      !isRecord(run.head_repository) ||
      run.head_repository.full_name !== repository
    )
      throw new Error("handoff_ci_source_mismatch");
    if (
      !merged &&
      (!Array.isArray(run.pull_requests) ||
        !run.pull_requests.some(
          (pull) =>
            isRecord(pull) &&
            pull.number === number &&
            pull.url === `${repoUrl}/pulls/${number}` &&
            isRecord(pull.head) &&
            pull.head.sha === source &&
            pull.head.ref === branch &&
            isRecord(pull.head.repo) &&
            pull.head.repo.url === repoUrl &&
            isRecord(pull.base) &&
            pull.base.ref === "main" &&
            isRecord(pull.base.repo) &&
            pull.base.repo.url === repoUrl,
        ))
    )
      throw new Error("handoff_ci_pull_mismatch");
  }
  for (const status of snapshot.statuses)
    if (!isRecord(status) || status.url !== `${repoUrl}/statuses/${source}`)
      throw new Error("handoff_status_source_mismatch");
  for (const [item, filename] of [
    ...(snapshot.deployment === null ? [] : [[snapshot.deployment, "deployment-sha.txt"] as const]),
    ...snapshot.downstream.map((item) => [item, "post-deploy-receipt.json"] as const),
  ]) {
    if (!isRecord(item)) throw new Error("invalid_handoff_deployment");
    validateRunOwnership(item.run, repository);
    if (
      !isRecord(item.artifact) ||
      item.artifact.url !==
        `${repoUrl}/actions/artifacts/${integer(item.artifact.id, "artifact_id", 1)}`
    )
      throw new Error("handoff_artifact_repository_mismatch");
    const file = item.artifactFile;
    if (
      !isRecord(file) ||
      file.artifactUrl !== item.artifact.url ||
      file.filename !== filename ||
      typeof file.content !== "string" ||
      file.content.length > 65_536
    )
      throw new Error("handoff_artifact_contents_missing");
    if (
      filename === "deployment-sha.txt"
        ? requireSha(file.content.trim()) !== item.sourceSha
        : !isDeepStrictEqual(JSON.parse(file.content), item.receipt)
    )
      throw new Error("handoff_artifact_contents_mismatch");
  }
}

// The host supplies retained, actual connector responses. This imports evidence; it does not
// authenticate to GitHub or perform a remote mutation. Fresh collection is required on every call.
export async function importLoopHandoff(
  statePath: string,
  root: string,
  action: LoopHandoff,
  input: unknown,
) {
  if (!isRecord(input) || !isRecord(input.snapshot)) throw new Error("invalid_loop_handoff");
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = await sourceIsCurrent(run, workspace, manifest);
    const snapshot = input.snapshot;
    if (!isRecord(snapshot) || !isRecord(snapshot.pull)) throw new Error("invalid_loop_handoff");
    const number = integer(snapshot.pull.number, "handoff_pr", 1);
    const collectedAt = requireTimestamp(snapshot.collectedAt);
    const age = Date.now() - Date.parse(collectedAt);
    if (age < 0 || age > 300_000) throw new Error("handoff_snapshot_not_fresh");
    if (view.review && view.review.prNumber !== number) throw new Error("handoff_pr_changed");
    const pullUrl = `https://api.github.com/repos/${run.spec.repository}/pulls/${number}`;
    for (const pull of [snapshot.pull, snapshot.pullAfter]) {
      if (
        !isRecord(pull) ||
        pull.url !== pullUrl ||
        pull.number !== number ||
        pull.state !== snapshot.pull.state ||
        !isRecord(pull.head) ||
        pull.head.sha !== view.lastVerifiedSha ||
        pull.head.ref !== `automation/loop/${run.spec.task.id}` ||
        !isRecord(pull.head.repo) ||
        pull.head.repo.full_name !== run.spec.repository ||
        !isRecord(pull.base) ||
        pull.base.ref !== "main" ||
        !isRecord(pull.base.repo) ||
        pull.base.repo.full_name !== run.spec.repository ||
        !isRecord(snapshot.pull.base) ||
        pull.base.sha !== snapshot.pull.base.sha
      )
        throw new Error("handoff_pull_identity_mismatch");
    }
    validateThreadPages(snapshot.reviewPages, run.spec.repository, number);
    validateRunEvidence(
      snapshot,
      input,
      run.spec.repository,
      number,
      `automation/loop/${run.spec.task.id}`,
    );
    assessLoopDelivery(run.spec, view.lastVerifiedSha!, number, snapshot);
    const report = assessDelivery(snapshot as unknown as DeliverySnapshot, "pr");
    const gates = (ids: string[]) => {
      if (ids.some((id) => !report.checks.some((c) => c.id === id && c.status === "pass")))
        throw new Error("handoff_gates_incomplete");
    };
    gates(["snapshot-stable"]);
    const artifactUri = `.generated/loop/handoff-${randomUUID()}.json`;
    const save = async () => {
      await mkdir(resolve(workspace, ".generated/loop"), { recursive: true });
      await writeFile(resolve(workspace, artifactUri), JSON.stringify(input, null, 2), {
        flag: "wx",
      });
    };
    if (action === "publish") {
      if (
        view.phase !== "review" ||
        snapshot.pull.state !== "open" ||
        snapshot.pull.merged !== false ||
        !isRecord(snapshot.pull.head) ||
        snapshot.pull.head.ref !== `automation/loop/${run.spec.task.id}` ||
        !isRecord(snapshot.pull.head.repo) ||
        snapshot.pull.head.repo.full_name !== run.spec.repository ||
        view.lastVerifiedSha === run.spec.baselineSha
      )
        throw new Error("handoff_publication_mismatch");
      if (view.review) return view;
      await save();
      return recordLoopEvent(statePath, run, "review-requested", {
        sourceSha: view.lastVerifiedSha,
        prNumber: number,
        artifactUri,
      });
    }
    if (!view.review) throw new Error("loop_pull_not_recorded");
    if (
      (action === "review" || action === "merge-ready") &&
      (snapshot.pull.state !== "open" || snapshot.pull.merged !== false)
    )
      throw new Error("handoff_requires_open_unmerged_pull");
    // A connector may omit GitHub's aggregate reviewDecision. Retain all REST submissions
    // as well so a top-level changes-requested review cannot disappear with a null decision.
    const reviews = arrayCollection(input.reviewSubmissionPages, `${pullUrl}/reviews`, "review");
    const decisions = new Map<string, { id: number; state: string }>();
    for (const review of reviews) {
      if (
        !isRecord(review) ||
        review.pull_request_url !== pullUrl ||
        !isRecord(review.user) ||
        typeof review.user.login !== "string" ||
        !["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"].includes(
          String(review.state),
        )
      )
        throw new Error("invalid_handoff_review_submission");
      const id = integer(review.id, "review_id", 1),
        state = String(review.state);
      if (["COMMENTED", "PENDING"].includes(state)) continue;
      const previous = decisions.get(review.user.login);
      if (!previous || id > previous.id) decisions.set(review.user.login, { id, state });
    }
    if ([...decisions.values()].some((review) => review.state === "CHANGES_REQUESTED"))
      throw new Error("handoff_changes_requested");
    if (action === "review") {
      if (view.phase !== "review") throw new Error("loop_review_not_requested");
      gates(["review-threads"]);
      const receipt = parseLoopReview(input.receipt);
      if (receipt.method === "codex") {
        // Only full-SHA structured reviews are accepted here. A reaction/short-SHA comment
        // is not a completion receipt; the host must resolve it through the gh path instead.
        const review = input.codexReview;
        const user = isRecord(review) && isRecord(review.user) ? review.user : null;
        if (
          !isRecord(review) ||
          review.pull_request_url !== pullUrl ||
          !user ||
          !["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"].includes(
            String(user.login),
          ) ||
          review.commit_id !== view.lastVerifiedSha ||
          !["COMMENTED", "APPROVED"].includes(String(review.state)) ||
          requireTimestamp(review.submitted_at) !== receipt.completedAt ||
          !reviews.some(
            (item) =>
              isRecord(item) &&
              item.id === review.id &&
              item.commit_id === review.commit_id &&
              requireTimestamp(item.submitted_at) === requireTimestamp(review.submitted_at) &&
              item.state === review.state &&
              isRecord(item.user) &&
              item.user.login === user.login,
          )
        )
          throw new Error("handoff_codex_review_missing");
      }
      if (collectedAt < receipt.completedAt) throw new Error("handoff_precedes_review");
      await save();
      return recordLoopEvent(statePath, run, "reviewed", {
        receipt: { ...receipt, artifactUri },
      });
    }
    if (view.phase !== "delivery" || !view.reviewReceipt)
      throw new Error("loop_delivery_before_review");
    if (collectedAt < view.reviewReceipt.completedAt) throw new Error("handoff_precedes_review");
    if (action === "merge-ready") {
      if (run.spec.delivery.target === "pr") throw new Error("loop_merge_not_authorized");
      gates([
        "ci",
        "review-threads",
        ...(run.spec.task.requirements.some((r) => r.id === "review-approval")
          ? ["review-approval"]
          : []),
      ]);
      await save();
      return {
        phase: view.phase,
        repository: run.spec.repository,
        prNumber: number,
        expectedHeadSha: view.lastVerifiedSha,
        artifactUri,
        nextAction:
          "Use the authorized GitHub merge tool with expectedHeadSha, then collect and import a fresh observe snapshot",
      };
    }
    if (action !== "observe") throw new Error("invalid_loop_handoff_action");
    await save();
    return recordLoopEvent(statePath, run, "delivery-observed", { snapshot, artifactUri });
  });
}
