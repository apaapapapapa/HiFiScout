-- Retrieval only: domain policies still determine whether candidates are the same product.
CREATE INDEX idx_catalog_products_retrieval_key
  ON knowledge_catalog_products(manufacturer_id, REPLACE(REPLACE(REPLACE(REPLACE(REPLACE((CASE WHEN SUBSTR(UPPER(normalized_model), -3) IN ('/FB','/FN','-BK','-SP','-WH','(B)','(S)','(W)','(K)')
    THEN SUBSTR(UPPER(normalized_model),1,LENGTH(UPPER(normalized_model))-3)
    WHEN SUBSTR(UPPER(normalized_model), -2) IN ('-K','-W') THEN SUBSTR(UPPER(normalized_model),1,LENGTH(UPPER(normalized_model))-2)
    ELSE UPPER(normalized_model) END),' ',''),'-',''),'/',''),'.',''),'_',''))
  WHERE verification_status = 'verified';

CREATE INDEX idx_catalog_aliases_retrieval_key
  ON knowledge_catalog_aliases(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE((CASE WHEN SUBSTR(UPPER(normalized_alias), -3) IN ('/FB','/FN','-BK','-SP','-WH','(B)','(S)','(W)','(K)')
    THEN SUBSTR(UPPER(normalized_alias),1,LENGTH(UPPER(normalized_alias))-3)
    WHEN SUBSTR(UPPER(normalized_alias), -2) IN ('-K','-W') THEN SUBSTR(UPPER(normalized_alias),1,LENGTH(UPPER(normalized_alias))-2)
    ELSE UPPER(normalized_alias) END),' ',''),'-',''),'/',''),'.',''),'_',''), product_id)
  WHERE alias_type = 'model';
