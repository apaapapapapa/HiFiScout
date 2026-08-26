import type { Locator } from "@playwright/test";

export class ListingAdminPage {
  readonly heading: Locator;
  readonly status: Locator;
  readonly query: Locator;
  readonly shop: Locator;
  readonly category: Locator;
  readonly scope: Locator;
  readonly searchButton: Locator;
  readonly results: Locator;
  readonly editDialog: Locator;

  constructor(readonly root: Locator) {
    this.heading = root.getByRole("heading", { name: "登録商品 管理" });
    this.status = root.getByRole("status").first();
    this.query = root.locator("#listings-listing-query");
    this.shop = root.locator("#listings-shop-key");
    this.category = root.locator("#listings-category-filter");
    this.scope = root.locator("#listings-listing-scope");
    this.searchButton = root
      .locator('section[aria-labelledby="listing-search-heading"]')
      .getByRole("button", { name: "検索", exact: true });
    this.results = root.getByRole("region", { name: "登録商品一覧" });
    this.editDialog = root.locator("dialog");
  }

  async searchFor(value: string): Promise<void> {
    await this.query.fill(value);
    await this.searchButton.click();
  }

  listingRow(id: number): Locator {
    return this.results.getByRole("row").filter({ hasText: `#${id}` });
  }

  async openEditor(id: number): Promise<void> {
    await this.listingRow(id).getByRole("button", { name: "編集", exact: true }).click();
  }

  presentationColor(): Locator {
    return this.editDialog.getByLabel("表示色 / 仕上げ");
  }

  saveButton(): Locator {
    return this.editDialog.getByRole("button", { name: "変更を保存" });
  }
}
