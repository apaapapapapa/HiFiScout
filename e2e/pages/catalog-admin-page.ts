import type { Locator } from "@playwright/test";

export class CatalogAdminPage {
  readonly heading: Locator;
  readonly status: Locator;
  readonly query: Locator;
  readonly manufacturerId: Locator;
  readonly category: Locator;
  readonly searchButton: Locator;
  readonly resultSummary: Locator;
  readonly duplicateHeading: Locator;
  readonly candidateHeading: Locator;
  readonly csvSummary: Locator;
  readonly editDialog: Locator;

  constructor(readonly root: Locator) {
    this.heading = root.getByRole("heading", { name: "Knowledge Catalog 管理" });
    this.status = root.getByRole("status").first();
    this.query = root.locator("#catalog-catalog-query");
    this.manufacturerId = root.locator("#catalog-manufacturer-id");
    this.category = root.locator("#catalog-category-filter");
    this.searchButton = root
      .locator('section[aria-labelledby="catalog-search-heading"]')
      .getByRole("button", { name: "検索", exact: true });
    this.resultSummary = root
      .getByRole("region", { name: "Knowledge Catalog 一覧" })
      .locator(".result-summary");
    this.duplicateHeading = root.getByRole("heading", { name: "同一製品の重複Catalogを統合" });
    this.candidateHeading = root.getByRole("heading", { name: "未検証候補を確認" });
    this.csvSummary = root.locator(".export-panel summary");
    this.editDialog = root.locator("dialog").first();
  }

  async searchFor(value: string): Promise<void> {
    await this.query.fill(value);
    await this.searchButton.click();
  }

  catalogRow(id: number): Locator {
    return this.root.locator(`[data-catalog-id="${id}"]`).first();
  }

  async openEditor(id: number): Promise<void> {
    await this.catalogRow(id)
      .getByRole("button", { name: /を編集$/u })
      .click();
  }

  editName(): Locator {
    return this.editDialog.getByLabel("表示名");
  }

  saveButton(): Locator {
    return this.editDialog.getByRole("button", { name: "変更を保存" });
  }
}
