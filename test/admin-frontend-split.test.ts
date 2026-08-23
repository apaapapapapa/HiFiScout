import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const adminConsole = readFileSync(new URL("../frontend/admin-console.ts", import.meta.url), "utf8");

test("admin frontend builds each feature as an independent protected asset", () => {
  const command = packageJson.scripts?.["build:frontend:admin"] || "";
  assert.match(command, /frontend\/admin-console\.ts/u);
  assert.match(command, /frontend\/catalog-admin\.ts/u);
  assert.match(command, /frontend\/catalog-admin-operations\.ts/u);
  assert.match(command, /frontend\/listing-admin\.ts/u);
  assert.doesNotMatch(command, /catalog-admin-bundle/u);
  assert.equal(existsSync(new URL("../frontend/catalog-admin-bundle.ts", import.meta.url)), false);
});

test("unified admin shell loads catalog features explicitly and listing independently", () => {
  assert.match(
    adminConsole,
    /scriptSrcs: \["\/catalog-admin\.js", "\/catalog-admin-operations\.js"\]/u,
  );
  assert.match(adminConsole, /scriptSrcs: \["\/listing-admin\.js"\]/u);
  assert.match(adminConsole, /for \(const scriptSrc of config\.scriptSrcs\)/u);
  assert.match(adminConsole, /await appendLegacyScript\(config, scriptSrc\)/u);
});

test("all scripts for one mounted fragment initialize under one legacy-id ownership window", () => {
  const restoreIndex = adminConsole.indexOf("nodes.forEach((node, index)");
  const loadIndex = adminConsole.indexOf("for (const scriptSrc of config.scriptSrcs)");
  assert.ok(loadIndex >= 0);
  assert.ok(restoreIndex > loadIndex);
});
