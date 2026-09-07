import { adminCsvOriginal, type AdminCsvChange } from "../../src/api/admin-csv-contracts.js";
import {
  applyAdminCsvChange,
  previewAdminCsvChange,
} from "../../src/db/admin-csv-import-repository.js";
import type { QueryableDatabase } from "../../src/db/types.js";

const MODEL = "M12 SWITCH IE GOLD + 専用オプションケーブル2.0m ×3本";
const SOURCE_URL = "https://shop.formusic.jp/network-player/31211.html";
const CATEGORY_ID = "SIG.NETWORK";

interface Target {
  id: number;
  model: string;
  raw_model: string;
  canonical_manufacturer_id: string;
  source_url: string;
  primary_category_id: string;
  direct_category_ids: string | null;
  override_category_id: string | null;
}

/**
 * Explicit operator-confirmed listing correction, not a model alias or a crawler heuristic.
 * Reviewed 2026-09-07: the seller page names the hub and its three 2 m cables. The manufacturer
 * confirms the product type at https://telegaertner.co.jp/product/audio_products/m12_switch_ie_gold.html.
 * Keep the bundle's candidate identity and all raw evidence. A retired catalog source must not
 * be reactivated, nor the bundle attached to the catalog's body-only identity, to classify it.
 */
export async function applyConfirmedSwitchBundleCategory(db: QueryableDatabase): Promise<number> {
  const target = await db
    .prepare(`
    SELECT p.id,p.model,p.raw_model,p.canonical_manufacturer_id,p.source_url,
      p.primary_category_id,p.direct_category_ids,o.primary_category_id AS override_category_id
    FROM products p LEFT JOIN product_admin_overrides o ON o.listing_product_id=p.id
    WHERE p.shop_key='formusic' AND p.source_id='31211' AND p.is_active=1
  `)
    .first<Target>();
  if (!target) return 0;
  if (
    target.model !== MODEL ||
    target.raw_model !== MODEL ||
    target.canonical_manufacturer_id !== "telegartner" ||
    target.source_url !== SOURCE_URL
  ) {
    throw new Error("confirmed_switch_bundle_target_changed: re-review the seller listing");
  }
  if (target.override_category_id !== null && target.override_category_id !== CATEGORY_ID) {
    throw new Error(
      "confirmed_switch_bundle_override_conflict: preserve the newer manual decision",
    );
  }
  const direct: unknown = JSON.parse(target.direct_category_ids || "[]");
  if (!Array.isArray(direct) || direct.some((id) => id !== target.primary_category_id)) {
    throw new Error(
      "confirmed_switch_bundle_secondary_categories: do not collapse bundle membership",
    );
  }

  const original = adminCsvOriginal("listing", target.id, {
    manufacturer_id: "telegartner",
    model: MODEL,
    primary_category_id: "SRC.STREAMER",
  });
  const change: AdminCsvChange = {
    line: 1,
    original,
    values: { ...original.values, primary_category_id: CATEGORY_ID },
  };
  // Reuse the existing before-image/revision transaction guard, durable receipt, override write
  // and ordered projection refresh. An interrupted attempt resumes its existing operation ID.
  const preview = await previewAdminCsvChange(db, change);
  if (preview.status === "unchanged" && target.override_category_id === CATEGORY_ID) return 0;
  if (preview.status !== "ready" && preview.status !== "pending") {
    throw new Error(
      `confirmed_switch_bundle_requires_review: ${preview.status}: ${preview.message}`,
    );
  }
  const result = await applyAdminCsvChange(db, {
    change,
    revision: preview.revision || "",
    operationId: preview.operationId || crypto.randomUUID(),
  });
  if (result.status !== "applied") {
    throw new Error(
      `confirmed_switch_bundle_correction_incomplete: ${result.status}: ${result.message}`,
    );
  }
  console.log(
    JSON.stringify({
      event: "confirmed_switch_bundle_category_corrected",
      listingId: target.id,
      categoryId: CATEGORY_ID,
      operationId: result.operationId,
    }),
  );
  return 1;
}
