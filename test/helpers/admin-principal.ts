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
