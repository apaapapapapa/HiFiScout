import { safePhotoUrl } from "../../api/catalog-photo-contracts.js";
import { fetchFollowingValidatedRedirects } from "../../crawler/redirects.js";
import { resolveKnowledgeSourceDefinitions } from "./source-registry.js";
import { readLimitedText, HTML_ACCEPT } from "./http.js";
import { flattenJsonLd, isProductNode, jsonLdValues, parseTagAttributes } from "./html.js";
import type { KnowledgeVerificationEnv } from "./types.js";

/** Suggestions only: a product node or social image can still show another finish or a logo. */
export function extractPhotoCandidates(html: string, sourceUrl: string): string[] {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || candidates.size >= 8) return;
    try {
      const url = safePhotoUrl(new URL(value, sourceUrl).href);
      if (url) candidates.add(url);
    } catch {
      /* Invalid manufacturer metadata is not a candidate. */
    }
  };
  for (const value of jsonLdValues(html)) {
    for (const node of flattenJsonLd(value).filter(isProductNode)) {
      const images = Array.isArray(node.image) ? node.image : [node.image];
      for (const image of images)
        add(typeof image === "object" && image ? (image.url ?? image.contentUrl) : image);
    }
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const key = (attributes.get("property") ?? attributes.get("name") ?? "").toLowerCase();
    if (["og:image", "og:image:secure_url", "twitter:image"].includes(key))
      add(attributes.get("content"));
  }
  return [...candidates];
}

export async function fetchPhotoCandidates(
  manufacturerId: string,
  sourceUrl: string,
  env: KnowledgeVerificationEnv,
  fetchFn: typeof fetch = fetch,
) {
  const source = safePhotoUrl(sourceUrl);
  const definitions = resolveKnowledgeSourceDefinitions(env).get(manufacturerId) ?? [];
  const origins = new Set(
    definitions
      .filter((item) => item.sourceType === "manufacturer_official")
      .flatMap((item) => [item.baseUrl, ...item.catalogUrls])
      .flatMap((value) => {
        const safe = safePhotoUrl(value);
        return safe ? [new URL(safe).origin] : [];
      }),
  );
  if (!source || !origins.has(new URL(source).origin))
    throw new Error("catalog_photo_source_not_official");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let finalUrl = source;
  try {
    const response = await fetchFollowingValidatedRedirects(
      source,
      {
        headers: { accept: HTML_ACCEPT, "user-agent": "HiFiScout/1.0 (catalog photo preview)" },
      },
      {
        fetchFn,
        allowedOrigins: origins,
        signal: controller.signal,
        maxRedirects: 2,
        beforeRequest: (url) => {
          finalUrl = url;
        },
      },
    );
    if (
      !response.ok ||
      !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      throw new Error("catalog_photo_source_unavailable");
    }
    return {
      sourceUrl: finalUrl,
      imageUrls: extractPhotoCandidates(await readLimitedText(response, 512000), finalUrl),
    };
  } finally {
    clearTimeout(timer);
  }
}
