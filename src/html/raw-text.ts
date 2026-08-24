/**
 * Reading HTML raw text elements — `script`, `style`, `noscript` — the way a browser delimits them.
 *
 * Their contents are not page content: script bodies routinely mention model numbers, prices and
 * availability wording, which every text-reading parser here would otherwise treat as seller facts.
 * Finding where such an element ends is the whole problem, and a regular expression keeps getting it
 * subtly wrong — `</script\s*>`, `</script\b[^>]*>` and `<script[\s/][^>]*>` each shipped and each
 * ended the element somewhere a browser does not. This module is the one place that decides.
 */

const RAW_TEXT_TAGS = ["script", "style", "noscript"] as const;

export type RawTextTag = (typeof RAW_TEXT_TAGS)[number];

const DEFAULT_TAGS: readonly RawTextTag[] = ["script", "style"];

/**
 * HTML ends a tag name on ASCII whitespace only. JavaScript's `\s` also matches NBSP and the
 * Unicode spaces, which is how `</script >` written inside a script body once passed for an
 * end tag.
 */
function isAsciiWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** Whitespace, `/` and `>` are the only things that may follow a tag name. */
function isTagNameDelimiter(char: string | undefined): boolean {
  return char === ">" || char === "/" || isAsciiWhitespace(char);
}

/** Index of the `>` closing a tag, skipping quoted attribute values so `data-x="a>b"` survives. */
function tagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

/** True when `html` spells exactly `name` at `index`, followed by something that ends a tag name. */
function matchesTagName(html: string, index: number, name: string): boolean {
  if (html.slice(index, index + name.length).toLowerCase() !== name) return false;
  return isTagNameDelimiter(html[index + name.length]);
}

export interface RawTextElement {
  readonly tag: RawTextTag;
  /** Everything between the tag name and the `>` of the start tag, verbatim. */
  readonly attributes: string;
  /** Text between the start and end tags, verbatim. */
  readonly body: string;
  /** Index of the start tag's `<`. */
  readonly start: number;
  /** Index just past the end tag, or `html.length` for an element the document never closes. */
  readonly end: number;
}

/**
 * Every raw text element in document order.
 *
 * Inside one, only its own end tag matters: a `<` in `for (i = 0; i < n; i++)` is script text, not
 * markup, and a scanner that reads it as a tag swallows the real end tag along with it.
 */
export function rawTextElements(
  html: string,
  tags: readonly RawTextTag[] = DEFAULT_TAGS,
): RawTextElement[] {
  const elements: RawTextElement[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) break;

    const tag = tags.find((candidate) => matchesTagName(html, open + 1, candidate));
    if (!tag) {
      cursor = open + 1;
      continue;
    }

    const startTagEnd = tagEnd(html, open + 1 + tag.length);
    if (startTagEnd < 0) break;

    const bodyStart = startTagEnd + 1;
    let bodyEnd = html.length;
    let end = html.length;
    for (let search = bodyStart; ;) {
      const closing = html.indexOf("</", search);
      if (closing < 0) break;
      if (!matchesTagName(html, closing + 2, tag)) {
        search = closing + 2;
        continue;
      }
      const closingTagEnd = tagEnd(html, closing + 2 + tag.length);
      if (closingTagEnd < 0) break;
      bodyEnd = closing;
      end = closingTagEnd + 1;
      break;
    }

    elements.push({
      tag,
      attributes: html.slice(open + 1 + tag.length, startTagEnd),
      body: html.slice(bodyStart, bodyEnd),
      start: open,
      end,
    });
    cursor = end;
  }

  return elements;
}

/**
 * The document with its raw text elements replaced by a space. Other markup is left alone, so
 * callers can still turn `<br>` and block closings into line breaks afterwards.
 */
export function stripRawTextElements(
  html: unknown = "",
  tags: readonly RawTextTag[] = DEFAULT_TAGS,
): string {
  const source = String(html ?? "");
  const elements = rawTextElements(source, tags);
  if (!elements.length) return source;

  let output = "";
  let cursor = 0;
  for (const element of elements) {
    output += `${source.slice(cursor, element.start)} `;
    cursor = element.end;
  }
  return output + source.slice(cursor);
}

/**
 * `type` written the way HTML writes an attribute, with a quoted value.
 *
 * Unquoted values and parameterised ones (`application/ld+json; charset=utf-8`) are deliberately
 * not accepted: that is the acceptance the crawler and verification have always had, and widening
 * it would change which listings carry structured data rather than where a block ends.
 */
const JSON_LD_TYPE = /(?:^|[ \t\n\r\f])type[ \t\n\r\f]*=[ \t\n\r\f]*(["'])application\/ld\+json\1/i;

/** Bodies of the `application/ld+json` blocks, unparsed — callers decode and `JSON.parse` them. */
export function jsonLdScriptBodies(html: unknown = ""): string[] {
  return rawTextElements(String(html ?? ""), ["script"])
    .filter((element) => JSON_LD_TYPE.test(element.attributes))
    .map((element) => element.body);
}
