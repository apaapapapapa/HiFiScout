import { ADMIN_VIEWS, adminWorkspace } from "../../frontend/admin-navigation.js";
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

  async openSection(name: string): Promise<void> {
    const view = ADMIN_VIEWS.find((item) => item.label === name);
    if (!view) throw new Error(`Unknown admin task: ${name}`);
    const workspace = adminWorkspace(view.id);
    const workspaceLink = this.root
      .getByRole("navigation", { name: "管理メニュー" })
      .getByRole("link", { name: workspace.label, exact: true });
    if (await workspaceLink.isVisible()) {
      if (!(await this.sectionLink(name).isVisible())) await workspaceLink.click();
      await this.sectionLink(name).click();
    } else {
      await this.root.getByRole("combobox", { name: "管理分野を選ぶ" }).selectOption(workspace.id);
      await this.root.getByRole("combobox", { name: "作業を選ぶ" }).selectOption(view.id);
    }
  }

  async openCatalog(): Promise<void> {
    await this.openSection("製品カタログ");
  }
  async openListings(): Promise<void> {
    await this.openSection("登録商品");
  }

  sectionLink(name: string): Locator {
    return this.root.getByRole("link", { name, exact: true });
  }
}
