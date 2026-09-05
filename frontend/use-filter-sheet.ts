import { useEffect } from "react";
import type { RefObject } from "react";

/** The responsive sheet has the same modal keyboard behavior as the native detail dialogs. */
export function useFilterSheet(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  mobile: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    panel.inert = mobile && !open;
    if (!mobile || !open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [
      ...document.querySelectorAll<HTMLElement>(".hero, .search-shell, .catalog-results, footer"),
    ];
    const previous = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });
    panel.querySelector<HTMLElement>("#filter-close")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...panel.querySelectorAll<HTMLElement>(
          "button, input, select, summary, a[href], [tabindex='0']",
        ),
      ].filter((element) => !element.matches(":disabled") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      background.forEach((element, index) => {
        element.inert = previous[index] ?? false;
      });
      if (trigger?.isConnected && trigger.getClientRects().length)
        trigger.focus({ preventScroll: true });
    };
  }, [ref, open, mobile, onClose]);
}
