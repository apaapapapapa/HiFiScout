import type { AdminPrincipal } from "../../src/api/admin-actor.js";

/**
 * The subject a test stands in for when it calls an admin handler directly.
 *
 * Production handlers only ever receive a principal that `authenticateCloudflareAccess` derived from
 * a verified token; a test that bypasses the entry point has to supply one explicitly, which is the
 * point — there is no default that would quietly attribute a change to nobody.
 */
export const TEST_ADMIN_PRINCIPAL: AdminPrincipal = {
  kind: "user",
  actor: "access:user:hifiscout.cloudflareaccess.com/test-subject",
  email: "operator@example.test",
};

/** An Access service token rather than a person; used where the two must be told apart. */
export const TEST_ADMIN_SERVICE_PRINCIPAL: AdminPrincipal = {
  kind: "service",
  actor: "access:service:hifiscout.cloudflareaccess.com/test-client-id",
  email: null,
};

/**
 * An `ADMIN_ASSETS` binding that serves a static document and records what was asked for.
 *
 * Admin entry-point tests care about *which* asset path the router reached — that is how they tell
 * a console route from an API route, and how they catch a route that silently falls through to the
 * SPA shell. The binding itself is the same every time, so only the recorded paths and the body
 * belong at the call site.
 */
export function recordingAdminAssets(
  seenPaths: string[],
  body = "admin asset",
): { fetch(input: Request | URL | string): Promise<Response> } {
  return {
    async fetch(input: Request | URL | string): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input);
      seenPaths.push(new URL(request.url).pathname);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  };
}
