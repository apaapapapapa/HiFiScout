import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const adminConsole = readFileSync(
  new URL("../frontend/admin-console.tsx", import.meta.url),
  "utf8",
);
const adminConsoleCss = readFileSync(
  new URL("../admin-public/admin-console.css", import.meta.url),
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

test("admin frontend builds one React application bundle with Vite+", () => {
  const command = packageJson.scripts?.["build:frontend:admin"] || "";
  assert.equal(command, "vp build --mode admin");
  assert.match(viteConfig, /\.\/frontend\/admin-console\.tsx/u);
  assert.match(viteConfig, /"admin-public"/u);
  assert.match(viteConfig, /"admin-console\.js"/u);
  assert.match(viteConfig, /process\.env\.NODE_ENV/u);
  assert.doesNotMatch(command, /esbuild/u);
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

test("admin console keeps workspace navigation available while scrolling", () => {
  for (const label of [
    "Catalog検索・編集",
    "重複Catalog統合",
    "未検証候補",
    "CSV診断",
    "登録商品を検索",
    "登録商品一覧",
  ]) {
    assert.match(adminConsole, new RegExp(label, "u"));
  }
  assert.match(adminConsole, /scrollIntoView/u);
  assert.match(adminConsole, /prefers-reduced-motion/u);
  assert.match(adminConsoleCss, /\.admin-section-links/u);
  assert.match(adminConsoleCss, /\.admin-section-link/u);
  assert.match(adminConsoleCss, /position:\s*sticky/u);
  assert.doesNotMatch(adminConsoleCss, /position:\s*static/u);
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

test("admin change handlers snapshot control values before queued state updaters", () => {
  const sources = [catalogAdmin, listingAdmin].join("\n");
  assert.doesNotMatch(sources, /event\.currentTarget\.value/u);
  assert.match(sources, /currentTarget: \{ value: nextValue \}/u);
});
