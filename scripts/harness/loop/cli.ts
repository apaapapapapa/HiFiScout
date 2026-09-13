import { readFile } from "node:fs/promises";
import { loopSpecDigest, parseLoopSpec } from "./contract.js";
import { beginLoopAttempt, recordLoopEvent } from "./controller.js";
import { isRecord } from "../../../src/types.js";
import { applyLoopPatch, prepareLoopWorkspace } from "./workspace.js";
import { evaluateLoopAttempt } from "./evaluation.js";
import {
  publishLoopPull,
  reviewLoopPull,
  observeLoopDelivery,
  mergeLoopPull,
} from "./publication.js";
import { createLoopRun, readLoopRun } from "./state.js";
import { collectCiIntake, ingestLoopSignal, specFromSignal } from "./intake.js";
import { loopStatus, loopStatusMarkdown, writeLoopStatus } from "./status.js";
import { proveLoopRegression, learnFromLoop } from "./learning.js";

export async function runLoopCli(args: string[]): Promise<number> {
  const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
  let result: unknown;
  if (args[0] === "validate" && args.length === 2) {
    const spec = parseLoopSpec(await json(args[1]));
    result = { spec, digest: loopSpecDigest(spec) };
  } else if (args[0] === "init" && args.length === 3)
    result = await createLoopRun(await json(args[1]), args[2]);
  else if (args[0] === "history" && args.length === 2) result = await readLoopRun(args[1]);
  else if (
    args[0] === "status" &&
    (args.length === 2 || (args.length === 3 && args[2] === "--markdown"))
  ) {
    result = loopStatus(await readLoopRun(args[1]));
    if (args[2] === "--markdown") {
      console.log(loopStatusMarkdown(result as ReturnType<typeof loopStatus>));
      return 0;
    }
  } else if (args[0] === "regression" && args.length === 4)
    result = await proveLoopRegression(args[1], args[2], await json(args[3]));
  else if (args[0] === "learn" && args.length === 5)
    result = await learnFromLoop(args[1], args[2], await json(args[3]), args[4]);
  else if (args[0] === "snapshot" && args.length === 3)
    result = await writeLoopStatus(await readLoopRun(args[1]), args[2]);
  else if (args[0] === "heartbeat" && args.length === 2)
    result = await recordLoopEvent(args[1], await readLoopRun(args[1]), "heartbeat", {});
  else if (args[0] === "ingest" && args.length === 3) {
    const item = await ingestLoopSignal(await json(args[1]), args[2]);
    result = { item, spec: specFromSignal(item.signal) };
  } else if (args[0] === "intake-ci" && (args.length === 4 || args.length === 5)) {
    if (args[4] !== undefined && args[4] !== "automatic" && args[4] !== "manual")
      throw new Error("invalid_intake_mode");
    result = await collectCiIntake(
      args[1],
      Number(args[2]),
      args[3],
      undefined,
      args[4] === "manual",
    );
  } else if (args[0] === "publish" && args.length === 3)
    result = await publishLoopPull(args[1], args[2]);
  else if (args[0] === "review" && (args.length === 3 || args.length === 4))
    result = await reviewLoopPull(args[1], args[2], args[3]);
  else if (args[0] === "observe" && args.length === 3)
    result = await observeLoopDelivery(args[1], args[2]);
  else if (args[0] === "merge" && args.length === 3) result = await mergeLoopPull(args[1], args[2]);
  else if (args[0] === "evaluate" && (args.length === 3 || args.length === 4))
    result = await evaluateLoopAttempt(args[1], args[2], args[3]);
  else if (args[0] === "prepare" && args.length === 4)
    result = await prepareLoopWorkspace(args[1], args[2], args[3]);
  else if (args[0] === "begin" && args.length === 3) {
    const request = await json(args[2]);
    if (
      !isRecord(request) ||
      typeof request.hypothesis !== "string" ||
      typeof request.externalCalls !== "number" ||
      typeof request.reservedCostMicros !== "number"
    )
      throw new Error("invalid_attempt_request");
    result = await beginLoopAttempt(args[1], request.hypothesis, {
      externalCalls: request.externalCalls,
      reservedCostMicros: request.reservedCostMicros,
    });
  } else if (args[0] === "apply" && args.length === 6)
    result = await applyLoopPatch(
      args[1],
      args[2],
      Number(args[3]),
      args[4],
      await readFile(args[5], "utf8"),
    );
  else if (["block", "resume", "stop"].includes(args[0]) && args.length === 3) {
    const type = args[0] === "block" ? "blocked" : args[0] === "resume" ? "resumed" : "stopped";
    result = await recordLoopEvent(args[1], await readLoopRun(args[1]), type, { reason: args[2] });
  } else
    throw new Error(
      "usage: harness loop validate <spec> | init <spec> <state> | history <state> | status <state> | ingest <signal> <index> | intake-ci <owner/repo> <run-id> <directory> | evaluate <state> <workspace-root> [AI-recording] | prepare <state> <source-repo> <workspace-root> | begin <state> <attempt.json> | apply <state> <workspace-root> <iteration> <base-sha> <patch> | block/resume/stop <state> <reason>",
    );
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
