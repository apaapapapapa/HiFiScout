-- Collapse the two DB shapes an unclassified listing could have.
--
-- Every persisted product row carries exactly one category leaf: the crawl path recomputes
-- `category_ids` as `[primary_category_id]` in `catalogFields()`
-- (`src/db/product-write-repository.ts`), and `test/unclassified-persistence.test.ts` pins that.
-- The data-quality replay in `src/db/data-quality-remediation-service.ts` bypassed that derivation
-- and persisted the classifier's in-memory empty array instead, so an unclassified row read
-- `["other"]` or `[]` depending on which writer touched it last. The writer is fixed in the same
-- change; this repairs the rows the old writer left behind.
--
-- Derived-only: no seller fact moves, and `category_ids` is not part of the product search read
-- model, so no projection refresh is required.
UPDATE products
SET category_ids = json_array(primary_category_id)
WHERE classification_status = 'unclassified'
  AND (category_ids IS NULL OR category_ids = '' OR category_ids = '[]');
