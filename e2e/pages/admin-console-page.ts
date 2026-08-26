import type { Locator, Page } from "@playwright/test";

import { CatalogAdminPage } from "./catalog-admin-page.js";
import { ListingAdminPage } from "./listing-admin-page.js";

export class AdminConsolePage {
  readonly heading: Locator;
  readonly catalogTab: Locator;
  readonly listingsTab: Locator;
  readonly sectionLinks: Locator;
  readonly catalog: CatalogAdminPage;
  readonly listings: ListingAdminPage;

  constructor(
    readonly root: Locator,
    readonly page: Page,
  ) {
    this.heading = root.getByRole("heading", { name: "HiFiScout 管理コンソール" });
    this.catalogTab = root.getByRole("tab", { name: /Knowledge Catalog/u });
    this.listingsTab = root.getByRole("tab", { name: /登録商品/u });
    this.sectionLinks = root.getByRole("group", { name: /内の機能/u }).getByRole("button");
    this.catalog = new CatalogAdminPage(root.locator("#catalog-pane"));
    this.listings = new ListingAdminPage(root.locator("#listings-pane"));
  }

  async openCatalog(): Promise<void> {
    await this.catalogTab.click();
  }

  async openListings(): Promise<void> {
    await this.listingsTab.click();
  }

  sectionLink(name: string): Locator {
    return this.root.getByRole("button", { name, exact: true });
  }
}
