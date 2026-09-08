-- One-time projection of the retained report history; normal reads never aggregate that history.
-- The quality index orders classification before rowid, so it cannot bound an ID window.
-- This cursor index adds one entry per listing; unchanged crawl values do not rewrite it.
CREATE INDEX idx_products_admin_shop_cursor ON products(shop_key,is_active,id);
CREATE TABLE admin_quality_report_groups (
 target_key TEXT NOT NULL, reason TEXT NOT NULL,
 open_count INTEGER NOT NULL CHECK(open_count>=0),
 report_count INTEGER NOT NULL CHECK(report_count>=0),
 accepted_count INTEGER NOT NULL CHECK(accepted_count>=0),
 recurrence_count INTEGER NOT NULL CHECK(recurrence_count>=0),
 updated_at TEXT NOT NULL, PRIMARY KEY(target_key,reason)
);
CREATE TABLE admin_quality_report_members (
 report_id INTEGER PRIMARY KEY, target_key TEXT NOT NULL, reason TEXT NOT NULL,
 recurrence INTEGER NOT NULL CHECK(recurrence IN (0,1))
);
CREATE INDEX idx_admin_quality_report_priority ON admin_quality_report_groups(recurrence_count DESC,open_count DESC,updated_at DESC,target_key DESC,reason DESC) WHERE open_count>0;
CREATE INDEX idx_admin_quality_report_lookup ON product_correction_reports(
 (CASE WHEN listing_product_id IS NOT NULL THEN 'listing:'||listing_product_id ELSE 'product:'||product_key END), reason,status,created_at DESC,id DESC
);
CREATE INDEX idx_admin_quality_candidate_priority ON knowledge_catalog_candidates(priority_score DESC,updated_at DESC,id DESC) WHERE review_status='pending' AND active_listing_count>0;
WITH history AS (
 SELECT r.id,CASE WHEN r.listing_product_id IS NOT NULL THEN 'listing:'||r.listing_product_id ELSE 'product:'||r.product_key END AS target_key,r.reason,r.created_at,
 MIN(CASE WHEN r.status='accepted' THEN COALESCE(r.resolved_at,r.updated_at) END) OVER(PARTITION BY CASE WHEN r.listing_product_id IS NOT NULL THEN 'listing:'||r.listing_product_id ELSE 'product:'||r.product_key END,r.reason) AS first_accepted_at
 FROM product_correction_reports r
)
INSERT INTO admin_quality_report_members(report_id,target_key,reason,recurrence)
 SELECT id,target_key,reason,CASE WHEN created_at>first_accepted_at THEN 1 ELSE 0 END FROM history;
INSERT INTO admin_quality_report_groups(target_key,reason,open_count,report_count,accepted_count,recurrence_count,updated_at)
 SELECT m.target_key,m.reason,SUM(r.status IN ('open','in_review')),COUNT(*),SUM(r.status='accepted'),SUM(m.recurrence),MAX(r.updated_at)
 FROM admin_quality_report_members m JOIN product_correction_reports r ON r.id=m.report_id GROUP BY m.target_key,m.reason;

CREATE TRIGGER admin_quality_report_insert AFTER INSERT ON product_correction_reports
BEGIN
 INSERT INTO admin_quality_report_members(report_id,target_key,reason,recurrence)
 VALUES(NEW.id,CASE WHEN NEW.listing_product_id IS NOT NULL THEN 'listing:'||NEW.listing_product_id ELSE 'product:'||NEW.product_key END,NEW.reason,CASE WHEN EXISTS(SELECT 1 FROM admin_quality_report_groups WHERE target_key=CASE WHEN NEW.listing_product_id IS NOT NULL THEN 'listing:'||NEW.listing_product_id ELSE 'product:'||NEW.product_key END AND reason=NEW.reason AND accepted_count>0) THEN 1 ELSE 0 END);
 INSERT INTO admin_quality_report_groups(target_key,reason,open_count,report_count,accepted_count,recurrence_count,updated_at)
 VALUES(CASE WHEN NEW.listing_product_id IS NOT NULL THEN 'listing:'||NEW.listing_product_id ELSE 'product:'||NEW.product_key END,NEW.reason,NEW.status IN ('open','in_review'),1,NEW.status='accepted',(SELECT recurrence FROM admin_quality_report_members WHERE report_id=NEW.id),NEW.updated_at)
 ON CONFLICT(target_key,reason) DO UPDATE SET open_count=open_count+excluded.open_count,report_count=report_count+1,accepted_count=accepted_count+excluded.accepted_count,recurrence_count=recurrence_count+excluded.recurrence_count,updated_at=MAX(updated_at,excluded.updated_at);
END;
CREATE TRIGGER admin_quality_report_status AFTER UPDATE OF status ON product_correction_reports WHEN OLD.status IS NOT NEW.status
BEGIN
 UPDATE admin_quality_report_groups SET open_count=open_count+(NEW.status IN ('open','in_review'))-(OLD.status IN ('open','in_review')),accepted_count=accepted_count+(NEW.status='accepted')-(OLD.status='accepted'),updated_at=MAX(updated_at,NEW.updated_at)
 WHERE target_key=(SELECT target_key FROM admin_quality_report_members WHERE report_id=NEW.id) AND reason=NEW.reason;
END;
CREATE TRIGGER admin_quality_report_delete AFTER DELETE ON product_correction_reports
BEGIN
 UPDATE admin_quality_report_groups SET open_count=open_count-(OLD.status IN ('open','in_review')),report_count=report_count-1,accepted_count=accepted_count-(OLD.status='accepted'),recurrence_count=recurrence_count-(SELECT recurrence FROM admin_quality_report_members WHERE report_id=OLD.id)
 WHERE target_key=(SELECT target_key FROM admin_quality_report_members WHERE report_id=OLD.id) AND reason=OLD.reason;
 DELETE FROM admin_quality_report_groups WHERE target_key=(SELECT target_key FROM admin_quality_report_members WHERE report_id=OLD.id) AND reason=OLD.reason AND report_count=0;
 DELETE FROM admin_quality_report_members WHERE report_id=OLD.id;
END;
