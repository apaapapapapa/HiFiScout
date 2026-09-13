import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { assessLoopRun, assessLoopSource } from "./controller.js";
import type { CheckoutState } from "../checkpoint.js";
import { parseLoopRun } from "./state.js";
import { bindRequiredChecks, requireTimestamp } from "../report.js";
import { isDeliveryCheck } from "./contract.js";

export function loopStatus(value: unknown, now = new Date().toISOString()) {
  const run = parseLoopRun(value),
    at = requireTimestamp(now),
    view = assessLoopRun(run, at);
  const heartbeat = run.events
    .slice()
    .reverse()
    .find((event) => event.type === "heartbeat");
  const required = new Set(
    run.spec.task.requirements
      .filter((r) => r.scope === "source" && !isDeliveryCheck(r.id))
      .map((r) => r.id),
  );
  for (const comparison of run.spec.comparisons) required.add(`comparison:${comparison}`);
  let best = -1,
    lastImprovementAt: string | null = null;
  for (const event of run.events) {
    if (event.type !== "attempt-finished") continue;
    const report = assessLoopSource(
      run.spec,
      event.data.report,
      event.data.checkout as CheckoutState,
      event.data.scope,
    );
    const passed = report.checks.filter(
      (check) => required.has(check.id) && check.status === "pass",
    ).length;
    if (best >= 0 && passed > best) lastImprovementAt = event.at;
    best = Math.max(best, passed);
  }
  const terminal = ["completed", "stopped"].includes(view.phase);
  const nextCheckAt =
    terminal || view.phase === "blocked"
      ? null
      : new Date(
          Math.min(
            Date.parse(at) + 60_000,
            Date.parse(view.deadline),
            view.phase === "review" && view.review
              ? Math.max(Date.parse(at), Date.parse(view.review.deadline))
              : Infinity,
          ),
        ).toISOString();
  const checks = bindRequiredChecks(run.spec.task.requirements, [
    ...new Map(
      [...(view.lastReport?.checks ?? []), ...(view.lastDeliveryReport?.checks ?? [])].map(
        (check) => [check.id, check],
      ),
    ).values(),
  ]);
  return {
    ...view,
    generatedAt: at,
    goal: run.spec.task.goal,
    baselineSha: run.spec.baselineSha,
    target: run.spec.delivery.target,
    specDigest: run.specDigest,
    lastEventAt: run.updatedAt,
    lastHeartbeatAt: heartbeat?.at ?? null,
    lastImprovementAt,
    idleSinceProgressMs: Date.parse(at) - Date.parse(view.lastProgressAt),
    remaining: {
      iterations: Math.max(0, run.spec.budget.maxIterations - view.attempts),
      externalCalls: Math.max(0, run.spec.budget.maxExternalCalls - view.externalCalls),
      reservedCostMicros: Math.max(
        0,
        run.spec.budget.maxReservedCostMicros - view.reservedCostMicros,
      ),
      durationMs: Math.max(0, Date.parse(view.deadline) - Date.parse(at)),
    },
    blockers: checks
      .filter((c) => c.required && c.status !== "pass")
      .map((c) => ({ id: c.id, status: c.status, reason: c.reason })),
    nextCheckAt,
    estimatedCompletionAt: null,
    processLiveness: "not_observed" as const,
  };
}

export function loopStatusMarkdown(value: ReturnType<typeof loopStatus>): string {
  const cell = (text: unknown) =>
    String(text ?? "—")
      .replaceAll("|", "\\|")
      .replace(/[\r\n]+/gu, " ");
  const rows: [string, unknown][] = [
    ["目標", value.goal],
    ["状態（保存記録）", value.phase],
    ["理由", value.reason],
    ["完了条件", value.target],
    ["試行回数 / 残り", `${value.attempts} / ${value.remaining.iterations}`],
    ["外部呼び出し予約 / 残り", `${value.externalCalls} / ${value.remaining.externalCalls}`],
    [
      "費用予約（micro）/ 残り",
      `${value.reservedCostMicros} / ${value.remaining.reservedCostMicros}`,
    ],
    ["最後の進捗記録", value.lastProgressAt],
    ["最後の評価改善", value.lastImprovementAt],
    ["最後のheartbeat", value.lastHeartbeatAt],
    ["全体期限", value.deadline],
    ["レビュー期限", value.review?.deadline],
    ["次の操作", value.nextAction],
    ["次の確認目安", value.nextCheckAt],
    ["完了予定", "未確定"],
    ["検証済み候補SHA", value.lastVerifiedSha],
    ["配信側で確認したSHA", value.lastDeliveryReport?.sourceSha],
  ];
  const lines = [
    `## Improvement loop: ${value.taskId}`,
    "",
    "| 項目 | 記録 |",
    "| --- | --- |",
    ...rows.map(([key, text]) => `| ${key} | ${cell(text)} |`),
    "",
    "heartbeatは稼働報告であり、評価改善や完了の証拠ではありません。実プロセスの生存状態はこの記録からは断定しません。",
  ];
  if (value.blockers.length)
    lines.push(
      "",
      "| 未達の条件 | 状態 | 理由 |",
      "| --- | --- | --- |",
      ...value.blockers.map(
        (item) => `| ${cell(item.id)} | ${item.status} | ${cell(item.reason)} |`,
      ),
    );
  return `${lines.join("\n")}\n`;
}

export async function writeLoopStatus(value: unknown, directory: string) {
  const status = loopStatus(value),
    id = randomUUID();
  await mkdir(directory, { recursive: true });
  // A reader sees a complete snapshot, including when an operator replaces an earlier display.
  for (const [name, contents] of [
    ["status.json", `${JSON.stringify(status, null, 2)}\n`],
    ["status.md", loopStatusMarkdown(status)],
  ]) {
    const temporary = join(directory, `${name}.${id}.tmp`);
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, join(directory, name));
  }
  return status;
}
