import type { AuctionPrice, AuctionSaleSubject, AuctionSaleUnit, AuctionShipping } from "../types.js";

/** Strict money reader for ONE labelled price; multiple prices/tax amounts remain unresolved. */
export function yahooAuctionPrice(value: string): AuctionPrice | null {
  const normalized = value.normalize("NFKC").trim();
  const match = normalized.match(/^(?:[¥￥]\s*)?((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))\s*(?:円)?\s*(?:(?:\((税込|税別|非課税)\))|(税込|税別|非課税))?$/u);
  if (!match) return null;
  const amountYen = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(amountYen) || amountYen > 1_000_000_000_000) return null;
  const taxText = match[2] ?? match[3];
  const tax = taxText === "税込" ? "inclusive" : taxText === "税別" ? "exclusive" : taxText === "非課税" ? "exempt" : "unknown";
  return { amountYen, tax };
}

export function yahooAuctionBidCount(value: string): number | null {
  const normalized = value.normalize("NFKC").trim();
  const match = normalized.match(/^((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))\s*(?:件)?$/u);
  if (!match) return null;
  const count = Number(match[1].replaceAll(",", ""));
  return Number.isSafeInteger(count) && count <= 1_000_000 ? count : null;
}

export function yahooAuctionShipping(value: string): AuctionShipping {
  const normalized = value.normalize("NFKC").trim();
  if (normalized === "無料" || normalized === "送料無料") return "free";
  if (normalized === "着払い") return "collect";
  if (normalized === "別途" || normalized === "送料別") return "separate";
  return "unknown";
}

export function yahooAuctionSaleUnit(value: string): AuctionSaleUnit {
  const normalized = value.normalize("NFKC").trim();
  if (["ペア", "2本1組"].includes(normalized)) return "pair";
  if (["1本", "片側", "1台"].includes(normalized)) return "single";
  return normalized === "セット" ? "set" : "unknown";
}

/** Only explicit sold-subject labels. Titles remain evidence for the existing catalog resolver. */
export function yahooAuctionSaleSubject(value: string): AuctionSaleSubject {
  const subjects: Readonly<Record<string, AuctionSaleSubject>> = {
    "本体": "main_unit", "本体のみ": "main_unit", "アクセサリー": "accessory",
    "部品のみ": "parts", "空箱のみ": "empty_box", "複数製品セット": "bundle",
  };
  return subjects[value.normalize("NFKC").trim()] ?? "unknown";
}
