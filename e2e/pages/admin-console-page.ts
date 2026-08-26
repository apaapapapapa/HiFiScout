import type { Locator, Page } from "@playwright/test";

export class AdminConsolePage {
  readonly heading: Locator;
  readonly catalogTab: Locator;
  readonly listingsTab: Locator;
  readonly catalogPane: Locator;
  readonly listingsPane: Locator;
  readonly sectionLinks: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole("heading", { name: "HiFiScout 管理コンソール" });
    this.catalogTab = page.getByRole("tab", { name: /Knowledge Catalog/u });
    this.listingsTab = page.getByRole("tab", { name: /登録商品/u });
    this.catalogPane = page.locator("#catalog-pane");
    this.listingsPane = page.locator("#listings-pane");
    this.sectionLinks = page.getByRole("group", { name: /内の機能/u }).getByRole("button");
  }

  async goto(hash = ""): Promise<void> {
    await this.page.goto(`/${hash}`);
  }

  async openCatalog(): Promise<void> {
    await this.catalogTab.click();
  }

  async openListings(): Promise<void> {
    await this.listingsTab.click();
  }

  sectionLink(name: string): Locator {
    return this.page.getByRole("button", { name, exact: true });
  }
}
