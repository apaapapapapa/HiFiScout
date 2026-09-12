import { inferSaleSubject, saleSubjectText } from "./sale-subject.js";
import type { CategoryEvidenceInput } from "./types.js";

interface ReviewedNoiseAccessory {
  id: string;
  brand: RegExp;
  model: RegExp;
  kind: "grounding" | "plug" | "usb_filter";
  sourceUrl: string;
}

interface ReviewedProductType {
  id: string;
  brand: RegExp;
  model: RegExp;
  categoryId: "CAB.ANALOG" | "PER.EARPHONE";
  sourceUrl: string;
  excludeAccessorySubjects?: boolean;
}

const REVIEWED_PRODUCT_ACCESSORY =
  /ケーブル|コード|ケース|カバー|交換|変換|アダプター?|イヤー(?:ピース|チップ)|ポーチ|\bcables?\b|\bcords?\b|\bcases?\b|\bcovers?\b|\breplacement\b|\badapt(?:e|o)rs?\b|\bear\s*tips?\b|\beartips?\b|\bpouches?\b|\bfor\b|専用|対応/i;

function isReviewedProductAccessory(subject: string): boolean {
  return REVIEWED_PRODUCT_ACCESSORY.test(subject);
}

/** Narrow product-type facts confirmed from manufacturer or specialist-retailer evidence. */
const PRODUCT_TYPES: readonly ReviewedProductType[] = [
  {
    id: "essence_audio_44_mini_mini_cable",
    brand: /\bessence\s+audio\b/i,
    model: /\b4\.4\s*mm\s+to\s+4\.4\s*mm\s+mini-mini\s+cable\b/i,
    categoryId: "CAB.ANALOG",
    sourceUrl: "https://essence-audio.square.site/",
  },
  {
    id: "quill_acoustics_satin",
    brand: /\bquill\s*acoustics\b/i,
    model: /\bsatin\b/i,
    categoryId: "PER.EARPHONE",
    sourceUrl: "https://shop.musicteck.com/products/quill-satin",
    excludeAccessorySubjects: true,
  },
  {
    id: "g4_audio_dracula",
    brand: /\bg4\s+audio\b/i,
    model: /\bdracula\b/i,
    categoryId: "PER.EARPHONE",
    sourceUrl: "https://kaitori.e-earphone.jp/list/160244",
    excludeAccessorySubjects: true,
  },
  {
    id: "mother_audio_me5",
    brand: /\bmother\s+audio\b/i,
    model: /\bme5\b/i,
    categoryId: "PER.EARPHONE",
    sourceUrl: "https://www.motheraudio.com/item.php?name=me5",
    excludeAccessorySubjects: true,
  },
];

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
  if (inferSaleSubject(title).kind !== "unspecified" || isReviewedProductAccessory(subject))
    return undefined;
  return NOISE_ACCESSORIES.find(
    (entry) => entry.brand.test(`${manufacturer} ${subject}`) && entry.model.test(subject),
  );
}

export function reviewedProductTypeEvidence(
  title: string,
  manufacturer = "",
): CategoryEvidenceInput[] {
  const subject = saleSubjectText(title);
  if (inferSaleSubject(title).kind === "unspecified") {
    const productType = PRODUCT_TYPES.find(
      (entry) =>
        entry.brand.test(`${manufacturer} ${subject}`) &&
        entry.model.test(subject) &&
        (!entry.excludeAccessorySubjects || !isReviewedProductAccessory(subject)),
    );
    if (productType) {
      return [
        {
          categoryId: productType.categoryId,
          source: "reviewed_product_type",
          strength: "strong",
          ruleId: `reviewed_product_type.${productType.id}.20260912`,
          value: productType.sourceUrl,
        },
      ];
    }
  }
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
