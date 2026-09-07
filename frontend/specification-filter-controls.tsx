import { SPECIFICATION_FILTER_DEFINITIONS } from "../src/api/catalog-specification-contracts.js";
import type { SpecificationFilterId, SpecificationFilterValues } from "../src/api/catalog-specification-contracts.js";
import { specificationErrors } from "./specification-filters.js";

export function SpecificationFilterControls({ values = {}, disabled, onChange }: {
  values?: SpecificationFilterValues;
  disabled: boolean;
  onChange: (id: SpecificationFilterId, value: string) => void;
}) {
  const errors = specificationErrors(values);
  return (
    <fieldset className="filter-features specification-filters" disabled={disabled}>
      <legend>寸法・重量・入出力数</legend>
      <p className="filter-note" id="specification-filter-help">
        出典付きの仕様が記録された製品を検索します。未記載の項目は条件に一致しません。
        寸法はmm、重量はkg、端子は左右1組で1系統です。指定なしは空欄。
      </p>
      {SPECIFICATION_FILTER_DEFINITIONS.map(({ id, name, unit, integer }) => (
        <label key={id}>
          <span>{name}（{unit}）</span>
          <input id={`spec-${id}`} inputMode={integer ? "numeric" : "decimal"}
            maxLength={12} placeholder="指定なし" value={values[id] ?? ""}
            aria-invalid={!!errors[id]} aria-describedby={`specification-filter-help spec-error-${id}`}
            onChange={(event) => onChange(id, event.currentTarget.value)} />
          <span id={`spec-error-${id}`} className="field-error" role="status">{errors[id]}</span>
        </label>
      ))}
      <p className="filter-note">XLRはバランス、RCAはラインの系統数です。フォノ・同軸デジタルは含めません。</p>
      {disabled ? <p className="filter-note">お気に入り表示中は詳細仕様で絞り込めません。</p> : null}
    </fieldset>
  );
}
