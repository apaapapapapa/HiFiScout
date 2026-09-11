import { inferSaleSubject } from "./sale-subject.js";
import type { FacetFact } from "./types.js";

/** Reviewed model properties, independent of listing condition and identity attachment. */
export const VERIFIED_BOOKSHELF_REFERENCES = [
  {
    model: "805 D4 Signature",
    key: "805D4SIGNATURE",
    sourceUrl: "https://www.bowerswilkins.com/en/product/loudspeakers/805-d4-signature/300679.html",
  },
  {
    model: "805 D4",
    key: "805D4",
    sourceUrl: "https://www.bowerswilkins.com/en/product/loudspeakers/805-d4/150241.html",
  },
  {
    model: "805 D3",
    key: "805D3",
    sourceUrl:
      "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_europe_shared/default/dw8b9f6335/archive-manuals/805-d3-info-sheet_0.pdf",
  },
  {
    model: "805 Diamond",
    key: "805DIAMOND",
    sourceUrl:
      "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_europe_shared/default/dwce418a2b/archive-manuals/eng_fp29483_805-diamond_info_sheet.pdf",
  },
  {
    model: "805 S",
    key: "805S",
    sourceUrl:
      "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_europe_shared/default/dwab5e957c/archive-manuals/eng_fp20311_805-s_info_sheet.pdf",
  },
] as const;

export const VERIFIED_MODEL_FACET_SOURCE = "verified_model";
const VERIFIED_AT = "2026-09-11T00:00:00.000Z";

interface ModelFacetEvidence {
  manufacturerId: string;
  model: string;
  title: string;
  primaryCategoryId: string;
}

/** Entire model evidence must match a reviewed model plus explicitly allowed finish/stand tokens.
 * This never rewrites the model, drops revision evidence, or creates an identity attachment. */
export function verifiedModelFacetFacts(input: ModelFacetEvidence): FacetFact[] {
  if (input.manufacturerId !== "bowers-wilkins" || input.primaryCategoryId !== "SPK.LOUDSPEAKER")
    return [];
  if (inferSaleSubject(input.title, input.model).kind === "accessory") return [];
  const value = input.model
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\((?:ペア|PAIR)\)/g, "")
    .replace(/\(805DIAMOND ローズナット\)/g, "")
    .replace(/[\s/・-]/g, "");
  const reference = VERIFIED_BOOKSHELF_REFERENCES.find(({ key }) => {
    if (!value.startsWith(key)) return false;
    const tail = value.slice(key.length);
    // Colour annotations are model presentation only; unknown editions/accessories stay unknown.
    if (/^(?:MR|B|グロスブラック|ローズナット|カリフォルニアバールグロス)?$/.test(tail))
      return true;
    if (key === "805D4SIGNATURE" && tail === "WITHSTAND") return true;
    return key === "805D4" && tail === "+FS805D4";
  });
  return reference
    ? [
        {
          facetId: "form_factor",
          value: "bookshelf",
          source: `${VERIFIED_MODEL_FACET_SOURCE}:${reference.sourceUrl}`,
          confidence: 1,
          verifiedAt: VERIFIED_AT,
        },
      ]
    : [];
}
