import type { ClassifiableCategoryId } from "./types.js";

export const SALE_SUBJECT_POLICY_VERSION = 1;

export interface SaleSubjectEvidence {
  kind: "accessory" | "bundle" | "unspecified";
  categoryId?: ClassifiableCategoryId;
  ruleId: string;
}

const ACCESSORIES: readonly (readonly [ClassifiableCategoryId, RegExp])[] = [
  ["PWR.SUPPLY", /(?:ac|dc)\s*(?:アダプタ(?:ー)?|adapt(?:er|or))|外部電源/i],
  ["ACC.PART", /リモコン|\bremote(?:\s+control(?:ler)?)?\b|交換部品|replacement\s+parts?/i],
  ["ACC.WEAR", /イヤー(?:パッド|ピース)|ear\s*(?:pads?|tips?)/i],
  ["ACC.STAND", /スタンド|stands?/i],
  ["ACC.CASE", /ダストカバー|ケース|カバー|cases?|covers?/i],
];

/** Strip capabilities, power-source descriptions and included/missing items before sale inference. */
export function saleSubjectText(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(
        /リモコン操作(?:対応|可能)?|リモコン対応|(?:AC|DC)\s*アダプタ(?:ー)?駆動|\bremote[ -]+control(?:led|lable)\b/gi,
        " ",
      )
      // "Remote control compatible CD player" describes equipment; "remote control compatible
      // with CD player" still sells a remote. Retain the latter's explicit compatibility context.
      .replace(/\bremote(?:[ -]+control)?[ -]+compatible\b(?![ -]+with\b)/gi, " ")
      .replace(
        /\b(?:ac|dc)[ -]+adapt(?:er|or)[ -]+powered\b|\bpowered[ -]+by[ -]+(?:an?[ -]+)?(?:ac|dc)[ -]+adapt(?:er|or)\b/gi,
        " ",
      )
      .replace(
        /(?:リモコン|ケーブル|ケース|カバー|ACアダプタ(?:ー)?|DAC|フォノ(?:イコライザー|アンプ)?|ヘッドホンアンプ)\s*(?:は\s*)?(?:非搭載|搭載|内蔵|非付属|付属(?:なし|無し)?|付き?|欠品|なし|無し)/gi,
        " ",
      )
      .replace(
        /\b(?:with(?:out)?|includes?)\s+(?:an?\s+)?(?:remote(?:\s+control)?|cable|case|cover|ac\s+adapt(?:er|or))\b/gi,
        " ",
      )
  );
}

/** The title's sale object is separate from the model it fits and from bundled accessories. */
export function inferSaleSubject(title = "", rawModel = ""): SaleSubjectEvidence {
  const value = saleSubjectText(title);
  for (const [categoryId, pattern] of ACCESSORIES) {
    const match = pattern.exec(value);
    if (!match) continue;
    const left = value.slice(0, match.index);
    const right = value.slice(match.index + match[0].length);
    const compatibility =
      /(?:専用|対応|互換|適合|用)\s*$/u.test(left) ||
      /^\s*(?:for|compatible\s+with)\b/i.test(right);
    // An explicit remote/adapter is a sale object even when the seller omits "for". Generic
    // "stand" / "case" mentions require an explicit relationship to avoid equipment prose.
    if (compatibility || categoryId === "ACC.PART" || categoryId === "PWR.SUPPLY") {
      return { kind: "accessory", categoryId, ruleId: `sale_subject.${categoryId}` };
    }
  }
  const combined = `${rawModel.normalize("NFKC")} ${value}`;
  if (/[A-Z][A-Z0-9.-]*\d[A-Z0-9.-]*\s*[+＆&]\s*[A-Z][A-Z0-9.-]*\d[A-Z0-9.-]*/i.test(combined)) {
    return { kind: "bundle", ruleId: "sale_subject.multiple_models" };
  }
  return { kind: "unspecified", ruleId: "sale_subject.unspecified" };
}

export function isAccessoryCategory(value: string): boolean {
  return /^(?:ACC\.|CAB\.|PWR\.)/.test(value);
}
