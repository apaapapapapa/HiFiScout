import { useEffect, useLayoutEffect } from "react";
import type { RefObject } from "react";

/** The responsive sheet has the same modal keyboard behavior as the native detail dialogs. */
export function useFilterSheet(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  mobile: boolean,
  onClose: () => void,
) {
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel || mobile) return;
    let frame = 0;
    const update = () => {
      const height = Math.max(
        0,
        innerHeight - Math.max(24, panel.getBoundingClientRect().top) - 24,
      );
      panel.style.setProperty("--filter-available-height", `${height}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    document
      .querySelectorAll(".hero, .search-shell")
      .forEach((element) => observer.observe(element));
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      panel.style.removeProperty("--filter-available-height");
    };
  }, [ref, mobile]);
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
