import { test as base } from "@playwright/test";
import { CatalogPage } from "../pages/catalog-page.js";

interface CatalogFixtures {
  catalogPage: CatalogPage;
}

export const test = base.extend<CatalogFixtures>({
  catalogPage: async ({ page }, use) => {
    await use(new CatalogPage(page));
  },
});

export { expect } from "@playwright/test";
