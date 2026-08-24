-- Presentation colour: the finish a listing names, beside the model instead of inside it.
--
-- Model Resolution has always removed the finish from the model, which is what lets two colours of
-- one product group into a single card. It deleted the text along with it, so the finish the seller
-- wrote never reached the shopper. These columns carry the normalized finish instead: one spelling
-- per finish on the listing, and the distinct set of them on the product a card renders.

ALTER TABLE products ADD COLUMN presentation_color TEXT NOT NULL DEFAULT '';

ALTER TABLE product_search_entities ADD COLUMN presentation_colors TEXT NOT NULL DEFAULT '';

-- No backfill here on purpose. The finish has to be extracted by the rules, not by SQL, and the
-- bumped MODEL_RESOLVER_VERSION already makes every stored row eligible for the model replay that
-- runs them.
