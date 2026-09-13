import { isRecord } from "../../src/types.js";

export const HARNESS_SCHEMA_VERSION = 1;
export type CheckStatus = "pass" | "fail" | "unknown" | "skipped";
export type CheckScope = "source" | "deployment" | "observation";

export interface EvidenceReference {
  uri: string;
  sourceSha: string;
}

export interface HarnessCheck {
  id: string;
  required: boolean;
  scope: CheckScope;
  status: CheckStatus;
  reason: string;
  evidence: EvidenceReference[];
}

export interface HarnessReport {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  runId: string;
  sourceSha: string;
  baselineSha: string | null;
  deploymentSha: string | null;
  startedAt: string;
  finishedAt: string;
  checks: HarnessCheck[];
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_${label}`);
  return value;
}

export function requireSha(value: unknown): string {
  const sha = requireText(value, "source_sha");
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("invalid_source_sha");
  return sha;
}

export function requireTimestamp(value: unknown): string {
  const timestamp = requireText(value, "timestamp");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("invalid_timestamp");
  }
  return new Date(timestamp).toISOString();
}

function nullableSha(value: unknown): string | null {
  return value === null ? null : requireSha(value);
}

function parseEvidence(value: unknown): EvidenceReference {
  if (!isRecord(value)) throw new Error("invalid_evidence");
  const uri = requireText(value.uri, "evidence_uri");
  // Reports may link HTTPS evidence or repository-relative artifacts. Never executable URLs,
  // credentials, absolute paths or traversal. This validator does not dereference evidence.
  if (uri.startsWith("https://")) {
    const url = new URL(uri);
    if (!url.hostname || url.username || url.password) throw new Error("invalid_evidence_uri");
  } else if (
    !/^[\w.-][\w./-]*$/u.test(uri) ||
    uri.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error("invalid_evidence_uri");
  }
  return { uri, sourceSha: requireSha(value.sourceSha) };
}

function parseCheck(value: unknown): HarnessCheck {
  if (!isRecord(value) || typeof value.required !== "boolean" || !Array.isArray(value.evidence)) {
    throw new Error("invalid_harness_check");
  }
  const { scope, status } = value;
  if (scope !== "source" && scope !== "deployment" && scope !== "observation") {
    throw new Error("invalid_check_scope");
  }
  if (status !== "pass" && status !== "fail" && status !== "unknown" && status !== "skipped") {
    throw new Error("invalid_check_status");
  }
  return {
    id: requireText(value.id, "check_id"),
    required: value.required,
    scope,
    status,
    reason: requireText(value.reason, "check_reason"),
    evidence: value.evidence.map(parseEvidence),
  };
}

export function parseHarnessReport(value: unknown): HarnessReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HARNESS_SCHEMA_VERSION ||
    !Array.isArray(value.checks)
  ) {
    throw new Error("invalid_harness_report");
  }
  const checks = value.checks.map(parseCheck);
  if (!checks.length || new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error("empty_or_duplicate_checks");
  }
  const startedAt = requireTimestamp(value.startedAt);
  const finishedAt = requireTimestamp(value.finishedAt);
  if (finishedAt < startedAt) throw new Error("invalid_report_interval");
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    runId: requireText(value.runId, "run_id"),
    sourceSha: requireSha(value.sourceSha),
    baselineSha: nullableSha(value.baselineSha),
    deploymentSha: nullableSha(value.deploymentSha),
    startedAt,
    finishedAt,
    checks,
  };
}

export function assessHarnessReport(value: unknown) {
  const report = parseHarnessReport(value);
  const checks = report.checks.map((check): HarnessCheck => {
    if (check.status !== "pass") return check;
    let reason: string | null = null;
    if (!check.evidence.length) reason = "passing_check_has_no_evidence";
    else if (check.evidence.some((item) => item.sourceSha !== report.sourceSha)) {
      reason = "evidence_source_sha_mismatch";
    } else if (check.scope !== "source" && report.deploymentSha !== report.sourceSha) {
      reason = "deployment_identity_unconfirmed";
    }
    return reason ? { ...check, status: "unknown", reason: `${reason}: ${check.reason}` } : check;
  });
  const required = checks.filter((check) => check.required);
  const status = required.some((check) => check.status === "fail")
    ? "fail"
    : !required.length || required.some((check) => check.status !== "pass")
      ? "unknown"
      : "pass";
  return { ...report, checks, status };
}

export function reportExitCode(status: CheckStatus): number {
  return status === "pass" ? 0 : status === "fail" ? 1 : 2;
}
