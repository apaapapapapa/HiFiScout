import { sortShopsByJapaneseReading } from "./shop-options.js";

interface DomShopOption {
  key: string;
  name: string;
  option: HTMLOptionElement;
}

/** Reorder only the search condition's shop options; the metadata array stays untouched. */
export function sortShopFilterOptions(select: HTMLSelectElement): void {
  const current = [...select.options]
    .filter((option) => option.value)
    .map(
      (option): DomShopOption => ({
        key: option.value,
        name: option.textContent?.trim() || option.value,
        option,
      }),
    );
  const sorted = sortShopsByJapaneseReading(current);
  if (sorted.every((entry, index) => entry.option === current[index]?.option)) return;
  for (const entry of sorted) select.append(entry.option);
}

function installShopFilterOrdering(): void {
  const select = document.querySelector<HTMLSelectElement>("#shop");
  if (!select) return;

  const sort = () => sortShopFilterOptions(select);
  sort();
  new MutationObserver(sort).observe(select, { childList: true });
}

installShopFilterOrdering();
