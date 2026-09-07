import { CATALOG_SHORTCUTS } from "./catalog-shortcuts.js";
import type { CatalogShortcut } from "./catalog-shortcuts.js";

export function CatalogShortcuts({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (shortcut: CatalogShortcut) => void;
}) {
  const button = (shortcut: CatalogShortcut) => (
    <button
      type="button"
      className="button-secondary"
      key={shortcut.id}
      disabled={disabled}
      onClick={() => onSelect(shortcut)}
    >
      {shortcut.label}
    </button>
  );
  return (
    <div className="catalog-shortcuts" role="group" aria-label="定番の機器から探す">
      <span className="shortcut-label">定番の機器</span>
      {CATALOG_SHORTCUTS.slice(0, 3).map(button)}
      <details>
        <summary>ほかの機器</summary>
        <div className="shortcut-options">{CATALOG_SHORTCUTS.slice(3).map(button)}</div>
      </details>
      <p className="shortcut-help">
        {disabled
          ? "お気に入り表示中は仕様を含む条件を選べません。"
          : "機器の条件をまとめて選択。検索語・メーカー・ショップ・予算は引き継ぎます。"}
      </p>
    </div>
  );
}
