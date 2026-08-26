import type { Locator, Page } from "@playwright/test";

export class CatalogPage {
  readonly heading: Locator;
  readonly syncSummaryText: Locator;
  readonly count: Locator;
  readonly countLabel: Locator;
  readonly manufacturer: Locator;
  readonly manufacturerOptions: Locator;
  readonly products: Locator;
  readonly pagination: Locator;
  readonly loadMore: Locator;
  readonly searchInput: Locator;
  readonly shop: Locator;
  readonly category: Locator;
  readonly activeFilters: Locator;
  readonly filterToggle: Locator;
  readonly filterPanel: Locator;
  readonly applyFiltersButton: Locator;
  readonly favoritesOnly: Locator;
  readonly recentOnly: Locator;
  readonly priceDropped: Locator;
  readonly sort: Locator;
  readonly inStock: Locator;
  readonly moreAvailable: Locator;
  readonly syncStatusSummary: Locator;
  readonly syncStatusDetails: Locator;
  readonly offersDialog: Locator;
  readonly cards: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole("heading", { name: "HiFiScout" });
    this.syncSummaryText = page.locator("#sync-summary-text");
    this.count = page.locator("#count");
    this.countLabel = page.locator("#count-label");
    this.manufacturer = page.locator("#manufacturer");
    this.manufacturerOptions = page.locator("#manufacturer-options option");
    this.products = page.locator("#products");
    this.pagination = page.locator("#pagination");
    this.loadMore = page.locator("#load-more");
    this.searchInput = page.locator("#q");
    this.shop = page.locator("#shop");
    this.category = page.locator("#category");
    this.activeFilters = page.locator("#active-filters");
    this.filterToggle = page.locator("#filter-toggle");
    this.filterPanel = page.locator("#filter-panel");
    this.applyFiltersButton = page.locator("#apply-filters");
    this.favoritesOnly = page.locator("#favoritesOnly");
    this.recentOnly = page.locator("#recentOnly");
    this.priceDropped = page.locator("#priceDropped");
    this.sort = page.locator("#sort");
    this.inStock = page.locator("#inStock");
    this.moreAvailable = page.locator("#more-available");
    this.syncStatusSummary = page.locator("#sync-status summary");
    this.syncStatusDetails = page.locator("#sync-status-details");
    this.offersDialog = page.locator("#offers-dialog");
    this.cards = page.locator(".card");
  }

  async goto(path = "/"): Promise<void> {
    await this.page.goto(path);
  }

  async useMobileViewport(): Promise<void> {
    await this.page.setViewportSize({ width: 390, height: 844 });
  }

  firstShopOption(): Locator {
    return this.shop.locator('option:not([value=""])').first();
  }

  pageButton(pageNumber: number): Locator {
    return this.pagination.getByRole("button", { name: String(pageNumber) });
  }

  pageIndicator(pageNumber: number): Locator {
    return this.pagination.locator(`[data-page="${pageNumber}"]`);
  }

  productTitle(name: string): Locator {
    return this.page.getByRole("link", { name });
  }

  productTitleControl(): Locator {
    return this.page.locator(".product-title-link").first();
  }

  card(key?: string): Locator {
    return key ? this.page.locator(`.card[data-key="${key}"]`) : this.cards;
  }

  cardShop(key?: string): Locator {
    return this.card(key).locator(".shop");
  }

  cardPriceRow(key?: string): Locator {
    return this.card(key).locator(".price-row");
  }

  cardStock(key?: string): Locator {
    return this.card(key).locator(".stock");
  }

  favoriteButton(productKey: string): Locator {
    return this.page.locator(`[data-fav="${productKey}"]`);
  }

  clearFilterButton(filterName: string): Locator {
    return this.page.locator(`[data-clear-filter="${filterName}"]`);
  }

  offerButton(productKey: string): Locator {
    return this.card(productKey).locator(`[data-offers="${productKey}"]`).first();
  }

  offerLinks(): Locator {
    return this.offersDialog.locator(".offer .shop-link");
  }

  async selectShop(value: string): Promise<void> {
    await this.shop.selectOption(value);
  }

  async selectCategory(value: string): Promise<void> {
    await this.category.selectOption(value);
  }

  async openFilters(): Promise<void> {
    await this.filterToggle.click();
  }

  async applyFilters(): Promise<void> {
    await this.applyFiltersButton.click();
  }

  async addFavorite(productKey: string): Promise<void> {
    await this.favoriteButton(productKey).click();
  }

  async goToPage(pageNumber: number): Promise<void> {
    await this.pageButton(pageNumber).click();
  }

  async showFavoritesOnly(): Promise<void> {
    await this.favoritesOnly.check();
  }

  async openSyncDetails(): Promise<void> {
    await this.syncStatusSummary.click();
  }

  async enableRecentOnly(): Promise<void> {
    await this.recentOnly.check();
  }

  async enablePriceDropped(): Promise<void> {
    await this.priceDropped.check();
  }

  async searchFor(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }

  async openOffers(productKey: string): Promise<void> {
    await this.offerButton(productKey).click();
  }
}
