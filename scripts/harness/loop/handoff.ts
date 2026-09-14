import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord } from "../../../src/types.js";
import { assessDelivery } from "../delivery.js";
import type { DeliverySnapshot } from "../delivery.js";
import { requireTimestamp } from "../report.js";
import { integer } from "./contract.js";
import { recordLoopEvent } from "./controller.js";
import { sourceIsCurrent } from "./publication.js";
import { assessLoopDelivery, parseLoopReview } from "./review.js";
import { withLoopWorkspace } from "./workspace.js";

export type LoopHandoff = "publish" | "review" | "merge-ready" | "observe";

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
    const pullUrl = `https://api.github.com/repos/${run.spec.repository}/pulls/${number}`;
    if (
      input.reviewSubmissionsUrl !== `${pullUrl}/reviews` ||
      !Array.isArray(input.reviewSubmissions)
    )
      throw new Error("handoff_review_collection_missing");
    const decisions = new Map<string, { id: number; state: string }>();
    for (const review of input.reviewSubmissions) {
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
          review.submitted_at !== receipt.completedAt ||
          !input.reviewSubmissions.some(
            (item) =>
              isRecord(item) &&
              item.id === review.id &&
              item.commit_id === review.commit_id &&
              item.submitted_at === review.submitted_at &&
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
