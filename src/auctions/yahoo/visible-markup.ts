import { cleanText } from "../../crawler/normalize.js";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const TAG = /^<(\/?)([a-z][a-z0-9-]*)(?=[\t\n\f\r />])([\s\S]*)>$/iu;

/** Attribute values are consumed whole so data-note="hidden" is not a hidden attribute. */
function explicitlyHidden(attributes: string): boolean {
  const pattern =
    /([^\t\n\f\r "'<>/=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/gu;
  for (const match of attributes.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (name === "hidden") return true;
    const value = cleanText(match[2] ?? match[3] ?? match[4] ?? "").toLowerCase();
    if (name === "aria-hidden" && value === "true") return true;
    if (name !== "style") continue;
    // Escaped CSS needs a renderer; conservatively exclude it rather than decode a subset.
    if (value.includes("\\")) return true;
    const css = value.replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, "");
    if (
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/u.test(
        css,
      )
    )
      return true;
  }
  return false;
}

/** The end of one markup tag, never a '>' inside an attribute or an unclosed quote. */
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

/**
 * Remove complete explicitly hidden subtrees BEFORE finding cards/fields. The caller strips
 * comments and raw-text elements first. This is a bounded conservative filter, not a CSS/HTML5
 * renderer: an unterminated hidden subtree or attribute fails the whole candidate layout closed.
 */
export function stripYahooHiddenSubtrees(html: string): string | null {
  const spans: { start: number; end: number }[] = [];
  let hidden: { tag: string; depth: number; start: number } | null = null;
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) break;
    if (!/^<\/?[a-z]/iu.test(html.slice(open, open + 3))) {
      cursor = open + 1;
      continue;
    }
    const end = tagEnd(html, open + 1);
    if (end < 0) return null;
    const token = TAG.exec(html.slice(open, end + 1));
    cursor = end + 1;
    if (!token) continue;
    const closing = token[1] === "/";
    const tag = token[2].toLowerCase();
    if (hidden) {
      if (tag !== hidden.tag) continue;
      hidden.depth += closing ? -1 : 1;
      if (hidden.depth === 0) {
        spans.push({ start: hidden.start, end: cursor });
        hidden = null;
      }
    } else if (!closing && explicitlyHidden(token[3])) {
      if (VOID_TAGS.has(tag)) spans.push({ start: open, end: cursor });
      else hidden = { tag, depth: 1, start: open };
    }
  }
  if (hidden) return null;
  const output: string[] = [];
  let start = 0;
  for (const span of spans) {
    // Keep a structural separator: deleting a hidden dt/dd must not pair neighboring facts.
    output.push(html.slice(start, span.start), "<hifiscout-hidden></hifiscout-hidden>");
    start = span.end;
  }
  output.push(html.slice(start));
  return output.join("");
}
