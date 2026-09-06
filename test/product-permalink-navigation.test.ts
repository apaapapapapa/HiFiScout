import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "vite-plus/test";
import {
  productKeyFromPermalinkPath,
  productPermalinkPath,
} from "../frontend/product-permalink.js";

const navigationSource = stripTypeScriptTypes(
  readFileSync(new URL("../frontend/product-permalink-navigation.ts", import.meta.url), "utf8"),
).replace(/^import[^;]+;\s*/, "");

type NavigationEvent = {
  target: FakeElement;
  preventDefault: () => void;
  stopPropagation: () => void;
};

class FakeElement {
  readonly dataset: Record<string, string>;

  constructor(dataset: Record<string, string> = {}) {
    this.dataset = dataset;
  }

  closest(selector: string): FakeElement | null {
    return selector === "[data-offers]" && this.dataset.offers ? this : null;
  }
}

function navigationHarness() {
  const closeTasks: (() => void)[] = [];
  const microtasks: (() => void)[] = [];
  const documentListeners = new Map<string, ((event: NavigationEvent) => void)[]>();
  let onPopstate = () => {};
  let offersContent: string | null = null;
  let offerOpens = 0;
  let backCalls = 0;
  let location = new URL("https://example.com/?q=LUXMAN#results");
  let historyState: Record<string, string> = {};

  function emit(type: string, target: FakeElement): boolean {
    let stopped = false;
    const event = {
      target,
      preventDefault: () => {},
      stopPropagation: () => {
        stopped = true;
      },
    };
    for (const listener of documentListeners.get(type) ?? []) listener(event);
    return !stopped;
  }

  class FakeDialog extends FakeElement {
    id = "offers-dialog";
    open = false;
    closeListeners: (() => void)[] = [];

    addEventListener(type: string, listener: () => void, options: { once: boolean }): void {
      assert.equal(type, "close");
      assert.equal(options.once, true);
      this.closeListeners.push(listener);
    }

    close(): void {
      if (!this.open) return;
      this.open = false;
      closeTasks.push(() => {
        emit("close", this);
        // React's onClose clears the previous detail during the same event dispatch.
        offersContent = null;
        for (const listener of this.closeListeners.splice(0)) listener();
      });
    }
  }

  const dialog = new FakeDialog();
  const triggers = ["c-1", "c-2"].map((key) =>
    Object.assign(new FakeElement({ offers: key }), {
      click(this: FakeElement) {
        if (!emit("click", this)) return;
        offersContent = key;
        offerOpens += 1;
        dialog.open = true;
      },
    }),
  );

  function move(path: string): void {
    location = new URL(path, location);
    const key = productKeyFromPermalinkPath(location.pathname);
    historyState = key ? { hifiscoutProductPermalink: key } : {};
    onPopstate();
  }

  runInNewContext(navigationSource, {
    productKeyFromPermalinkPath,
    productPermalinkPath,
    Element: FakeElement,
    HTMLDialogElement: FakeDialog,
    get location() {
      return location;
    },
    history: {
      get state() {
        return historyState;
      },
      pushState(state: Record<string, string>, _title: string, url: string) {
        historyState = state;
        location = new URL(url, location);
      },
      replaceState(state: Record<string, string>, _title: string, url: string) {
        historyState = state;
        location = new URL(url, location);
      },
      back() {
        backCalls += 1;
        move("/?q=LUXMAN#results");
      },
    },
    document: {
      querySelector(selector: string) {
        return selector === "#offers-dialog" ? dialog : null;
      },
      querySelectorAll: () => triggers,
      addEventListener(type: string, listener: (event: NavigationEvent) => void) {
        documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
      },
    },
    window: {
      addEventListener(_type: string, listener: () => void) {
        onPopstate = listener;
      },
    },
    queueMicrotask: (callback: () => void) => microtasks.push(callback),
  });

  return {
    dialog,
    move,
    click: (key: string) => triggers.find((trigger) => trigger.dataset.offers === key)?.click(),
    finishClose() {
      const task = closeTasks.shift();
      assert.ok(task, "a native close event must be queued");
      task();
      while (microtasks.length) microtasks.shift()?.();
    },
    snapshot: () => ({
      path: location.pathname + location.search + location.hash,
      offersContent,
      offerOpens,
      backCalls,
    }),
  };
}

test("Forward before the queued close event restores the latest product after React cleanup", () => {
  const browser = navigationHarness();
  browser.click("c-1");
  browser.move("/?q=LUXMAN#results");
  browser.move("/p/c-1?q=LUXMAN#results");
  browser.finishClose();

  assert.deepEqual(browser.snapshot(), {
    path: "/p/c-1?q=LUXMAN#results",
    offersContent: "c-1",
    offerOpens: 2,
    backCalls: 0,
  });
  assert.equal(browser.dialog.open, true);
});

test("a product click during a pending close restores that product without losing its detail", () => {
  const browser = navigationHarness();
  browser.click("c-1");
  browser.move("/?q=LUXMAN#results");
  browser.click("c-2");
  browser.finishClose();

  assert.deepEqual(browser.snapshot(), {
    path: "/p/c-2?q=LUXMAN#results",
    offersContent: "c-2",
    offerOpens: 2,
    backCalls: 0,
  });
  assert.equal(browser.dialog.open, true);
});

test("an explicit dialog close still returns to the catalog exactly once", () => {
  const browser = navigationHarness();
  browser.click("c-1");
  browser.dialog.close();
  browser.finishClose();

  assert.deepEqual(browser.snapshot(), {
    path: "/?q=LUXMAN#results",
    offersContent: null,
    offerOpens: 1,
    backCalls: 1,
  });
  assert.equal(browser.dialog.open, false);
});
