import type { AdminQualityCommand } from "../api/admin-listing-contracts.js";
import { SHOP_PLUGINS } from "../crawler/shops/index.js";
import {
  readAdminQualityOverview,
  readAdminQualityReports,
  readAdminQualitySamples,
  readAdminQualityCandidates,
} from "../db/admin-quality-repository.js";
import { getProductCorrectionReport } from "../db/product-correction-report-repository.js";
export async function readAdminQuality(env: Env, command: AdminQualityCommand) {
  switch (command.action) {
    case "overview":
      return readAdminQualityOverview(
        env.DB,
        SHOP_PLUGINS.map((shop) => ({ key: shop.key, name: shop.name })),
      );
    case "reports":
      return readAdminQualityReports(env.DB, command.before);
    case "candidates":
      return readAdminQualityCandidates(env.DB, command.before);
    case "samples":
      return readAdminQualitySamples(env.DB, command.shopKey, command.kind, command.afterId);
    case "report": {
      const report = await getProductCorrectionReport(env.DB, command.id);
      return { items: report ? [report] : [], nextBeforeId: null, hasMore: false };
    }
  }
}
