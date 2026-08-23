import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CategoryOptions } from "../frontend/public-components.js";
import type { MetaCategoryFacet, MetaResponse } from "../src/api/contracts.js";

function facet(
  overrides: Partial<MetaCategoryFacet> & Pick<MetaCategoryFacet, "id" | "name">,
): MetaCategoryFacet {
  return {
    parentId: null,
    order: 1,
    classifiable: false,
    filterable: true,
    group: null,
    activeProductCount: 0,
    ...overrides,
  };
}

function meta(categoryFacets: MetaCategoryFacet[], categories: string[] = []): MetaResponse {
  return {
    status: "healthy",
    shops: [],
    manufacturers: [],
    categories,
    categoryFacets,
  };
}

function renderOptions(value: MetaResponse): string {
  return renderToStaticMarkup(createElement(CategoryOptions, { meta: value }));
}

test("category options preserve server order and separate non-classifiable parents", () => {
  const markup = renderOptions(
    meta([
      facet({ id: "amplifier", name: "アンプ" }),
      facet({
        id: "integrated_amp",
        name: "　プリメインアンプ",
        parentId: "amplifier",
        classifiable: true,
      }),
      facet({ id: "digital", name: "デジタル", order: 2 }),
      facet({
        id: "dac",
        name: "　DAC",
        parentId: "digital",
        classifiable: true,
      }),
      facet({ id: "dj_dtm", name: "DJ機器・DTM", order: 7, classifiable: true }),
    ]),
  );

  assert.equal((markup.match(/data-category-separator="true"/g) || []).length, 4);
  assert.match(
    markup,
    /^<option disabled="" data-category-separator="true">────────────<\/option><option value="amplifier">アンプ<\/option>/u,
  );
  assert.ok(markup.indexOf('value="amplifier"') < markup.indexOf('value="integrated_amp"'));
  assert.ok(markup.indexOf('value="integrated_amp"') < markup.indexOf('value="digital"'));
  assert.ok(markup.indexOf('value="digital"') < markup.indexOf('value="dac"'));
  assert.ok(markup.indexOf('value="dac"') < markup.indexOf('value="dj_dtm"'));
  assert.match(
    markup,
    /<option value="dac">　DAC<\/option><option disabled="" data-category-separator="true">────────────<\/option><option value="dj_dtm">DJ機器・DTM<\/option><option disabled="" data-category-separator="true">────────────<\/option>$/u,
  );
});

test("legacy category fallback stays escaped when facets are unavailable", () => {
  const markup = renderOptions(meta([], ["DAC", "A&B <Other>"]));
  assert.equal(markup, "<option>DAC</option><option>A&amp;B &lt;Other&gt;</option>");
});