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
    this.heading = root.locator(".admin-workspace-heading h1");
    this.catalogTab = root.getByRole("link", { name: "製品カタログ", exact: true });
    this.listingsTab = root.getByRole("link", { name: "登録商品", exact: true });
    this.sectionLinks = root.getByRole("navigation", { name: "管理メニュー" }).getByRole("link");
    this.catalog = new CatalogAdminPage(root.locator("#catalog-pane"), root);
    this.listings = new ListingAdminPage(root.locator("#listings-pane"));
  }

  async openCatalog(): Promise<void> {
    if (await this.catalogTab.isVisible()) await this.catalogTab.click();
    else await this.root.getByRole("combobox", { name: "作業を選ぶ" }).selectOption("catalog");
  }

  async openListings(): Promise<void> {
    if (await this.listingsTab.isVisible()) await this.listingsTab.click();
    else await this.root.getByRole("combobox", { name: "作業を選ぶ" }).selectOption("listings");
  }

  sectionLink(name: string): Locator {
    return this.root.getByRole("link", { name, exact: true });
  }
}
