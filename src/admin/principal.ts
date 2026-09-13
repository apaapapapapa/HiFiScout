/**
 * Derives the authenticated subject behind an administrative request.
 *
 * Cloudflare Access verifies the login; this module turns the *signature-verified* claims of one
 * request into the {@link AdminPrincipal} the rest of the admin code carries. The storable
 * vocabulary itself lives in `src/api/admin-actor.ts` so the repositories that write audit rows do
 * not have to reach into the admin entry points to get it.
 *
 * This is identity for the audit trail, not an authorization decision: recording who performed a
 * change neither grants nor withholds anything, and Access's own policy remains the only gate.
 */

import { MAX_ACTOR_LENGTH, usableIdentifier, type AdminPrincipal } from "../api/admin-actor.js";
import type { CloudflareAccessClaims } from "./access.js";

export type { AdminPrincipal, AdminPrincipalKind } from "../api/admin-actor.js";
export { UNKNOWN_ADMIN_ACTOR, trustedActor } from "../api/admin-actor.js";

function claimString(value: unknown): string | null {
  return usableIdentifier(value) ? value.trim() : null;
}

function issuerHost(issuer: string): string | null {
  try {
    const url = new URL(issuer);
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * Derives the principal from verified Access claims.
 *
 * Every claim is re-validated here for type and shape. `validClaims` in `access.ts` proves the token
 * was signed for this application; it does not prove that `sub` or `email` are strings of a sensible
 * form, and an identity that reaches storage has to be both.
 *
 * A service token carries an empty `sub` and a `common_name` holding its client ID. That is how a
 * machine caller is told apart from a person, rather than being recorded as one.
 */
export function adminPrincipalFromClaims(claims: CloudflareAccessClaims): AdminPrincipal | null {
  const host = issuerHost(claims.iss);
  if (!host) return null;

  const subject = claimString(claims.sub);
  if (subject) {
    return {
      kind: "user",
      actor: `access:user:${host}/${subject}`.slice(0, MAX_ACTOR_LENGTH),
      email: claimString(claims.email),
    };
  }

  const commonName = claimString(claims.common_name);
  if (commonName) {
    return {
      kind: "service",
      actor: `access:service:${host}/${commonName}`.slice(0, MAX_ACTOR_LENGTH),
      email: null,
    };
  }
  return null;
}
