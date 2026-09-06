import { stripRawTextElements } from "../html/raw-text.js";
import { cleanText } from "./normalize.js";

const ATTRIBUTE_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  class: /(?:^|\s)class\s*=\s*(["'])(.*?)\1/i,
  id: /(?:^|\s)id\s*=\s*(["'])(.*?)\1/i,
  href: /(?:^|\s)href\s*=\s*(["'])(.*?)\1/i,
});

export function listingAttribute(attributes: string, name: string): string {
  const pattern =
    ATTRIBUTE_PATTERNS[name] || new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return attributes.match(pattern)?.[2] || "";
}

function matchesAttribute(attributes: string, name: "class" | "id", value: string): boolean {
  const actual = listingAttribute(attributes, name);
  return name === "class" ? actual.split(/\s+/u).includes(value) : actual === value;
}

function closingElement(
  html: string,
  tag: string,
  bodyStart: number,
): { start: number; end: number } | null {
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = bodyStart;
  let depth = 1;
  for (let token = tags.exec(html); token; token = tags.exec(html)) {
    depth += token[1] ? -1 : 1;
    if (depth === 0) return { start: token.index, end: token.index + token[0].length };
  }
  return null;
}

/** Split repeated seller cards at their explicit starts, including malformed unclosed cards. */
export function listingBlocks(html: string, tag: string, className?: string): string[] {
  const source = stripRawTextElements(html);
  const opening = className
    ? new RegExp(`<${tag}\\b([^>]*\\sclass\\s*=\\s*["'][^"']*["'][^>]*)>`, "gi")
    : new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  const starts = [...source.matchAll(opening)].filter(
    (match) => !className || matchesAttribute(match[1], "class", className),
  );
  return starts.map((match, index) => {
    const block = source.slice(match.index ?? 0, starts[index + 1]?.index ?? source.length);
    const closing = closingElement(block, tag, match[0].length);
    return closing ? block.slice(0, closing.end) : block;
  });
}

/** Read one explicit field, balancing nested tags of the same kind instead of truncating it. */
export function listingFieldHtml(
  html: string,
  value: string,
  name: "class" | "id" = "class",
): string {
  if (!value) return "";
  for (
    let index = html.indexOf(value);
    index >= 0;
    index = html.indexOf(value, index + value.length)
  ) {
    const start = html.lastIndexOf("<", index);
    const end = html.indexOf(">", start);
    if (start < 0 || end < index) continue;
    const match = html.slice(start, end + 1).match(/^<([a-z][a-z0-9-]*)\b([^>]*)>$/iu);
    if (!match) continue;
    if (!matchesAttribute(match[2], name, value)) continue;
    const bodyStart = end + 1;
    const closing = closingElement(html, match[1], bodyStart);
    return closing ? html.slice(bodyStart, closing.start) : "";
  }
  return "";
}

export function listingFieldText(
  html: string,
  value: string,
  name: "class" | "id" = "class",
): string {
  return cleanText(listingFieldHtml(html, value, name));
}
