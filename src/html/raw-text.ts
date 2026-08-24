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
 * Unicode spaces, which is how `</script >` written inside a script body once passed for an
 * end tag.
 */
function isAsciiWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** Whitespace, `/` and `>` are the only things that may follow a tag name. */
function isTagNameDelimiter(char: string | undefined): boolean {
  return char === ">" || char === "/" || isAsciiWhitespace(char);
}

/** A tag name starts with an ASCII letter. Anything else after `<` is text a reader sees. */
function isTagNameStart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
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

/** A span a reader never sees: a raw text element, or the comment one may be hiding in. */
interface HiddenSpan {
  readonly start: number;
  readonly end: number;
  readonly element: RawTextElement | null;
}

/** End of a `<!-- … -->` comment, or the end of the input for one the document never closes. */
function commentEnd(html: string, open: number): number {
  const close = html.indexOf("-->", open + 4);
  return close < 0 ? html.length : close + 3;
}

/**
 * Walks `html` once, reporting what a reader never sees.
 *
 * The walk exists because a `<` is only sometimes a tag. Inside a raw text element it is script or
 * style text — `for (i = 0; i < n; i++)` — and a scanner that reads it as a tag consumes the real
 * end tag along with it. Inside another tag's quoted attribute (`data-example="<script>"`) or
 * inside a comment it is likewise ordinary text, and treating one of those as a start tag would
 * open an element that never closes and swallow the rest of the page.
 */
function hiddenSpans(html: string, tags: readonly RawTextTag[]): HiddenSpan[] {
  const spans: HiddenSpan[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) break;
    const after = html[open + 1];

    if (html.startsWith("<!--", open)) {
      const end = commentEnd(html, open);
      spans.push({ start: open, end, element: null });
      cursor = end;
      continue;
    }

    // Doctypes, processing instructions and bogus comments run to the next `>` and are left alone:
    // the callers' own tag stripping already drops them, and they carry no text worth hiding.
    if (after === "!" || after === "?") {
      const end = tagEnd(html, open + 1);
      if (end < 0) break;
      cursor = end + 1;
      continue;
    }

    const tag = tags.find((candidate) => matchesTagName(html, open + 1, candidate));
    if (!tag) {
      // Another element's start or end tag: step over the whole tag, quoted attributes included.
      if (isTagNameStart(after) || (after === "/" && isTagNameStart(html[open + 2]))) {
        const end = tagEnd(html, open + 1);
        if (end < 0) break;
        cursor = end + 1;
        continue;
      }
      // A `<` that starts nothing — ordinary text such as `1 < 2`.
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

    spans.push({
      start: open,
      end,
      element: {
        tag,
        attributes: html.slice(open + 1 + tag.length, startTagEnd),
        body: html.slice(bodyStart, bodyEnd),
        start: open,
        end,
      },
    });
    cursor = end;
  }

  return spans;
}

/** Every raw text element in document order, ignoring any written inside a comment. */
export function rawTextElements(
  html: string,
  tags: readonly RawTextTag[] = DEFAULT_TAGS,
): RawTextElement[] {
  return hiddenSpans(html, tags)
    .map((span) => span.element)
    .filter((element): element is RawTextElement => element !== null);
}

/**
 * The document with everything a reader never sees replaced by a space.
 *
 * Comments go with the raw text elements. The walk has to recognise them either way, and a
 * commented-out `<script>` holds the same model numbers and prices as a live one — left in place,
 * the callers' `<[^>]*>` stripping would take the comment delimiters and hand the body back as text.
 *
 * Other markup is untouched, so callers can still turn `<br>` and block closings into line breaks.
 */
export function stripRawTextElements(
  html: unknown = "",
  tags: readonly RawTextTag[] = DEFAULT_TAGS,
): string {
  const source = String(html ?? "");
  const spans = hiddenSpans(source, tags);
  if (!spans.length) return source;

  let output = "";
  let cursor = 0;
  for (const span of spans) {
    output += `${source.slice(cursor, span.start)} `;
    cursor = span.end;
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
