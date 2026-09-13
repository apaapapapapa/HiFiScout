import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  isProductPermalinkRoute as serverIsRoute,
  productKeyFromPermalinkPath as serverKeyFromPath,
  productPermalinkPath as serverPathForKey,
} from "../src/api/product-permalink.js";
import {
  isProductPermalinkRoute as browserIsRoute,
  productKeyFromPermalinkPath as browserKeyFromPath,
  productPermalinkPath as browserPathForKey,
} from "../frontend/product-permalink.js";

/**
 * The permalink grammar exists twice on purpose, and that is exactly why it needs pinning.
 *
 * `frontend/` may import only the allowlisted HTTP contracts from `src/`, so the browser cannot
 * share the server's implementation and keeps its own mirror of the same rules. Each side already
 * has tests; nothing until now asserted that the two agree. A disagreement would not fail either
 * suite, and would show up in production as the server rendering a permalink document the client
 * then refuses to route (or the reverse) — a blank page rather than an error.
 *
 * These cases are shared rather than per-implementation for the same reason: a case added to prove
 * one side's behaviour has to be answered by both.
 */

/** Paths spanning the namespace boundary, the key grammar, and the ways a path can be malformed. */
const PATHS = [
  "/p",
  "/p/",
  "/p/c-1",
  "/p/l-1",
  "/p/c-999999999999999",
  "/p/c-1000000000000000",
  "/p/c-0",
  "/p/c--1",
  "/p/c-1.5",
  "/p/c-01",
  "/p/c-1e3",
  "/p/c-1/",
  "/p/c-1/extra",
  "/p/c-1?q=1",
  "/p/c-1#hash",
  "/p/x-1",
  "/p/C-1",
  "/p/c-1%20",
  "/p/ c-1",
  "/p/c-١",
  "/p/c-+1",
  "/pp/c-1",
  "/product/c-1",
  "/",
  "",
  "/p/c-1/l-2",
] as const;

/** Keys a caller might hand the builder, valid and not. */
const KEYS = [
  "c-1",
  "l-1",
  "c-999999999999999",
  "c-1000000000000000",
  "c-0",
  "c--1",
  "c-1.5",
  "c-01",
  "x-1",
  "C-1",
  "c-1/l-2",
  "c- 1",
  "",
  "p/c-1",
] as const;

test("both permalink implementations agree on which paths belong to the route", () => {
  for (const pathname of PATHS) {
    assert.equal(
      browserIsRoute(pathname),
      serverIsRoute(pathname),
      `isProductPermalinkRoute disagreed on ${JSON.stringify(pathname)}`,
    );
  }
});

test("both permalink implementations extract the same key, or reject the same path", () => {
  for (const pathname of PATHS) {
    assert.equal(
      browserKeyFromPath(pathname),
      serverKeyFromPath(pathname),
      `productKeyFromPermalinkPath disagreed on ${JSON.stringify(pathname)}`,
    );
  }
});

test("both permalink implementations build the same URL, or refuse the same key", () => {
  for (const key of KEYS) {
    assert.equal(
      browserPathForKey(key),
      serverPathForKey(key),
      `productPermalinkPath disagreed on ${JSON.stringify(key)}`,
    );
  }
});

test("a built permalink round-trips back to its key on both sides", () => {
  // Guards the pair jointly: a grammar change that narrowed the builder and the parser together
  // would keep the three checks above green while breaking every existing bookmark.
  for (const key of ["c-1", "l-1", "c-999999999999999"]) {
    const built = serverPathForKey(key);
    assert.equal(built, `/p/${key}`);
    assert.equal(serverKeyFromPath(built!), key);
    assert.equal(browserKeyFromPath(built!), key);
  }
});
