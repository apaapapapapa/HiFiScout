import type { DatabaseSync } from "node:sqlite";

/**
 * Seeds a fully classified seller listing, so a test can say what is *different* about it.
 *
 * Several suites need a listing that has already been through the whole pipeline — manufacturer and
 * model resolved, categories assigned, an active in-stock offer — because that is the only state
 * from which projection, grouping, remediation and taxonomy behaviour is observable at all. Spelling
 * that out inline costs ~30 columns of identical boilerplate per file, and it buries the one or two
 * values the test actually cares about.
 *
 * The insert is built from the merged column map rather than a fixed list, so a caller may both
 * override a default and add a column the default set does not carry (`metadata_json`,
 * `direct_category_ids`, a resolver version). Nothing here is a schema definition: the migrated
 * schema remains the authority, and an unknown column fails loudly at insert time.
 */

/** A column value as SQLite stores it; expressions belong in the caller's own SQL, not here. */
export type ListingValue = string | number | null;

export type ListingOverrides = Readonly<Record<string, ListingValue>> & {
  /**
   * Fills the four listing timestamps at once. Each remains individually overridable, which is what
   * a test needs when it is specifically about one of them drifting from the others.
   */
  readonly at?: string;
};

const DEFAULT_AT = "2026-08-23T00:00:00.000Z";

/**
 * One classified, in-stock listing, in exactly the columns every hand-written fixture already set.
 *
 * The default set is deliberately the *intersection* of the shapes this replaced, not the union. A
 * fixture that writes a column the original insert left alone can change what a query matches while
 * the test still passes, which is the failure mode a refactor like this must not introduce. Columns
 * outside this core — the resolution method/confidence pair, `last_activity_at`, `metadata_json`,
 * `direct_category_ids`, a resolver version — stay the caller's to pass, and reading them at the
 * call site is the point: they are the part that differs.
 *
 * The values are deliberately unremarkable: a test that asserts on any of them should pass it
 * explicitly, so the assertion and the fixture cannot silently drift apart.
 */
function classifiedListing(at: string): Record<string, ListingValue> {
  return {
    shop_key: "audiounion",
    source_id: "listing-1",
    manufacturer: "Example Audio",
    raw_manufacturer: "Example Audio",
    manufacturer_id: "example-audio",
    canonical_manufacturer_id: "example-audio",
    model: "MODEL-1",
    raw_model: "MODEL-1",
    normalized_model: "MODEL1",
    title: "Example Audio MODEL-1",
    category: "DAC",
    raw_category: "DAC",
    primary_category_id: "dac",
    category_ids: '["dac"]',
    classification_status: "classified",
    condition_text: "中古",
    price_yen: 100000,
    stock_status: "in_stock",
    source_url: "https://example.test/listing-1",
    first_seen_at: at,
    last_seen_at: at,
    last_changed_at: at,
    is_active: 1,
  };
}

/** The merged column map, for a caller that needs the values without writing a row. */
export function listingColumns(overrides: ListingOverrides = {}): Record<string, ListingValue> {
  const { at = DEFAULT_AT, ...rest } = overrides;
  return { ...classifiedListing(at), ...rest };
}

/**
 * Inserts the listing and returns its row id.
 *
 * The id comes from the insert itself rather than a lookup by `source_id`, so a fixture that seeds
 * several listings with the same source id in different shops still gets the right one back.
 */
export function insertListing(sqlite: DatabaseSync, overrides: ListingOverrides = {}): number {
  const columns = listingColumns(overrides);
  const names = Object.keys(columns);
  const statement = sqlite.prepare(
    `INSERT INTO products(${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  );
  return Number(statement.run(...names.map((name) => columns[name])).lastInsertRowid);
}
