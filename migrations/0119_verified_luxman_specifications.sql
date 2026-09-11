-- Manufacturer-published specifications reviewed 2026-09-11. Exact, verified catalog rows only.
-- Never replace an existing admin decision. Port counts are stereo systems, not physical sockets.
-- Existing numeric/port projections are maintained by their established insert trigger.

INSERT INTO catalog_product_specifications(catalog_product_id,specification_json,updated_at)
SELECT kp.id, '{"widthMm":440,"heightMm":132,"depthMm":410,"weightKg":17,"inputs":[{"connector":"USB","count":1},{"connector":"同軸デジタル","count":1},{"connector":"光デジタル","count":1},{"connector":"トリガー","count":1},{"connector":"コントロール","count":1}],"outputs":[{"connector":"RCA ライン","count":1},{"connector":"XLR バランス","count":1},{"connector":"同軸デジタル","count":1},{"connector":"光デジタル","count":1},{"connector":"コントロール","count":1}],"main":[{"name":"USB最大PCM","value":"768 kHz / 32 bit"},{"name":"USB最大DSD","value":"22.4 MHz"}],"sourceUrl":"https://www.luxman.co.jp/product/d-07x"}', '2026-09-11T00:00:00.000Z'
FROM knowledge_catalog_products kp
WHERE kp.manufacturer_id = 'luxman' AND kp.normalized_model = 'D-07X'
  AND kp.canonical_model = 'D-07X' AND kp.verification_status = 'verified'
  AND NOT EXISTS (SELECT 1 FROM catalog_product_specifications s WHERE s.catalog_product_id = kp.id);

INSERT INTO catalog_product_specifications(catalog_product_id,specification_json,updated_at)
SELECT kp.id, '{"widthMm":440,"heightMm":154,"depthMm":418,"weightKg":22.4,"inputs":[{"connector":"USB","count":1},{"connector":"同軸デジタル","count":1},{"connector":"光デジタル","count":2}],"outputs":[{"connector":"RCA ライン","count":1},{"connector":"XLR バランス","count":1},{"connector":"同軸デジタル","count":1},{"connector":"光デジタル","count":1}],"main":[{"name":"USB最大PCM","value":"768 kHz / 32 bit"},{"name":"USB最大DSD","value":"22.4 MHz"}],"sourceUrl":"https://www.luxman.co.jp/product/d-10x"}', '2026-09-11T00:00:00.000Z'
FROM knowledge_catalog_products kp
WHERE kp.manufacturer_id = 'luxman' AND kp.normalized_model = 'D-10X'
  AND kp.canonical_model = 'D-10X' AND kp.verification_status = 'verified'
  AND NOT EXISTS (SELECT 1 FROM catalog_product_specifications s WHERE s.catalog_product_id = kp.id);
