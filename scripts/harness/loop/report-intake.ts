import { isRecord } from "../../../src/types.js";
import { parseHarnessReport, requireText } from "../report.js";
import { requireRepository } from "../delivery.js";
import { loopKinds } from "./contract.js";
import type { LoopKind } from "./contract.js";
import { parseLoopSignal, persistLoopIntake } from "./intake.js";

// Saved report data proposes work. It neither executes incident text nor mutates production.
export function signalsFromHarnessReport(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !loopKinds.some((k) => k === value.kind))
    throw new Error("invalid_report_intake");
  const kind = value.kind as LoopKind,
    repository = requireRepository(value.repository),
    report = parseHarnessReport(value.report),
    evidence = new URL(requireText(value.evidenceUrl, "report_evidence_url"));
  if (
    report.checks.length > 200 ||
    evidence.protocol !== "https:" ||
    evidence.username ||
    evidence.password ||
    evidence.href.length > 2000
  )
    throw new Error("invalid_report_intake_bounds_or_url");
  const owns = (id: string) =>
    kind === "ci"
      ? id === "source-checks"
      : kind === "product"
        ? id.startsWith("replay/") || id === "comparison:replay"
        : kind === "cost"
          ? id.startsWith("cost/") || id === "comparison:cost"
          : id === "ai/offline-holdout";
  const signals = report.checks
    .filter(
      (check) =>
        check.required &&
        check.scope === "source" &&
        check.status === "fail" &&
        owns(check.id) &&
        check.evidence.length > 0 &&
        check.evidence.every((e) => e.sourceSha === report.sourceSha),
    )
    .map((check) =>
      parseLoopSignal({
        schemaVersion: 1,
        kind,
        repository,
        sourceSha: report.sourceSha,
        observedAt: report.finishedAt,
        failureKey: `report:${check.id}`,
        summary: `Reproduce ${check.id}: ${check.reason}`,
        evidenceUrl: evidence.href,
      }),
    );
  return {
    signals,
    reason: signals.length ? "required_source_failures" : "no_supported_repair_evidence",
  };
}

export async function collectReportIntake(value: unknown, output: string) {
  return persistLoopIntake(signalsFromHarnessReport(value), output);
}
