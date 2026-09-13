import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckStatus } from "../report.js";

export interface LoopCommand {
  cwd: string;
  args: string[];
  logPath: string;
  deadline: string;
  costOutput?: string;
}
export interface LoopCommandResult {
  status: CheckStatus;
  startedAt: string;
  finishedAt: string;
  reason: string;
}

/** Fixed argv comes from the trusted evaluator, never incident text or generated commands. */
export async function runLoopCommand(request: LoopCommand): Promise<LoopCommandResult> {
  const startedAt = new Date().toISOString();
  const remaining = Date.parse(request.deadline) - Date.now();
  await mkdir(dirname(request.logPath), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (!["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].includes(key)) delete env[key];
  env.CI = "true";
  env.NO_COLOR = "1";
  if (request.costOutput) env.HARNESS_COST_OUTPUT = request.costOutput;
  let log = "",
    bytes = 0;
  let reason = "command_completed";
  const status: CheckStatus =
    remaining <= 0
      ? "unknown"
      : await new Promise((resolve) => {
          const child = spawn("vp", request.args, {
            cwd: request.cwd,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const kill = () => {
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                /* Process group already exited. */
              }
            }
          };
          const timer = setTimeout(
            () => {
              reason = "command_deadline_exhausted";
              kill();
            },
            Math.min(remaining, 600_000),
          );
          const consume = (chunk: Buffer) => {
            const room = Math.max(0, 1_048_576 - bytes);
            log += chunk.subarray(0, room).toString("utf8");
            bytes += chunk.length;
            if (bytes > 1_048_576) {
              reason = "command_output_limit";
              kill();
            }
          };
          child.stdout.on("data", consume);
          child.stderr.on("data", consume);
          child.once("error", () => {
            reason = "command_start_failed";
          });
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            kill(); // Reap subprocesses that outlived the parent as well.
            resolve(
              reason !== "command_completed" || signal || code === null
                ? "unknown"
                : code === 0
                  ? "pass"
                  : "fail",
            );
          });
        });
  if (remaining <= 0) reason = "command_deadline_exhausted";
  await writeFile(request.logPath, log || reason, { flag: "wx" });
  return { status, startedAt, finishedAt: new Date().toISOString(), reason };
}
