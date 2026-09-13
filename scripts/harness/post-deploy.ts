import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requireSha, requireText, requireTimestamp } from "./report.js";
import { isRecord } from "../../src/types.js";

export function parsePostDeployReceipt(value: unknown) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.event !== "workflow_run" ||
    (value.context !== "verification/e2e" && value.context !== "deployment/catalog-admin")
  )
    throw new Error("invalid_post_deploy_receipt");
  const integer = (n: unknown) => {
    if (!Number.isSafeInteger(n) || Number(n) <= 0) throw new Error("invalid_workflow_identity");
    return Number(n);
  };
  const url = (v: unknown) => {
    const result = new URL(requireText(v, "target_url"));
    if (
      result.protocol !== "https:" ||
      result.username ||
      result.password ||
      result.search ||
      result.hash
    )
      throw new Error("invalid_production_target");
    return result.href.replace(/\/$/u, "");
  };
  const targetUrl = url(value.targetUrl);
  const expectedUrl = url(value.expectedUrl);
  if (targetUrl !== expectedUrl) throw new Error("non_production_verification_target");
  return {
    schemaVersion: 1,
    event: value.event,
    context: value.context,
    sourceSha: requireSha(value.sourceSha),
    deploymentRunId: integer(value.deploymentRunId),
    runId: integer(value.runId),
    runAttempt: integer(value.runAttempt),
    targetUrl,
    expectedUrl,
    recordedAt: requireTimestamp(value.recordedAt),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = parsePostDeployReceipt({
    schemaVersion: 1,
    event: process.env.GITHUB_EVENT_NAME,
    context: process.argv[2],
    sourceSha: process.env.HARNESS_DEPLOYMENT_SHA,
    deploymentRunId: Number(process.env.HARNESS_DEPLOYMENT_RUN_ID),
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    targetUrl: process.env.HARNESS_TARGET_URL,
    expectedUrl: process.env.HARNESS_EXPECTED_URL,
    recordedAt: new Date().toISOString(),
  });
  const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (checkedOut !== receipt.sourceSha) throw new Error("receipt_checkout_sha_mismatch");
  await writeFile("post-deploy-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
}
