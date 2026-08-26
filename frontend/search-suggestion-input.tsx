import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import type { ApiClient } from "./api-client.js";
import { useSearchSuggestions } from "./search-suggestions.js";

interface SearchSuggestionInputProps {
  api: ApiClient;
  value: string;
  onValueChange: (value: string, debounced: boolean) => void;
}

/**
 * Search combobox whose options stay visible even when the request query was normalized.
 *
 * Native datalist implementations apply an additional browser-defined literal filter against the
 * unnormalized input value. That can hide valid server matches such as full-width or separator
 * variants, so the application owns rendering and keyboard selection of the returned candidates.
 */
export function SearchSuggestionInput({ api, value, onValueChange }: SearchSuggestionInputProps) {
  const suggestions = useSearchSuggestions(api, value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listOpen = open && suggestions.length > 0;

  useEffect(() => {
    setActiveIndex(-1);
  }, [suggestions]);

  const choose = (suggestion: string) => {
    setOpen(false);
    setActiveIndex(-1);
    onValueChange(suggestion, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (listOpen) event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!suggestions.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
      return;
    }
    if (event.key === "Enter" && listOpen && activeIndex >= 0) {
      event.preventDefault();
      const selected = suggestions[activeIndex];
      if (selected) choose(selected);
    }
  };

  return (
    <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
      <input
        id="q"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="search-suggestions"
        aria-expanded={listOpen}
        aria-activedescendant={
          listOpen && activeIndex >= 0 ? `search-suggestion-${activeIndex}` : undefined
        }
        placeholder="例: TAD ME1 / LUXMAN / DAC"
        autoComplete="off"
        value={value}
        style={{ width: "100%" }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActiveIndex(-1);
        }}
        onChange={(event) => {
          setOpen(true);
          onValueChange(event.currentTarget.value, true);
        }}
        onKeyDown={onKeyDown}
      />
      <div
        id="search-suggestions"
        role="listbox"
        aria-label="検索候補"
        hidden={!listOpen}
        style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          left: 0,
          right: 0,
          zIndex: 30,
          maxHeight: 320,
          overflowY: "auto",
          border: "1px solid rgba(27, 35, 47, 0.16)",
          borderRadius: 10,
          background: "#fff",
          boxShadow: "0 12px 32px rgba(27, 35, 47, 0.16)",
        }}
      >
        {suggestions.map((suggestion, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={suggestion}
              id={`search-suggestion-${index}`}
              type="button"
              role="option"
              aria-selected={active}
              tabIndex={-1}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 12px",
                border: 0,
                background: active ? "#f2f4f7" : "transparent",
                color: "inherit",
                font: "inherit",
                textAlign: "left",
                cursor: "pointer",
              }}
              onPointerEnter={() => setActiveIndex(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(suggestion)}
            >
              {suggestion}
            </button>
          );
        })}
      </div>
    </div>
  );
}
