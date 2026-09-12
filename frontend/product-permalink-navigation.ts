import { productKeyFromPermalinkPath, productPermalinkPath } from "./product-permalink.js";
import { captureCatalogPosition } from "./catalog-navigation.js";

const HISTORY_STATE_KEY = "hifiscoutProductPermalink";
let suppressOfferPush = false;
let suppressDialogClose = false;

function stateProductKey(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[HISTORY_STATE_KEY];
  return typeof value === "string" ? value : null;
}

function withCatalogState(pathname: string): string {
  return `${pathname}${location.search}${location.hash}`;
}

function rootCatalogUrl(): string {
  return withCatalogState("/");
}

function permalinkUrl(key: string): string | null {
  const path = productPermalinkPath(key);
  return path ? withCatalogState(path) : null;
}

function offerTriggerFor(key: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-offers]")].find(
      (element) => element.dataset.offers === key,
    ) ?? null
  );
}

function hideServerPermalink(): void {
  const page = document.querySelector<HTMLElement>("#product-permalink-page");
  if (page) page.hidden = true;
}

function closeReactOffersDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#offers-dialog");
  if (!dialog?.open) return;
  suppressDialogClose = true;
  // Native close events are queued. Let React finish clearing the old offers before restoring
  // the latest route, which may already have changed again through Forward or another click.
  dialog.addEventListener(
    "close",
    () => {
      suppressDialogClose = false;
      queueMicrotask(restoreProductFromHistory);
    },
    { once: true },
  );
  dialog.close();
}

export function restoreProductFromHistory(): void {
  if (suppressDialogClose) return;
  const key = productKeyFromPermalinkPath(location.pathname);
  if (!key) {
    hideServerPermalink();
    closeReactOffersDialog();
    return;
  }

  const serverPage = document.querySelector<HTMLElement>("#product-permalink-page");
  if (serverPage?.dataset.productKey === key && stateProductKey(history.state) !== key) {
    serverPage.hidden = false;
    closeReactOffersDialog();
    return;
  }

  const trigger = offerTriggerFor(key);
  if (!trigger) return;
  const dialog = document.querySelector<HTMLDialogElement>("#offers-dialog");
  if (dialog?.open && dialog.dataset.productKey === key) return;
  hideServerPermalink();
  suppressOfferPush = true;
  trigger.click();
  suppressOfferPush = false;
}

function leaveProductRoute(): void {
  const key = productKeyFromPermalinkPath(location.pathname);
  if (!key) return;
  if (stateProductKey(history.state) === key) {
    history.back();
    return;
  }
  history.replaceState(history.state, "", rootCatalogUrl());
  hideServerPermalink();
}

function install(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>("[data-offers]") : null;
      const key = target?.dataset.offers;
      if (key && !suppressOfferPush) {
        const nextUrl = permalinkUrl(key);
        if (nextUrl && productKeyFromPermalinkPath(location.pathname) !== key) {
          captureCatalogPosition(key);
          const current = history.state && typeof history.state === "object" ? history.state : {};
          history.pushState({ ...current, [HISTORY_STATE_KEY]: key }, "", nextUrl);
          hideServerPermalink();
        }
      }

      if (key && suppressDialogClose) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const close =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-permalink-close]")
          : null;
      if (close) leaveProductRoute();
    },
    true,
  );

  document.addEventListener(
    "close",
    (event) => {
      if (suppressDialogClose) return;
      if (!(event.target instanceof HTMLDialogElement) || event.target.id !== "offers-dialog")
        return;
      leaveProductRoute();
    },
    true,
  );

  window.addEventListener("popstate", restoreProductFromHistory);
}

install();
