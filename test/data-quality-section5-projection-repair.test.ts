import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  deleteEmptyEntitiesSql,
  deleteInactiveOffersSql,
  refreshEntityAggregatesSql,
  refreshEntitySearchTermsSql,
} from "../src/db/product-search-entity-sql.js";

function normalizedSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

test("section 5 bulk deactivation migration repairs the search read model with canonical SQL", () => {
  const migration = normalizedSql(
    readFileSync(
      new URL("../migrations/0043_repair_section5_search_projection.sql", import.meta.url),
      "utf8",
    ),
  );

  for (const statement of [
    deleteInactiveOffersSql(),
    refreshEntityAggregatesSql(),
    refreshEntitySearchTermsSql(),
    deleteEmptyEntitiesSql(),
  ]) {
    assert.ok(
      migration.includes(normalizedSql(statement)),
      "0043 must stay aligned with the canonical unscoped product-search maintenance SQL",
    );
  }
});
