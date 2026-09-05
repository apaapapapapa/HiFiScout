import type { CategoryEvidenceInput, NormalizedCatalogProduct } from "../catalog/types.js";
import { getCrawlFetchDetailPage } from "../db/crawl-fetch-detail-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import type { DetailCategoryEvidenceCapability } from "./types.js";

/** Replay a committed positive/negative result. Old in-flight runs may still carry HTML. */
export async function readStagedDetailEvidence(
  db: QueryableDatabase,
  runId: string,
  product: NormalizedCatalogProduct,
  extract: DetailCategoryEvidenceCapability["extract"],
): Promise<CategoryEvidenceInput[] | null> {
  const staged = await getCrawlFetchDetailPage(db, runId, product.sourceUrl);
  if (!staged) return null;
  if (staged.error_message) throw new Error(staged.error_message);
  if (staged.category_evidence !== undefined) return staged.category_evidence;
  if (staged.html_text !== null) return extract(staged.html_text, product);
  throw new Error(`staged category detail result is unavailable: ${product.sourceUrl}`);
}
