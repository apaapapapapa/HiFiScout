import { appendFile } from "node:fs/promises";

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
}

interface ZeroTrustOrganization {
  auth_domain?: string;
}

interface IdentityProvider {
  id?: string;
  name?: string;
  type?: string;
}

interface CloudflareWorker {
  id?: string;
  name?: string;
}

interface AccessDestination {
  type?: string;
  worker_id?: string;
}

interface AccessApplication {
  id?: string;
  name?: string;
  aud?: string;
  destinations?: AccessDestination[];
}

interface AccessPolicy {
  id?: string;
  name?: string;
}

const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const workerName = String(process.env.CATALOG_ADMIN_WORKER || "hifiscout-admin").trim();
const adminDomain = String(
  process.env.CATALOG_ADMIN_DOMAIN || "hifiscout-admin.tokyojp.workers.dev",
).trim();
const appName = "HiFiScout Catalog Admin";
const policyName = "Allow Cloudflare account members";

if (!accountId || !apiToken) throw new Error("Cloudflare account credentials are required");

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const headers = {
  authorization: `Bearer ${apiToken}`,
  "content-type": "application/json",
};

function apiError(body: ApiEnvelope<unknown>, status: number): Error {
  const details = [...(body.errors || []), ...(body.messages || [])]
    .map((item) => `${item.code || "?"}: ${item.message || "unknown error"}`)
    .join("; ");
  return new Error(`Cloudflare API HTTP ${status}${details ? ` — ${details}` : ""}`);
}

function accessNotEnabled(body: ApiEnvelope<unknown>, status: number): boolean {
  return Boolean(
    status === 403 &&
    body.errors?.some(
      (item) =>
        item.code === 9999 &&
        /access(?:\.api\.error\.not_enabled| is not enabled)/iu.test(item.message || ""),
    ),
  );
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestHeaders = new Headers(headers);
  new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: requestHeaders,
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success) throw apiError(body as ApiEnvelope<unknown>, response.status);
  return body.result;
}

async function optionalApi<T>(path: string): Promise<T | null> {
  const response = await fetch(`${apiBase}${path}`, { headers });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (response.status === 404 || accessNotEnabled(body as ApiEnvelope<unknown>, response.status)) {
    return null;
  }
  if (!response.ok || !body.success) {
    const text = JSON.stringify(body.errors || []).toLowerCase();
    if (text.includes("not found") || text.includes("does not exist")) return null;
    throw apiError(body as ApiEnvelope<unknown>, response.status);
  }
  return body.result;
}

async function ensureOrganization(): Promise<ZeroTrustOrganization> {
  const existing = await optionalApi<ZeroTrustOrganization>("/access/organizations");
  if (existing?.auth_domain) return existing;
  const suffix = accountId.slice(0, 12).toLowerCase();
  return api<ZeroTrustOrganization>("/access/organizations", {
    method: "POST",
    body: JSON.stringify({
      name: "HiFiScout",
      auth_domain: `hifiscout-${suffix}.cloudflareaccess.com`,
    }),
  });
}

async function ensureCloudflareIdentityProvider(): Promise<IdentityProvider> {
  const providers = await api<IdentityProvider[]>("/access/identity_providers?per_page=100");
  const existing = providers.find((provider) => provider.type === "cloudflare");
  if (existing?.id) return existing;
  return api<IdentityProvider>("/access/identity_providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Cloudflare",
      type: "cloudflare",
      config: { restrict_to_account_members: true },
    }),
  });
}

async function resolveWorkerId(): Promise<string> {
  const workers = await api<CloudflareWorker[]>(
    "/workers/workers?per_page=100&order_by=name&order=asc",
  );
  const worker = workers.find((candidate) => candidate.name === workerName);
  if (!worker?.id) throw new Error(`Cloudflare Worker not found: ${workerName}`);
  return worker.id;
}

function protectsAdminWorker(application: AccessApplication, workerId: string): boolean {
  return Boolean(
    application.destinations?.some(
      (destination) => destination.type === "worker" && destination.worker_id === workerId,
    ),
  );
}

async function ensureApplication(
  identityProviderId: string,
  workerId: string,
): Promise<AccessApplication> {
  const applications = await api<AccessApplication[]>("/access/apps?per_page=100");
  let application = applications.find((candidate) => candidate.name === appName);
  const body = {
    name: appName,
    type: "self_hosted",
    destinations: [{ type: "worker", worker_id: workerId }],
    session_duration: "24h",
    app_launcher_visible: false,
    allowed_idps: [identityProviderId],
    auto_redirect_to_identity: true,
  };

  if (!application) {
    application = await api<AccessApplication>("/access/apps", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } else if (!protectsAdminWorker(application, workerId)) {
    if (!application.id) throw new Error("Existing Access application has no id");
    application = await api<AccessApplication>(`/access/apps/${application.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  if (!application.id || !application.aud) {
    if (!application.id) throw new Error("Access application has no id");
    application = await api<AccessApplication>(`/access/apps/${application.id}`);
  }
  if (!application.id || !application.aud) throw new Error("Access application has no id or AUD");
  return application;
}

async function ensurePolicy(applicationId: string): Promise<void> {
  const policies = await api<AccessPolicy[]>(`/access/apps/${applicationId}/policies?per_page=100`);
  const existing = policies.find((policy) => policy.name === policyName);
  const body = {
    name: policyName,
    decision: "allow",
    include: [{ cloudflare_account_member: { account_id: accountId } }],
    session_duration: "24h",
  };
  if (existing?.id) {
    await api<AccessPolicy>(`/access/apps/${applicationId}/policies/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  } else {
    await api<AccessPolicy>(`/access/apps/${applicationId}/policies`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

function teamDomain(organization: ZeroTrustOrganization): string {
  const raw = String(organization.auth_domain || "").trim();
  if (!raw) throw new Error("Zero Trust organization has no auth_domain");
  const hostname = raw.includes(".") ? raw : `${raw}.cloudflareaccess.com`;
  return `https://${hostname.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
}

const organization = await ensureOrganization();
const identityProvider = await ensureCloudflareIdentityProvider();
if (!identityProvider.id) throw new Error("Cloudflare identity provider has no id");
const workerId = await resolveWorkerId();
const application = await ensureApplication(identityProvider.id, workerId);
await ensurePolicy(application.id as string);

const accessTeamDomain = teamDomain(organization);
const accessAud = application.aud as string;
console.log(`Cloudflare Access application ready: ${appName}`);
console.log(`Admin domain: https://${adminDomain}`);
console.log(`Admin Worker ID: ${workerId}`);
console.log(`Team domain: ${accessTeamDomain}`);
console.log(`AUD: ${accessAud}`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `access_team_domain=${accessTeamDomain}\naccess_aud=${accessAud}\nadmin_url=https://${adminDomain}\n`,
  );
}
