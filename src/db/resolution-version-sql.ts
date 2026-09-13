/** Products use alias `p`; keep the expression identical to the category replay index. */
export const CATEGORY_VERSION_EXPRESSION =
  "COALESCE(CAST(json_extract(p.metadata_json, '$.categoryClassification.version') AS INTEGER), 0)";
