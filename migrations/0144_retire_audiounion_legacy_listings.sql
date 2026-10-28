-- AudioUnion's October 2026 storefront renewal retired every /ct/detail/used/<id>/ route: those
-- links no longer reach a product page, and the seller publishes no mapping to the new
-- /shop/g/g<code>/ goods. Collection now stores goods:<code> IDs and rechecks select only the new
-- prefix, so these rows can never be observed or rechecked again. End them once instead of keeping
-- dead links active. A retired route is not sale evidence: in-stock rows become unknown and other
-- states are kept. Existing triggers record the projection and public-meta effects of each row.
UPDATE products
SET is_active = 0,
    stock_status = CASE WHEN stock_status = 'in_stock' THEN 'unknown' ELSE stock_status END,
    last_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE shop_key = 'audiounion'
  AND is_active = 1
  AND source_url LIKE 'https://www.audiounion.jp/ct/detail/used/%';
