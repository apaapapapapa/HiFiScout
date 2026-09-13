import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord } from "../../../src/types.js";
import { readCheckout } from "../checkpoint.js";
import type { HarnessCheck } from "../report.js";
import { requireSha } from "../report.js";
import { pathAllowed, relativePath } from "./contract.js";
import type { LoopSpec } from "./contract.js";

export interface LoopChange {
  path: string;
  status: "A" | "M" | "D";
  oldMode: string;
  newMode: string;
}
export interface LoopScope {
  baselineSha: string;
  sourceSha: string;
  artifactUri: string;
  changes: LoopChange[];
}

export function assessLoopScope(spec: LoopSpec, sourceSha: string, value: unknown): HarnessCheck {
  const check: HarnessCheck = {
    id: "loop:change-scope",
    scope: "source",
    required: true,
    status: "unknown",
    reason: "Missing source-bound change list",
    evidence: [],
  };
  if (
    !isRecord(value) ||
    !Array.isArray(value.changes) ||
    value.changes.length > 200 ||
    value.baselineSha !== spec.baselineSha ||
    value.sourceSha !== sourceSha
  )
    return check;
  const uri = relativePath(value.artifactUri);
  const seen = new Set<string>();
  for (const item of value.changes) {
    if (
      !isRecord(item) ||
      !["A", "M", "D"].includes(String(item.status)) ||
      !["000000", "100644", "100755"].includes(String(item.oldMode)) ||
      !["000000", "100644", "100755"].includes(String(item.newMode))
    )
      return { ...check, status: "fail", reason: "Unsupported change or file mode" };
    const path = relativePath(item.path);
    if (
      (item.status === "A" && (item.oldMode !== "000000" || item.newMode === "000000")) ||
      (item.status === "D" && (item.newMode !== "000000" || item.oldMode === "000000")) ||
      (item.status === "M" && (item.oldMode === "000000" || item.newMode === "000000"))
    )
      return { ...check, reason: "Inconsistent change status and modes" };
    if (seen.has(path)) return { ...check, reason: "Duplicate change path" };
    seen.add(path);
    if (
      !pathAllowed(spec, path) ||
      (path.startsWith("test/") && item.status !== "A") ||
      (item.oldMode !== "000000" && item.newMode !== "000000" && item.oldMode !== item.newMode)
    )
      return {
        ...check,
        status: "fail",
        reason: `Change outside the frozen repair boundary: ${path}`,
      };
  }
  return {
    ...check,
    status: "pass",
    reason: "Complete baseline-to-candidate change list respects the frozen scope",
    evidence: [{ uri, sourceSha }],
  };
}

export function readLoopChanges(baselineSha: string, sourceSha: string, cwd: string): LoopChange[] {
  const raw = execFileSync(
    "git",
    [
      "diff",
      "--raw",
      "--abbrev=40",
      "--no-renames",
      "-z",
      requireSha(baselineSha),
      requireSha(sourceSha),
      "--",
    ],
    { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 },
  );
  const entries = raw.split("\0");
  if (entries.pop() !== "" || entries.length % 2 !== 0) throw new Error("invalid_git_change_list");
  const changes: LoopChange[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([AMD])$/u.exec(entries[i]);
    if (!match) throw new Error("unsupported_git_change");
    changes.push({
      path: relativePath(entries[i + 1]),
      oldMode: match[1],
      newMode: match[2],
      status: match[3] as LoopChange["status"],
    });
  }
  return changes;
}

export async function collectLoopScope(
  spec: LoopSpec,
  cwd: string,
  artifactUri = ".generated/loop-scope.json",
): Promise<LoopScope> {
  const checkout = readCheckout(cwd);
  if (checkout.dirty) throw new Error("scope_requires_clean_checkout");
  const scope: LoopScope = {
    baselineSha: requireSha(spec.baselineSha),
    sourceSha: checkout.sourceSha,
    artifactUri: relativePath(artifactUri),
    changes: readLoopChanges(spec.baselineSha, checkout.sourceSha, cwd),
  };
  // A negative result is evidence too; preserve it before the controller blocks this attempt.
  assessLoopScope(spec, checkout.sourceSha, scope);
  const path = resolve(cwd, scope.artifactUri);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(scope, null, 2)}\n`, { flag: "wx" });
  return scope;
}
