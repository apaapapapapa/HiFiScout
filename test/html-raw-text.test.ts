import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { jsonLdScriptBodies, rawTextElements, stripRawTextElements } from "../src/html/raw-text.js";

test("an element ends on the end tags a browser accepts", () => {
  for (const closing of ["</script>", "</script >", "</script\t\n data-x>", "</script/>"]) {
    assert.equal(stripRawTextElements(`<script>PRICE 999${closing}<p>X</p>`), " <p>X</p>", closing);
  }
});

test("a tag name that only starts with the element's name is a different element", () => {
  // `\b` matched before the hyphen, so a `</script-x>` in a JavaScript string ended the element
  // early and released the rest of the script — prices included — into the page text.
  assert.equal(
    stripRawTextElements(`<script>var s = "</script-x>"; var price = 999;</script><p>X</p>`),
    " <p>X</p>",
  );
  // `\s` matches NBSP; HTML ends a tag name on ASCII whitespace only.
  assert.equal(
    stripRawTextElements(`<script>var s = "</script >"; var price = 999;</script><p>X</p>`),
    " <p>X</p>",
  );
  // A start tag is read the same way, so a custom element is left in the document.
  assert.equal(stripRawTextElements("<scriptx>keep me</scriptx>"), "<scriptx>keep me</scriptx>");
});

test("markup characters inside a script body are script text, not tags", () => {
  // A scanner that reads `<` here as a tag start consumes the real end tag with it and suppresses
  // the rest of the document.
  assert.equal(
    stripRawTextElements("<script>for (i = 0; i < n; i++) {}</script><p>X</p>"),
    " <p>X</p>",
  );
});

test("a quoted attribute value may contain the character that ends the start tag", () => {
  assert.equal(
    stripRawTextElements(`<script data-x="a>b">var price = 999;</script><p>X</p>`),
    " <p>X</p>",
  );
});

test("a `<` that starts no tag is text, wherever it appears", () => {
  // Quoted attribute values and comments hold text, not markup. Opening an element on one of
  // these swallows the rest of the page, because nothing later closes it.
  assert.equal(
    stripRawTextElements(`<div data-example="<script>">PRICE 999</div>`),
    `<div data-example="<script>">PRICE 999</div>`,
  );
  assert.equal(stripRawTextElements("<!-- <script> --><p>PRICE 999</p>"), " <p>PRICE 999</p>");
  assert.equal(stripRawTextElements("<p>1 < 2 and 3 > 2</p>"), "<p>1 < 2 and 3 > 2</p>");
});

test("a commented-out script is removed with its comment, not handed back as text", () => {
  // Its body names the same models and prices a live one does, and the callers' `<[^>]*>`
  // stripping would take the comment delimiters and leave the body behind.
  assert.equal(
    stripRawTextElements("<!-- <script>var price = 999;</script> --><p>X</p>"),
    " <p>X</p>",
  );
  assert.equal(stripRawTextElements("<!-- unterminated <script>"), " ");
});

test("an element the document never closes runs to the end of the input", () => {
  assert.equal(stripRawTextElements("<p>X</p><script>var price = 999;"), "<p>X</p> ");
});

test("only the requested elements are removed", () => {
  const html = "<script>S</script><style>T</style><noscript>N</noscript><p>X</p>";
  assert.equal(stripRawTextElements(html), "  <noscript>N</noscript><p>X</p>");
  assert.equal(stripRawTextElements(html, ["script", "style", "noscript"]), "   <p>X</p>");
  assert.equal(
    stripRawTextElements(html, ["style"]),
    "<script>S</script> <noscript>N</noscript><p>X</p>",
  );
});

test("input without a raw text element is returned unchanged", () => {
  assert.equal(stripRawTextElements("<p>X</p>"), "<p>X</p>");
  assert.equal(stripRawTextElements(null), "");
  assert.equal(stripRawTextElements(undefined), "");
});

test("elements are reported in document order with their attributes and bodies", () => {
  assert.deepEqual(
    rawTextElements(`<p>X</p><SCRIPT src="a.js">BODY</SCRIPT>`).map((element) => ({
      tag: element.tag,
      attributes: element.attributes,
      body: element.body,
    })),
    [{ tag: "script", attributes: ` src="a.js"`, body: "BODY" }],
  );
});

test("JSON-LD bodies come back unparsed, and only from real ld+json script tags", () => {
  const html = `
    <script type="application/ld+json">{"n":"A"}</script>
    <script type='application/ld+json'>{"n":"B"}</script >
    <script type="application/ld+json" data-hydrate>{"n":"C"}</script data-astro>
    <script type="application/ld+json">{"n":"</script >"}</script>
    <script-x type="application/ld+json">{"n":"E"}</script-x>
    <script type="text/javascript">{"n":"F"}</script>
    <!-- <script type="application/ld+json">{"n":"G"}</script> -->`;

  assert.deepEqual(jsonLdScriptBodies(html), [
    `{"n":"A"}`,
    `{"n":"B"}`,
    `{"n":"C"}`,
    `{"n":"</script >"}`,
  ]);
});
