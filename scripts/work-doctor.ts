// Standalone: Node's native TypeScript support can run this before project dependencies exist.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function workDoctor(root: string) {
  const probe = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 10_000 });
    return { ok: !result.error && result.status === 0, output: result.stdout?.trim() ?? "" };
  };
  const value: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (!value || typeof value !== "object" || !("devDependencies" in value))
    throw new Error("invalid_project_package");
  const dependencies = value.devDependencies;
  if (!dependencies || typeof dependencies !== "object" || !("vite-plus" in dependencies))
    throw new Error("missing_vite_plus_pin");
  const expected = dependencies["vite-plus"];
  if (typeof expected !== "string" || !/^\d+\.\d+\.\d+$/u.test(expected))
    throw new Error("vite_plus_must_be_pinned");
  if (!("devEngines" in value) || !value.devEngines || typeof value.devEngines !== "object")
    throw new Error("missing_runtime_pins");
  const engines = value.devEngines;
  const pin = (key: "runtime" | "packageManager") => {
    if (!(key in engines)) throw new Error("missing_runtime_pin");
    const engine: unknown = Reflect.get(engines, key);
    if (
      !engine ||
      typeof engine !== "object" ||
      !("version" in engine) ||
      typeof engine.version !== "string"
    )
      throw new Error("invalid_runtime_pin");
    return engine.version;
  };
  const expectedNode = pin("runtime"),
    expectedNpm = pin("packageManager");
  const origin = probe("git", ["remote", "get-url", "origin"]);
  const source = probe("git", ["rev-parse", "HEAD"]);
  const version = probe("vp", ["--version"]);
  const gh = probe("gh", ["auth", "status", "--hostname", "github.com"]);
  const npm = probe("npm", ["--version"]);
  const repositoryMatches =
    origin.ok &&
    /^(?:https:\/\/github\.com\/|git@github\.com:)apaapapapapa\/HiFiScout(?:\.git)?$/u.test(
      origin.output,
    );
  const dependenciesPresent = existsSync(resolve(root, "node_modules/vite-plus/package.json"));
  const toolchainMatches =
    version.ok && /^vp v?(\d+\.\d+\.\d+)/u.exec(version.output)?.[1] === expected;
  return {
    repositoryMatches,
    sourceSha: source.ok ? source.output : null,
    node: {
      expected: expectedNode,
      observed: process.version,
      matches: process.version === `v${expectedNode}`,
    },
    npm: {
      expected: expectedNpm,
      observed: npm.output || null,
      matches: npm.ok && npm.output === expectedNpm,
    },
    vitePlus: { expected, observed: version.output || null, matches: toolchainMatches },
    dependenciesPresent,
    localCommandsReady:
      repositoryMatches &&
      source.ok &&
      toolchainMatches &&
      dependenciesPresent &&
      process.version === `v${expectedNode}` &&
      npm.ok &&
      npm.output === expectedNpm,
    githubCliAuthenticated: gh.ok,
    connector:
      "Must be checked by the Work session; connector authentication is not shell authentication",
    loop: "No loop is started by this check. Read loop status for an existing journal",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = workDoctor(process.cwd());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.localCommandsReady ? 0 : 2;
}
