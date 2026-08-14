/**
 * Runs a command and prints nothing when it succeeds.
 *
 * Some tools are noisy even on success: `wrangler types` re-prints the entire generated `Env`
 * interface (~6 KB) on every invocation. That is free in a terminal but expensive for an AI
 * coding agent, where every byte of command output is read back as context tokens on each
 * subsequent turn.
 *
 * Failures print captured stdout and stderr in full, so diagnostic value is unchanged and the
 * child's exit code is propagated.
 *
 * Usage: tsx scripts/run-quiet.ts <command> [args...]
 */
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error("a command to run is required");
}

// `shell: true` resolves `node_modules/.bin` shims, which are `.cmd` files on Windows and cannot
// be spawned directly. The command line is assembled here rather than passed as an argument array
// because Node deprecates (DEP0190) array arguments combined with `shell: true`. Arguments are not
// shell-escaped beyond quoting, so this wrapper is for fixed tooling invocations, not user input.
const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);
const commandLine = [command, ...args].map(quote).join(" ");

const result = spawnSync(commandLine, { encoding: "utf8", shell: true });

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

process.exitCode = result.status ?? 1;
