-- Current, source-linked catalog specifications are searched without expanding every JSON record.
CREATE INDEX idx_catalog_specs_width ON catalog_product_specifications(
  json_extract(specification_json, '$.widthMm'), catalog_product_id)
  WHERE json_type(specification_json, '$.widthMm') IN ('integer','real');
CREATE INDEX idx_catalog_specs_height ON catalog_product_specifications(
  json_extract(specification_json, '$.heightMm'), catalog_product_id)
  WHERE json_type(specification_json, '$.heightMm') IN ('integer','real');
CREATE INDEX idx_catalog_specs_depth ON catalog_product_specifications(
  json_extract(specification_json, '$.depthMm'), catalog_product_id)
  WHERE json_type(specification_json, '$.depthMm') IN ('integer','real');
CREATE INDEX idx_catalog_specs_weight ON catalog_product_specifications(
  json_extract(specification_json, '$.weightKg'), catalog_product_id)
  WHERE json_type(specification_json, '$.weightKg') IN ('integer','real');

-- Port names use the exact XLR/RCA labels and the existing admin balanced/line labels.
-- Phono and digital RCA labels never contribute to analog line counts.
-- Unknown counts and ambiguous duplicate labels remain NULL; physical connectors are never summed.
CREATE TABLE catalog_specification_ports (
  catalog_product_id INTEGER NOT NULL REFERENCES catalog_product_specifications(catalog_product_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('input','output')),
  connector TEXT NOT NULL CHECK(connector IN ('XLR','RCA')),
  port_count INTEGER CHECK(port_count BETWEEN 1 AND 128),
  PRIMARY KEY(catalog_product_id,direction,connector)
) WITHOUT ROWID;
CREATE INDEX idx_catalog_spec_ports_filter ON catalog_specification_ports(direction,connector,port_count,catalog_product_id);

INSERT INTO catalog_specification_ports(catalog_product_id,direction,connector,port_count)
SELECT catalog_product_id, direction, CASE WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス') THEN 'XLR'
    WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('RCA','RCA ライン') THEN 'RCA' ELSE NULL END AS connector,
  CASE WHEN COUNT(*) = 1
    AND MAX(json_type(port_json, '$.count')) IN ('integer','real')
    AND MAX(json_extract(port_json, '$.count')) BETWEEN 1 AND 128
    AND MAX(json_extract(port_json, '$.count')) = CAST(MAX(json_extract(port_json, '$.count')) AS INTEGER)
  THEN MAX(json_extract(port_json, '$.count')) ELSE NULL END AS port_count
FROM (
SELECT s.catalog_product_id AS catalog_product_id, 'input' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM catalog_product_specifications s CROSS JOIN json_each(CASE WHEN json_type(s.specification_json, '$.inputs') = 'array'
  THEN json_extract(s.specification_json, '$.inputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
UNION ALL
SELECT s.catalog_product_id AS catalog_product_id, 'output' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM catalog_product_specifications s CROSS JOIN json_each(CASE WHEN json_type(s.specification_json, '$.outputs') = 'array'
  THEN json_extract(s.specification_json, '$.outputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
)
WHERE UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス','RCA','RCA ライン')
GROUP BY catalog_product_id, direction, connector;

CREATE TRIGGER catalog_spec_ports_insert AFTER INSERT ON catalog_product_specifications BEGIN
  INSERT INTO catalog_specification_ports(catalog_product_id,direction,connector,port_count)
SELECT catalog_product_id, direction, CASE WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス') THEN 'XLR'
    WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('RCA','RCA ライン') THEN 'RCA' ELSE NULL END AS connector,
  CASE WHEN COUNT(*) = 1
    AND MAX(json_type(port_json, '$.count')) IN ('integer','real')
    AND MAX(json_extract(port_json, '$.count')) BETWEEN 1 AND 128
    AND MAX(json_extract(port_json, '$.count')) = CAST(MAX(json_extract(port_json, '$.count')) AS INTEGER)
  THEN MAX(json_extract(port_json, '$.count')) ELSE NULL END AS port_count
FROM (
SELECT NEW.catalog_product_id AS catalog_product_id, 'input' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM json_each(CASE WHEN json_type(NEW.specification_json, '$.inputs') = 'array'
  THEN json_extract(NEW.specification_json, '$.inputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
UNION ALL
SELECT NEW.catalog_product_id AS catalog_product_id, 'output' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM json_each(CASE WHEN json_type(NEW.specification_json, '$.outputs') = 'array'
  THEN json_extract(NEW.specification_json, '$.outputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
)
WHERE UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス','RCA','RCA ライン')
GROUP BY catalog_product_id, direction, connector;
END;

CREATE TRIGGER catalog_spec_ports_update AFTER UPDATE OF specification_json ON catalog_product_specifications
WHEN OLD.specification_json IS NOT NEW.specification_json BEGIN
  DELETE FROM catalog_specification_ports
  WHERE catalog_product_id = NEW.catalog_product_id AND NOT EXISTS (
    SELECT 1 FROM (SELECT catalog_product_id, direction, CASE WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス') THEN 'XLR'
    WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('RCA','RCA ライン') THEN 'RCA' ELSE NULL END AS connector,
  CASE WHEN COUNT(*) = 1
    AND MAX(json_type(port_json, '$.count')) IN ('integer','real')
    AND MAX(json_extract(port_json, '$.count')) BETWEEN 1 AND 128
    AND MAX(json_extract(port_json, '$.count')) = CAST(MAX(json_extract(port_json, '$.count')) AS INTEGER)
  THEN MAX(json_extract(port_json, '$.count')) ELSE NULL END AS port_count
FROM (
SELECT NEW.catalog_product_id AS catalog_product_id, 'input' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM json_each(CASE WHEN json_type(NEW.specification_json, '$.inputs') = 'array'
  THEN json_extract(NEW.specification_json, '$.inputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
UNION ALL
SELECT NEW.catalog_product_id AS catalog_product_id, 'output' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM json_each(CASE WHEN json_type(NEW.specification_json, '$.outputs') = 'array'
  THEN json_extract(NEW.specification_json, '$.outputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
)
WHERE UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス','RCA','RCA ライン')
GROUP BY catalog_product_id, direction, connector) desired
    WHERE desired.direction = catalog_specification_ports.direction
      AND desired.connector = catalog_specification_ports.connector
  );
  INSERT INTO catalog_specification_ports(catalog_product_id,direction,connector,port_count)
  SELECT * FROM (SELECT catalog_product_id, direction, CASE WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス') THEN 'XLR'
    WHEN UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('RCA','RCA ライン') THEN 'RCA' ELSE NULL END AS connector,
  CASE WHEN COUNT(*) = 1
    AND MAX(json_type(port_json, '$.count')) IN ('integer','real')
    AND MAX(json_extract(port_json, '$.count')) BETWEEN 1 AND 128
    AND MAX(json_extract(port_json, '$.count')) = CAST(MAX(json_extract(port_json, '$.count')) AS INTEGER)
  THEN MAX(json_extract(port_json, '$.count')) ELSE NULL END AS port_count
FROM (
SELECT NEW.catalog_product_id AS catalog_product_id, 'input' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM json_each(CASE WHEN json_type(NEW.specification_json, '$.inputs') = 'array'
  THEN json_extract(NEW.specification_json, '$.inputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
UNION ALL
SELECT NEW.catalog_product_id AS catalog_product_id, 'output' AS direction,
  CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS port_json
FROM json_each(CASE WHEN json_type(NEW.specification_json, '$.outputs') = 'array'
  THEN json_extract(NEW.specification_json, '$.outputs') ELSE '[]' END) j
WHERE CAST(j.key AS INTEGER) BETWEEN 0 AND 15
)
WHERE UPPER(TRIM(json_extract(port_json, '$.connector'))) IN ('XLR','XLR バランス','RCA','RCA ライン')
GROUP BY catalog_product_id, direction, connector) WHERE 1
  ON CONFLICT(catalog_product_id,direction,connector) DO UPDATE SET port_count=excluded.port_count
    WHERE catalog_specification_ports.port_count IS NOT excluded.port_count;
END;
