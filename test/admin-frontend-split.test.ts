import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const adminConsole = readFileSync(
  new URL("../frontend/admin-console.tsx", import.meta.url),
  "utf8",
);
const catalogAdmin = readFileSync(
  new URL("../frontend/admin-catalog.tsx", import.meta.url),
  "utf8",
);
const listingAdmin = readFileSync(
  new URL("../frontend/admin-listings.tsx", import.meta.url),
  "utf8",
);

test("admin frontend builds one React application bundle", () => {
  const command = packageJson.scripts?.["build:frontend:admin"] || "";
  assert.match(command, /frontend\/admin-console\.tsx/u);
  assert.match(command, /--outfile=admin-public\/admin-console\.js/u);
  assert.match(command, /process\.env\.NODE_ENV/u);
  assert.doesNotMatch(command, /frontend\/catalog-admin\.ts/u);
  assert.doesNotMatch(command, /frontend\/catalog-admin-operations\.ts/u);
  assert.doesNotMatch(command, /frontend\/listing-admin\.ts/u);
});

test("legacy admin sources and HTML fragments are removed", () => {
  for (const relative of [
    "../frontend/admin-console.ts",
    "../frontend/catalog-admin.ts",
    "../frontend/catalog-admin-operations.ts",
    "../frontend/listing-admin.ts",
    "../admin-public/catalog-admin.html",
    "../admin-public/listing-admin.html",
  ]) {
    assert.equal(
      existsSync(new URL(relative, import.meta.url)),
      false,
      `${relative} must be removed`,
    );
  }
});

test("admin shell and both workspaces are React components", () => {
  assert.match(adminConsole, /from "react"/u);
  assert.match(adminConsole, /createRoot/u);
  assert.match(adminConsole, /<CatalogAdmin/u);
  assert.match(adminConsole, /<ListingAdmin/u);
  assert.match(catalogAdmin, /useState/u);
  assert.match(catalogAdmin, /useEffect/u);
  assert.match(listingAdmin, /useState/u);
  assert.match(listingAdmin, /useEffect/u);
});

test("React admin no longer bootstraps legacy DOM or scripts", () => {
  const sources = [adminConsole, catalogAdmin, listingAdmin].join("\n");
  assert.doesNotMatch(sources, /DOMParser/u);
  assert.doesNotMatch(sources, /createElement\(["']script["']/u);
  assert.doesNotMatch(sources, /appendChild\(script/u);
  assert.doesNotMatch(sources, /MutationObserver/u);
  assert.doesNotMatch(sources, /\.innerHTML\s*=/u);
  assert.doesNotMatch(sources, /replaceChildren\(/u);
  assert.doesNotMatch(sources, /document\.addEventListener\(/u);
});
