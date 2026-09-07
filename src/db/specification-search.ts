import type { SpecificationFilterQuery } from "../api/catalog-specification-contracts.js";

const dimensions = [
  ["maxWidthMm", "widthMm", "width"], ["maxHeightMm", "heightMm", "height"],
  ["maxDepthMm", "depthMm", "depth"], ["maxWeightKg", "weightKg", "weight"],
] as const;
const ports = [
  ["minXlrInputs", "input", "XLR"], ["minXlrOutputs", "output", "XLR"],
  ["minRcaInputs", "input", "RCA"], ["minRcaOutputs", "output", "RCA"],
] as const;

/** Indexed current catalog facts; specifications never come from another product's offer. */
export function addSpecificationFilters(filters: SpecificationFilterQuery | undefined, where: string[], binds: unknown[]): void {
  if (!filters) return;
  for (const [id, field, index] of dimensions) {
    const value = filters[id];
    if (value === undefined) continue;
    where.push(`e.catalog_product_id IN (
      SELECT s.catalog_product_id FROM catalog_product_specifications s INDEXED BY idx_catalog_specs_${index}
      JOIN knowledge_catalog_products kp ON kp.id = s.catalog_product_id
      WHERE json_type(s.specification_json, '$.${field}') IN ('integer','real')
        AND json_extract(s.specification_json, '$.${field}') > 0
        AND json_extract(s.specification_json, '$.${field}') <= ? AND kp.verification_status = 'verified'
    )`);
    binds.push(value);
  }
  for (const [id, direction, connector] of ports) {
    const value = filters[id];
    if (value === undefined) continue;
    where.push(`e.catalog_product_id IN (
      SELECT sp.catalog_product_id FROM catalog_specification_ports sp INDEXED BY idx_catalog_spec_ports_filter
      JOIN knowledge_catalog_products kp ON kp.id = sp.catalog_product_id
      WHERE sp.direction = ? AND sp.connector = ? AND sp.port_count >= ? AND kp.verification_status = 'verified'
    )`);
    binds.push(direction, connector, value);
  }
}
