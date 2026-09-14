import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isRecord } from "../../../src/types.js";
import { collectDelivery, gh } from "../github.js";
import { assessHarnessReport } from "../report.js";
import { assessLoopRun, recordLoopEvent } from "./controller.js";
import { assessLoopDelivery, parseLoopReview } from "./review.js";
import { inspectLoopWorkspace, loopGit, withLoopWorkspace } from "./workspace.js";
import type { LoopRun } from "./state.js";
import { readLoopRun } from "./state.js";
import { integer } from "./contract.js";
import { updateJsonRevision } from "../store.js";

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const bot = (user: unknown) =>
  isRecord(user) &&
  ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"].includes(String(user.login));
const api = async (invoke: typeof gh, path: string) =>
  JSON.parse(await invoke(["api", "--hostname", "github.com", "--method", "GET", path])) as unknown;

function bounded(run: LoopRun, invoke: typeof gh): typeof gh {
  const deadline = Date.parse(assessLoopRun(run).deadline);
  return async (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("loop_time_budget_exhausted");
    return invoke(args, Math.min(60_000, remaining));
  };
}

export async function sourceIsCurrent(run: LoopRun, workspace: string, manifest: string) {
  const view = assessLoopRun(run),
    { owner, checkout } = await inspectLoopWorkspace(run, workspace, manifest);
  if (!view.lastVerifiedSha || checkout.sourceSha !== view.lastVerifiedSha || owner.pending)
    throw new Error("publication_requires_current_verified_source");
  return view;
}

interface PendingReview {
  revision: number;
  specDigest: string;
  sourceSha: string;
  prNumber: number;
  commentId: number | null;
}
function parsePendingReview(value: unknown): PendingReview {
  if (
    !isRecord(value) ||
    typeof value.specDigest !== "string" ||
    typeof value.sourceSha !== "string"
  )
    throw new Error("invalid_pending_review");
  return {
    revision: integer(value.revision, "request_revision", 1),
    specDigest: value.specDigest,
    sourceSha: value.sourceSha,
    prNumber: integer(value.prNumber, "request_pr", 1),
    commentId: value.commentId === null ? null : integer(value.commentId, "request_comment", 1),
  };
}
const requestPath = (workspace: string, sha: string, number: number) =>
  resolve(workspace, `.generated/loop/review-request-${sha}-${number}.json`);
async function pendingReview(path: string, run: LoopRun, sha: string, number: number) {
  let pending: PendingReview;
  try {
    pending = parsePendingReview(await json(path));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (
    pending.specDigest !== run.specDigest ||
    pending.sourceSha !== sha ||
    pending.prNumber !== number
  )
    throw new Error("pending_review_identity_mismatch");
  return pending;
}

async function reconcileReviewRequest(run: LoopRun, workspace: string, call: typeof gh) {
  const view = assessLoopRun(run),
    review = view.review;
  if (!review) return;
  const path = requestPath(workspace, review.sourceSha, review.prNumber);
  const pending = await pendingReview(path, run, review.sourceSha, review.prNumber);
  if (
    !pending ||
    pending.commentId ||
    (run.spec.delivery.review === "optional" && Date.now() >= Date.parse(review.deadline))
  )
    return;
  const repo = run.spec.repository,
    pull = await api(call, `repos/${repo}/pulls/${review.prNumber}`);
  if (!isRecord(pull) || !isRecord(pull.head) || pull.head.sha !== review.sourceSha)
    throw new Error("pending_review_head_changed");
  const body = `@codex review <!-- hifiscout-loop:${run.specDigest}:${review.sourceSha}:${review.prNumber} -->`;
  const pages: unknown = JSON.parse(
    await call([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${review.prNumber}/comments?per_page=100`,
    ]),
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error("incomplete_review_request_history");
  let comment: unknown = pages.flat().find((item) => isRecord(item) && item.body === body);
  if (!comment)
    comment = JSON.parse(
      await call([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        `repos/${repo}/issues/${review.prNumber}/comments`,
        "-f",
        `body=${body}`,
      ]),
    );
  if (!isRecord(comment)) throw new Error("invalid_review_request_response");
  const commentId = integer(comment.id, "request_comment", 1);
  await updateJsonRevision(path, pending.revision, parsePendingReview, (previous) => ({
    ...pending,
    revision: previous!.revision + 1,
    commentId,
  }));
}

export async function publishLoopPull(
  statePath: string,
  root: string,
  invoke: typeof gh = gh,
  push = (workspace: string, branch: string, sha: string, repository: string) => {
    const destination = loopGit(workspace, ["remote", "get-url", "--push", "origin"]);
    if (
      ![
        `https://github.com/${repository}`,
        `https://github.com/${repository}.git`,
        `git@github.com:${repository}`,
        `git@github.com:${repository}.git`,
      ].includes(destination)
    )
      throw new Error("loop_push_destination_changed");
    loopGit(workspace, ["push", "origin", `${sha}:refs/heads/${branch}`]);
  },
) {
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = await sourceIsCurrent(run, workspace, manifest);
    if (view.phase !== "review") throw new Error("publication_requires_review_stage");
    if (view.review) {
      await reconcileReviewRequest(run, workspace, bounded(run, invoke));
      return view;
    }
    if (view.lastVerifiedSha === run.spec.baselineSha) throw new Error("repair_has_no_commit");
    const call = bounded(run, invoke),
      repo = run.spec.repository,
      branch = `automation/loop/${run.spec.task.id}`;
    const pulls = await api(
      call,
      `repos/${repo}/pulls?state=all&base=main&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&per_page=100`,
    );
    if (
      !Array.isArray(pulls) ||
      pulls.length > 1 ||
      (pulls.length === 1 && (!isRecord(pulls[0]) || pulls[0].state !== "open"))
    )
      throw new Error("ambiguous_or_closed_loop_pull");
    if (assessLoopRun(await readLoopRun(statePath)).phase !== "review")
      throw new Error("publication_no_longer_active");
    push(workspace, branch, view.lastVerifiedSha!, repo);
    let number: number;
    if (pulls.length) number = Number(pulls[0].number);
    else {
      const bodyPath = resolve(workspace, `.generated/loop/pull-${randomUUID()}.md`);
      await mkdir(resolve(workspace, ".generated/loop"), { recursive: true });
      await writeFile(
        bodyPath,
        [
          run.spec.task.goal,
          "",
          `Loop: ${run.spec.task.id}`,
          `Frozen baseline: ${run.spec.baselineSha}`,
          `Verified candidate: ${view.lastVerifiedSha}`,
          "",
          ...view.lastReport!.checks.filter((c) => c.required).map((c) => `- ${c.id}: ${c.status}`),
          "",
          "Local source evidence is retained with the loop journal. GitHub CI and delivery evidence are checked separately.",
        ].join("\n"),
        { flag: "wx" },
      );
      const url = (
        await call([
          "pr",
          "create",
          "--repo",
          repo,
          "--base",
          "main",
          "--head",
          branch,
          "--title",
          `fix(loop): ${run.spec.task.id}`,
          "--body-file",
          bodyPath,
        ])
      ).trim();
      const prefix = `https://github.com/${repo}/pull/`;
      if (!url.startsWith(prefix) || !/^\d+$/u.test(url.slice(prefix.length)))
        throw new Error("invalid_created_pull_url");
      number = Number(url.slice(prefix.length));
    }
    const pull = await api(call, `repos/${repo}/pulls/${number}`);
    if (
      !isRecord(pull) ||
      !isRecord(pull.head) ||
      pull.head.sha !== view.lastVerifiedSha ||
      pull.state !== "open"
    )
      throw new Error("published_pull_head_mismatch");
    await sourceIsCurrent(await readLoopRun(statePath), workspace, manifest);
    if (pulls.length && run.spec.delivery.review !== "self") {
      const path = requestPath(workspace, view.lastVerifiedSha!, number);
      if (
        !(await pendingReview(path, run, view.lastVerifiedSha!, number)) &&
        !run.events.some(
          (event) =>
            event.type === "review-requested" &&
            event.data.prNumber === number &&
            event.data.sourceSha === view.lastVerifiedSha,
        )
      )
        await updateJsonRevision(path, 0, parsePendingReview, () => ({
          revision: 1,
          specDigest: run.specDigest,
          sourceSha: view.lastVerifiedSha!,
          prNumber: number,
          commentId: null,
        }));
    }
    const result = await recordLoopEvent(statePath, run, "review-requested", {
      prNumber: number,
      sourceSha: view.lastVerifiedSha,
    });
    // Persist intent before transport, then reconcile a stable marker after a lost acknowledgement.
    await reconcileReviewRequest(await readLoopRun(statePath), workspace, call);
    return result;
  });
}

async function collect(
  run: LoopRun,
  workspace: string,
  call: typeof gh,
  target = run.spec.delivery.target,
) {
  const view = assessLoopRun(run);
  if (!view.review) throw new Error("loop_pull_not_recorded");
  const artifactUri = `.generated/loop/github-${randomUUID()}`;
  const directory = resolve(workspace, artifactUri);
  const report = await collectDelivery(
    run.spec.repository,
    view.review.prNumber,
    directory,
    call,
    target,
  );
  const snapshot = await json(join(directory, "github-snapshot.json"));
  // Validate identity using the actual frozen target even when collecting pre-merge evidence.
  assessLoopDelivery(run.spec, view.lastVerifiedSha!, view.review.prNumber, snapshot);
  return { directory, artifactUri, report, snapshot };
}

async function codexCompletion(run: LoopRun, call: typeof gh) {
  const view = assessLoopRun(run),
    repo = run.spec.repository,
    number = view.review!.prNumber;
  const pages = async (path: string) => {
    const data: unknown = JSON.parse(
      await call([
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
    if (!Array.isArray(data) || data.some((page) => !Array.isArray(page)))
      throw new Error("incomplete_review_history");
    return data.flat().filter(isRecord);
  };
  const reviews = await pages(`repos/${repo}/pulls/${number}/reviews?per_page=100`);
  const matching = reviews
    .filter(
      (r) =>
        bot(r.user) &&
        r.commit_id === view.lastVerifiedSha &&
        ["COMMENTED", "APPROVED"].includes(String(r.state)) &&
        typeof r.submitted_at === "string" &&
        r.submitted_at >= view.review!.requestedAt,
    )
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  if (matching.length) return { completedAt: matching[0].submitted_at, evidence: { reviews } };
  // Codex posts a summary (without a review object) when it has no findings. Resolve the abbreviated
  // commit through GitHub before trusting it, and reject ambiguous or stale abbreviations.
  const comments = await pages(`repos/${repo}/issues/${number}/comments?per_page=100`);
  for (const comment of comments.reverse()) {
    if (
      !bot(comment.user) ||
      typeof comment.body !== "string" ||
      !comment.body.includes("<!-- codex-pull-request-review-summary -->") ||
      typeof comment.updated_at !== "string" ||
      comment.updated_at < view.review!.requestedAt
    )
      continue;
    const match = /\|\s*✅ \*\*Completed\*\*[^|\n]*\|\s*`([a-f0-9]{7,40})`/u.exec(comment.body);
    if (!match) continue;
    const commit = await api(call, `repos/${repo}/commits/${match[1]}`);
    if (isRecord(commit) && commit.sha === view.lastVerifiedSha)
      return {
        completedAt: comment.updated_at,
        evidence: { reviews, comment, commitSha: commit.sha },
      };
  }
  return null;
}

export async function reviewLoopPull(
  statePath: string,
  root: string,
  selfReceiptPath?: string,
  invoke: typeof gh = gh,
) {
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = await sourceIsCurrent(run, workspace, manifest);
    if (view.phase !== "review" || !view.review) throw new Error("loop_review_not_requested");
    const call = bounded(run, invoke);
    const collected = await collect(run, workspace, call, "pr");
    if (
      collected.report.checks.some(
        (c) => ["snapshot-stable", "review-threads"].includes(c.id) && c.status !== "pass",
      )
    )
      return { ...view, reason: "github_review_gates_pending" };
    let receipt: unknown, evidence: unknown;
    if (selfReceiptPath) {
      const supplied = parseLoopReview(await json(selfReceiptPath));
      if (supplied.method !== "self")
        throw new Error("self_review_must_identify_its_author_method");
      receipt = { ...supplied, artifactUri: `${collected.artifactUri}/review.json` };
      evidence = { receipt };
    } else {
      const completed = await codexCompletion(run, call);
      if (!completed) return assessLoopRun(await readLoopRun(statePath));
      const finished = run.events
        .slice()
        .reverse()
        .find((e) => e.type === "attempt-finished");
      const scope = finished?.data.scope;
      if (!isRecord(scope) || !Array.isArray(scope.changes))
        throw new Error("review_scope_missing");
      receipt = {
        sourceSha: view.lastVerifiedSha,
        method: "codex",
        completedAt: completed.completedAt,
        summary: "Codex completed review of this commit; all GitHub review threads are resolved",
        reviewedPaths: scope.changes.map((item) => (isRecord(item) ? item.path : null)),
        unresolvedFindings: 0,
        artifactUri: `${collected.artifactUri}/review.json`,
      };
      evidence = { receipt, ...completed.evidence };
    }
    await writeFile(join(collected.directory, "review.json"), JSON.stringify(evidence, null, 2), {
      flag: "wx",
    });
    const after = await api(call, `repos/${run.spec.repository}/pulls/${view.review.prNumber}`);
    if (!isRecord(after) || !isRecord(after.head) || after.head.sha !== view.lastVerifiedSha)
      throw new Error("pull_changed_during_review");
    await sourceIsCurrent(await readLoopRun(statePath), workspace, manifest);
    return recordLoopEvent(statePath, run, "reviewed", { receipt });
  });
}

export async function observeLoopDelivery(statePath: string, root: string, invoke: typeof gh = gh) {
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = await sourceIsCurrent(run, workspace, manifest);
    if (view.phase === "completed") return view;
    if (view.phase !== "delivery") throw new Error("loop_delivery_before_review");
    const result = await collect(run, workspace, bounded(run, invoke));
    return recordLoopEvent(statePath, run, "delivery-observed", { snapshot: result.snapshot });
  });
}

export async function mergeLoopPull(statePath: string, root: string, invoke: typeof gh = gh) {
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = await sourceIsCurrent(run, workspace, manifest);
    if (
      run.spec.delivery.target === "pr" ||
      view.phase !== "delivery" ||
      !view.review ||
      !view.reviewReceipt
    )
      throw new Error("loop_merge_not_authorized_or_reviewed");
    const call = bounded(run, invoke),
      repo = run.spec.repository,
      number = view.review.prNumber;
    const before = await collect(run, workspace, call, "pr");
    if (!isRecord(before.snapshot) || !isRecord(before.snapshot.pull))
      throw new Error("invalid_merge_snapshot");
    if (!before.snapshot.pull.merged) {
      const approval = run.spec.task.requirements.some((r) => r.id === "review-approval");
      const required = [
        "ci",
        "review-threads",
        "snapshot-stable",
        ...(approval ? ["review-approval"] : []),
      ];
      const gate = assessHarnessReport({
        ...before.report,
        checks: before.report.checks.map((c) => ({ ...c, required: required.includes(c.id) })),
      });
      if (gate.status !== "pass") throw new Error("loop_merge_gates_incomplete");
      await sourceIsCurrent(await readLoopRun(statePath), workspace, manifest);
      const result: unknown = JSON.parse(
        await call([
          "api",
          "--hostname",
          "github.com",
          "--method",
          "PUT",
          `repos/${repo}/pulls/${number}/merge`,
          "-f",
          `sha=${view.lastVerifiedSha}`,
          "-f",
          "merge_method=merge",
        ]),
      );
      if (!isRecord(result) || result.merged !== true) throw new Error("github_did_not_merge_pull");
    }
    const after = await collect(run, workspace, call);
    return recordLoopEvent(statePath, run, "delivery-observed", { snapshot: after.snapshot });
  });
}
