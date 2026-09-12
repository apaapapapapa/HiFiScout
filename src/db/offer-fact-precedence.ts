/** Shared by detail and filtering. Explicit manual unknown also overrides automatic evidence. */
export const EFFECTIVE_OFFER_FACT_SQL = `(f.source = 'manual' OR (
  NOT EXISTS (SELECT 1 FROM product_offer_facts preferred
    WHERE preferred.product_id = f.product_id AND preferred.fact_id = f.fact_id AND preferred.source = 'manual')
  AND (f.source = 'seller_detail' OR NOT EXISTS (SELECT 1 FROM product_offer_facts preferred
    WHERE preferred.product_id = f.product_id AND preferred.fact_id = f.fact_id AND preferred.source = 'seller_detail'))
))`;
