import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexUrl = new URL("../public/index.html", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

test("the public catalog mounts through the React entrypoint", async () => {
  const [html, packageText] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(packageUrl, "utf8"),
  ]);
  const packageJson = JSON.parse(packageText) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  assert.match(html, /<div id="root"><\/div>/u);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/u);
  assert.doesNotMatch(html, /catalog-url-state\.js|shop-filter-order\.js|shop-links\.js/u);
  assert.match(packageJson.scripts?.["build:frontend:public"] ?? "", /frontend\/app\.tsx/u);
  assert.ok(packageJson.dependencies?.react);
  assert.ok(packageJson.dependencies?.["react-dom"]);
});
