import { useRef, useState } from "react";
import { MULTI_SELECT_LIMITS } from "../src/api/contracts.js";
import { selectionValues } from "./filters.js";
import type { SelectionId } from "./filters.js";

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  aliases?: readonly string[];
}

export function FilterMultiSelect({
  id,
  label,
  options,
  selected,
  onChange,
}: {
  id: SelectionId;
  label: string;
  options: readonly FilterOption[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
  const matching = options.filter((option) =>
    [option.label, option.value, ...(option.aliases ?? [])].some((value) =>
      normalize(value).includes(normalize(search)),
    ),
  );
  const visible = matching.slice(0, 50);
  const labels = new Map(options.map((option) => [option.value, option.label]));
  const maximum = MULTI_SELECT_LIMITS[id].maxItems;
  const remove = (value: string) => onChange(selected.filter((item) => item !== value));
  return (
    <fieldset className="multi-filter" aria-describedby={`${id}-help`}>
      <legend>{label}</legend>
      <details
        id={id}
        ref={detailsRef}
        onKeyDown={(event) => {
          if (event.key === "Escape" && detailsRef.current?.open) {
            event.preventDefault();
            event.stopPropagation();
            detailsRef.current.open = false;
            detailsRef.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary>{selected.length ? `${selected.length}件を選択中` : `${label}を選択`}</summary>
        <div className="multi-options">
          <input
            id={`${id}-search`}
            type="search"
            autoComplete="off"
            aria-label={`${label}の候補を検索`}
            placeholder={`${label}名で候補を検索`}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          <div className="multi-option-list">
            {visible.map((option) => (
              <label className="check" key={option.value}>
                <input
                  type="checkbox"
                  value={option.value}
                  aria-label={option.label}
                  checked={selected.includes(option.value)}
                  disabled={!selected.includes(option.value) && selected.length >= maximum}
                  onChange={(event) =>
                    event.currentTarget.checked
                      ? onChange(selectionValues([...selected, option.value]))
                      : remove(option.value)
                  }
                />
                <span>
                  {option.label}
                  {option.count == null ? "" : ` (${option.count})`}
                </span>
              </label>
            ))}
          </div>
          {matching.length === 0 ? (
            <p role="status" className="filter-note">
              候補がありません。入力を変えてください。
            </p>
          ) : null}
          {matching.length > visible.length ? (
            <p className="filter-note">
              候補{matching.length}件のうち50件を表示。名前で絞り込めます。
            </p>
          ) : null}
        </div>
      </details>
      {selected.length > 0 ? (
        <div className="multi-selected" aria-label={`選択中の${label}`}>
          {selected.map((value) => (
            <button
              type="button"
              className="filter-chip"
              key={value}
              aria-label={`${label}: ${labels.get(value) ?? value}の選択を解除`}
              onClick={() => remove(value)}
            >
              {labels.get(value) ?? value} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}
      <p id={`${id}-help`} className="filter-note">
        複数選択可・いずれかに一致（最大{maximum}件）
      </p>
    </fieldset>
  );
}
