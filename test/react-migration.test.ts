import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const indexUrl = new URL("../public/index.html", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const entryUrl = new URL("../frontend/app.tsx", import.meta.url);
const appUrl = new URL("../frontend/public-app.tsx", import.meta.url);
const componentsUrl = new URL("../frontend/public-components.tsx", import.meta.url);

const retiredUiSources = [
  "product-view.ts",
  "shop-links.ts",
  "shop-filter-order.ts",
  "catalog-url-state.ts",
  "dom.ts",
].map((name) => new URL(`../frontend/${name}`, import.meta.url));

test("the public catalog mounts through the native React entrypoint", async () => {
  const [html, packageText, entrySource, appSource, componentSource] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(packageUrl, "utf8"),
    readFile(entryUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(componentsUrl, "utf8"),
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
  assert.match(entrySource, /import "\.\/public-app\.js";/u);

  const publicUiSource = `${entrySource}\n${appSource}\n${componentSource}`;
  assert.doesNotMatch(
    publicUiSource,
    /dangerouslySetInnerHTML|\.innerHTML\s*=|MutationObserver|document\.createElement|replaceChildren/u,
  );
  assert.doesNotMatch(
    publicUiSource,
    /product-view|shop-links|shop-filter-order|catalog-url-state|\.\/dom\.js/u,
  );

  for (const source of retiredUiSources) {
    await assert.rejects(access(source));
  }
});
