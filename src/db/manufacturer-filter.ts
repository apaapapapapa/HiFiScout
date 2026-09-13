import {
  manufacturerFilterIds,
  manufacturerFilterPresentations,
} from "../catalog/manufacturers.js";

const NORMALIZED_MANUFACTURER_PRESENTATION_SQL =
  "LOWER(REPLACE(REPLACE(TRIM(e.manufacturer), ' ', ''), '　', ''))";

/** Shared by the explicit facet and a known manufacturer prefix in free text. */
export function addManufacturerFilter(
  manufacturers: readonly string[],
  where: string[],
  binds: unknown[],
): void {
  if (manufacturers.length) {
    // A visible canonical facet can race ahead of resolver replay. Keep matching the old ids, and
    // also the seller presentation itself so a Japanese-only alias whose old id was a badge-specific
    // hash (for example `【中古品】ラックスマン`) cannot disappear during that window.
    const manufacturerIds = [...new Set(manufacturers.flatMap(manufacturerFilterIds))];
    const manufacturerPresentations = [
      ...new Set(manufacturers.flatMap(manufacturerFilterPresentations)),
    ].map((presentation) => presentation.toLowerCase().replace(/\s+/gu, ""));
    where.push(`(
      e.manufacturer_id IN (SELECT value FROM json_each(?))
      OR ${NORMALIZED_MANUFACTURER_PRESENTATION_SQL} IN (SELECT value FROM json_each(?))
      OR (
        (
          ${NORMALIZED_MANUFACTURER_PRESENTATION_SQL} LIKE '【%】%'
          OR ${NORMALIZED_MANUFACTURER_PRESENTATION_SQL} LIKE '〖%〗%'
          OR ${NORMALIZED_MANUFACTURER_PRESENTATION_SQL} LIKE '[%]%'
        )
        AND EXISTS (
          SELECT 1 FROM json_each(?) presentation
          WHERE substr(${NORMALIZED_MANUFACTURER_PRESENTATION_SQL}, -length(presentation.value))
            = presentation.value
        )
      )
    )`);
    // The ordinary presentation set is uncorrelated and built once, not expanded per entity.
    // Keep the old suffix rule only for badge-prefixed rows; stale Japanese labels remain visible.
    const presentationsJson = JSON.stringify(manufacturerPresentations);
    binds.push(JSON.stringify(manufacturerIds), presentationsJson, presentationsJson);
  }
}
