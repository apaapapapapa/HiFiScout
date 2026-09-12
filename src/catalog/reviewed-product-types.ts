import { inferSaleSubject, saleSubjectText } from "./sale-subject.js";
import type { CategoryEvidenceInput } from "./types.js";

interface ReviewedNoiseAccessory {
  id: string;
  brand: RegExp;
  model: RegExp;
  kind: "grounding" | "plug" | "usb_filter";
  sourceUrl: string;
}

/** Reviewed product types, not verified catalog identities or claims of audible effectiveness. */
const NOISE_ACCESSORIES: readonly ReviewedNoiseAccessory[] = [
  {
    id: "kojo_crystal",
    brand: /\bkojo\b|光城精工|コージョー/i,
    model: /\bcrystal\s+e(?:p(?:r|t3|b|y|ua|xh|xw|l|uc|ha)?)?(?![a-z0-9-])/i,
    kind: "grounding",
    sourceUrl: "https://kojo-seiko.co.jp/products/crystalep.html",
  },
  {
    id: "kojo_force_bar_ep",
    brand: /\bkojo\b|光城精工|コージョー/i,
    model: /\bforce\s*bar\s*ep(?![a-z0-9-])/i,
    kind: "grounding",
    sourceUrl: "https://kojo-seiko.co.jp/products/forcebarep.html",
  },
  {
    id: "akiko_triple_ac",
    brand: /\bakiko\s+audio\b|アキコ\s*オーディオ/i,
    model: /\btriple\s+ac\s+enhancer(?![a-z0-9-])/i,
    kind: "plug",
    sourceUrl:
      "https://www.akikoaudio.com/en/products/product/akiko-audio-triple-ac-enhancer-schuko-plug-gold",
  },
  {
    id: "mijinko_silver_bullet",
    brand: /オーディオ(?:みじんこ|ミジンコ)|\baudio\s*mijinko\b/i,
    model: /\bsilver\s+bullet\s+3\.5(?![a-z0-9.-])/i,
    kind: "grounding",
    sourceUrl: "https://audiomijinko.thebase.in/items/76363670",
  },
  {
    id: "isotek_isoplug",
    brand: /\bisotek\b|アイソテック/i,
    model: /\bevo3\s+isoplug(?![a-z0-9-])/i,
    kind: "plug",
    sourceUrl: "https://isoteksystems.com/us/products/evo3-isoplug-5/",
  },
  {
    id: "cad_ground_control",
    brand: /\bcad\b|computer\s+audio\s+design/i,
    model: /\bgc[13](?![a-z0-9.-])/i,
    kind: "grounding",
    sourceUrl: "https://www.computeraudiodesign.com/gc1-ground-control/",
  },
  {
    id: "telos_macro_g",
    brand: /\btelos\b|テロス/i,
    model: /\bmacro\s+g-usb(?![a-z0-9-])/i,
    kind: "grounding",
    sourceUrl: "https://shop.topwing.jp/products/telos-audio-design-macro-g",
  },
  {
    id: "chord_groundaray",
    brand: /\bchord\s+company\b|コードカンパニー/i,
    model: /\bgroundaray(?![a-z0-9-])/i,
    kind: "plug",
    sourceUrl: "https://chord.co.uk/product/groundaray-advanced-high-frequency-noise-reduction/",
  },
  {
    id: "furutech_clear_line",
    brand: /\bfurutech\b|フルテック/i,
    model: /\bncf\s+clear\s*line(?:-rca|-xlr)?(?![a-z0-9-])/i,
    kind: "plug",
    sourceUrl: "https://furutech.com/product-category/ncf-clear-line-products/",
  },
  {
    id: "silentpower_isilencer_max",
    brand: /\bsilent\s*power\b|サイレントパワー/i,
    model: /\bisilencer\s+max(?![a-z0-9-])/i,
    kind: "usb_filter",
    sourceUrl: "https://www.silentpower.tech/products/isilencer-max",
  },
];

export function reviewedNoiseAccessory(title: string, manufacturer = "") {
  const subject = saleSubjectText(title);
  if (
    inferSaleSubject(title).kind !== "unspecified" ||
    /ケーブル|コード|ケース|カバー|交換|変換|\bcables?\b|\bcords?\b|\bcases?\b|\bcovers?\b|\breplacement\b|\bfor\b|専用|対応/i.test(
      subject,
    )
  )
    return undefined;
  return NOISE_ACCESSORIES.find(
    (entry) => entry.brand.test(`${manufacturer} ${subject}`) && entry.model.test(subject),
  );
}

export function reviewedProductTypeEvidence(
  title: string,
  manufacturer = "",
): CategoryEvidenceInput[] {
  const entry = reviewedNoiseAccessory(title, manufacturer);
  return entry
    ? [
        {
          categoryId: "ACC.GROUND_NOISE",
          source: "reviewed_product_type",
          strength: "strong",
          ruleId: `reviewed_product_type.${entry.id}.20260912`,
          value: entry.sourceUrl,
        },
      ]
    : [];
}
