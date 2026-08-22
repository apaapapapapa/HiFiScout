import { $select } from "./dom.js";
import { escapeHtml } from "./format.js";
import { sortShopsByJapaneseReading } from "./shop-options.js";

/** Reorder only the search condition's shop options; the metadata array stays untouched. */
export function sortShopFilterOptions(select: HTMLSelectElement): void {
  const current = [...select.options]
    .filter((option) => option.value)
    .map((option) => ({
      key: option.value,
      name: option.textContent?.trim() || option.value,
    }));
  const sorted = sortShopsByJapaneseReading(current);
  if (sorted.every((entry, index) => entry.key === current[index]?.key)) return;

  const selectedValue = select.value;
  const allLabel = [...select.options].find((option) => !option.value)?.textContent?.trim() || "すべて";
  select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>${sorted
    .map(
      (entry) =>
        `<option value="${escapeHtml(entry.key)}">${escapeHtml(entry.name)}</option>`,
    )
    .join("")}`;
  select.value = selectedValue;
}

function installShopFilterOrdering(): void {
  const select = $select("shop");
  const sort = () => sortShopFilterOptions(select);
  sort();
  new MutationObserver(sort).observe(select, { childList: true });
}

installShopFilterOrdering();
