import {
  SPECIFICATION_FILTER_DEFINITIONS,
  parseSpecificationFilterValue,
} from "../src/api/catalog-specification-contracts.js";
import type {
  SpecificationFilterId,
  SpecificationFilterValues,
} from "../src/api/catalog-specification-contracts.js";

export function specificationErrors(values: SpecificationFilterValues = {}) {
  const errors: SpecificationFilterValues = {};
  for (const definition of SPECIFICATION_FILTER_DEFINITIONS) {
    const raw = values[definition.id];
    if (!raw?.trim() || parseSpecificationFilterValue(definition.id, raw) !== null) continue;
    errors[definition.id] = definition.integer
      ? `1〜${definition.maximum}の整数で入力してください。`
      : `0より大きく${definition.maximum}以下の数値で入力してください（小数3桁まで）。`;
  }
  return errors;
}

export function normalizedSpecifications(
  values: SpecificationFilterValues = {},
): SpecificationFilterValues | null {
  if (Object.keys(specificationErrors(values)).length) return null;
  return Object.fromEntries(
    SPECIFICATION_FILTER_DEFINITIONS.flatMap(({ id }) => {
      const value = values[id]?.trim();
      return value ? [[id, String(parseSpecificationFilterValue(id, value))]] : [];
    }),
  );
}

export function specificationFromFilterId(value: string): SpecificationFilterId | null {
  return SPECIFICATION_FILTER_DEFINITIONS.find(({ id }) => value === `spec:${id}`)?.id ?? null;
}
