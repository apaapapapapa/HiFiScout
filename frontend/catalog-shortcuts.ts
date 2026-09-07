import type { FacetSelection } from "../src/api/contracts.js";
import type { ProductFilters } from "./filters.js";

export interface CatalogShortcut {
  id: string;
  label: string;
  category: string;
  facets: readonly FacetSelection[];
}

export const CATALOG_SHORTCUTS: readonly CatalogShortcut[] = [
  {
    id: "bookshelf",
    label: "ブックシェルフ",
    category: "SPK.LOUDSPEAKER",
    facets: [{ facetId: "form_factor", value: "bookshelf" }],
  },
  {
    id: "tube-integrated",
    label: "真空管プリメイン",
    category: "AMP.INTEGRATED",
    facets: [{ facetId: "technology", value: "tube" }],
  },
  {
    id: "mc-cartridge",
    label: "MCカートリッジ",
    category: "ANA.CARTRIDGE",
    facets: [{ facetId: "cartridge_type", value: "mc" }],
  },
  {
    id: "floorstanding",
    label: "フロア型スピーカー",
    category: "SPK.LOUDSPEAKER",
    facets: [{ facetId: "form_factor", value: "floorstanding" }],
  },
  {
    id: "active-speaker",
    label: "アンプ内蔵スピーカー",
    category: "SPK.LOUDSPEAKER",
    facets: [{ facetId: "amplification_mode", value: "active" }],
  },
  {
    id: "open-headphone",
    label: "開放型ヘッドホン",
    category: "PER.HEADPHONE",
    facets: [{ facetId: "acoustic_design", value: "open_back" }],
  },
  { id: "dac", label: "DAC", category: "PRC.DAC", facets: [] },
  { id: "phono", label: "フォノイコライザー", category: "AMP.PHONO", facets: [] },
  { id: "headphone-amp", label: "ヘッドホンアンプ", category: "AMP.HEADPHONE", facets: [] },
  {
    id: "cd-sacd",
    label: "CD・SACD機器",
    category: "SRC.DISC",
    facets: [
      { facetId: "supported_media", value: "cd" },
      { facetId: "supported_media", value: "sacd" },
    ],
  },
  { id: "power-cord", label: "電源ケーブル", category: "PWR.CORD", facets: [] },
  {
    id: "speaker-stand",
    label: "スピーカースタンド",
    category: "ACC.STAND",
    facets: [{ facetId: "target_equipment", value: "speaker" }],
  },
];

/** Replace the equipment criteria together so a previous device's specifications cannot linger. */
export function applyCatalogShortcut(
  filters: ProductFilters,
  shortcut: CatalogShortcut,
): ProductFilters {
  return { ...filters, category: shortcut.category, features: [], facets: [...shortcut.facets] };
}
