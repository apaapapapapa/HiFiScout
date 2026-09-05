import { cloudflareResourceApi, provisionProductionResources } from "./lib/production-resources.js";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Cloudflare account and API token are required.");
await provisionProductionResources(cloudflareResourceApi(account, token));
