import { readFile } from "node:fs/promises";
import { loopSpecDigest, parseLoopSpec } from "./contract.js";
import { assessLoopRun } from "./controller.js";
import { createLoopRun, readLoopRun } from "./state.js";
import { collectCiIntake, ingestLoopSignal, specFromSignal } from "./intake.js";

export async function runLoopCli(args: string[]): Promise<number> {
  const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
  let result: unknown;
  if (args[0] === "validate" && args.length === 2) {
    const spec = parseLoopSpec(await json(args[1]));
    result = { spec, digest: loopSpecDigest(spec) };
  } else if (args[0] === "init" && args.length === 3)
    result = await createLoopRun(await json(args[1]), args[2]);
  else if (args[0] === "history" && args.length === 2) result = await readLoopRun(args[1]);
  else if (args[0] === "status" && args.length === 2)
    result = assessLoopRun(await readLoopRun(args[1]));
  else if (args[0] === "ingest" && args.length === 3) {
    const item = await ingestLoopSignal(await json(args[1]), args[2]);
    result = { item, spec: specFromSignal(item.signal) };
  } else if (args[0] === "intake-ci" && args.length === 4)
    result = await collectCiIntake(args[1], Number(args[2]), args[3]);
  else
    throw new Error(
      "usage: harness loop validate <spec> | init <spec> <state> | history <state> | status <state> | ingest <signal> <index> | intake-ci <owner/repo> <run-id> <directory>",
    );
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
