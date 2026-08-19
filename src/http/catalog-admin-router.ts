import { checkPublicApiRateLimit } from "../api-guard.js";
import {
  listKnowledgeCatalogAdminProducts,
  updateKnowledgeCatalogAdminProduct,
} from "../db/knowledge-catalog-admin-repository.js";
import { handleHttp as handleBaseHttp } from "./router.js";
import {
  parseKnowledgeCatalogAdminListQuery,
  parseKnowledgeCatalogAdminUpdate,
} from "./knowledge-catalog-admin.js";
import { json } from "./response.js";
import type { CrawlerEnv } from "../crawler/types.js";

const CATALOG_ADMIN_COLLECTION_PATH = "/api/admin/knowledge-catalog/products";
const CATALOG_ADMIN_PRODUCT_PATH = /^\/api\/admin\/knowledge-catalog\/products\/(\d{1,15})$/;

function adminAuthorized(request: Request, env: CrawlerEnv): boolean {
  return Boolean(
    env.ADMIN_TOKEN && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`,
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function authorizeCatalogAdmin(request: Request, env: Env): Promise<Response | null> {
  const rate = await checkPublicApiRateLimit(request, env);
  if (!rate.allowed) return json({ error: "rate_limited" }, { status: 429 });
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
  return null;
}

export async function handleHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === CATALOG_ADMIN_COLLECTION_PATH) {
    const denied = await authorizeCatalogAdmin(request, env);
    if (denied) return denied;
    const options = parseKnowledgeCatalogAdminListQuery(url);
    if (!options) return json({ error: "invalid_catalog_query" }, { status: 400 });
    return json(await listKnowledgeCatalogAdminProducts(env.DB, options));
  }

  const productMatch = url.pathname.match(CATALOG_ADMIN_PRODUCT_PATH);
  if (request.method === "PATCH" && productMatch) {
    const denied = await authorizeCatalogAdmin(request, env);
    if (denied) return denied;
    const productId = Number(productMatch[1]);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return json({ error: "invalid_id" }, { status: 400 });
    }
    const body = await readJsonBody(request);
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
    const input = parseKnowledgeCatalogAdminUpdate(body);
    if (!input) return json({ error: "invalid_catalog_update" }, { status: 400 });
    const result = await updateKnowledgeCatalogAdminProduct(env.DB, productId, input);
    return result ? json(result) : json({ error: "not_found" }, { status: 404 });
  }

  return handleBaseHttp(request, env, ctx);
}
