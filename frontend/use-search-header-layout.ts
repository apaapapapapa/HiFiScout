import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/** Keep sticky conditions and result-page navigation clear of the responsive search header. */
export function useSearchHeaderLayout(
  mainRef: RefObject<HTMLElement | null>,
  searchRef: RefObject<HTMLElement | null>,
  conditionsRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const main = mainRef.current;
    const search = searchRef.current;
    const conditions = conditionsRef.current;
    if (!main || !search || !conditions) return;

    const update = () => {
      main.style.setProperty("--search-shell-height", `${search.getBoundingClientRect().height}px`);
      main.style.setProperty(
        "--active-filter-bar-height",
        `${conditions.getBoundingClientRect().height}px`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(search);
    observer.observe(conditions);
    update();
    return () => {
      observer.disconnect();
      main.style.removeProperty("--search-shell-height");
      main.style.removeProperty("--active-filter-bar-height");
    };
  }, [mainRef, searchRef, conditionsRef]);
}
