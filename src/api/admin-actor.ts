/**
 * The vocabulary for "who performed this administrative change".
 *
 * A leaf module on purpose: the repositories that write audit rows and the admin code that derives
 * an identity from a verified token both need these definitions, and neither should have to import
 * the other to get them.
 *
 * This is an audit vocabulary, not an authorization one. Nothing here decides what a subject may
 * do; Cloudflare Access remains the only gate, and storing an actor neither widens nor narrows it.
 */

/** Written where the acting subject could not be established. Never guessed at, never backfilled. */
export const UNKNOWN_ADMIN_ACTOR = "";

/** Longest actor string any audit column accepts; the derived forms are far shorter. */
export const MAX_ACTOR_LENGTH = 200;

/**
 * A control character in an identifier would corrupt a log line or a stored value.
 *
 * Written as a scan rather than a character-class regex: a regex that matches control characters is
 * exactly what `no-control-regex` exists to flag, and the intent reads more plainly this way.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The shape a stored actor may take: the two forms this system produces, and nothing else. */
const STORED_ACTOR = /^access:(?:user|service):[^\s/]+\/\S+$/u;

export type AdminPrincipalKind = "user" | "service" | "unknown";

/**
 * The subject for a login Access authorized but whose claims name nobody this system can record.
 *
 * Authorization is unchanged — Access already allowed the request, and refusing it here would turn
 * an audit gap into a lockout. The change is simply recorded with no subject, which is the honest
 * outcome and the one the history UI already knows how to show.
 */
export const UNIDENTIFIED_PRINCIPAL: AdminPrincipal = {
  kind: "unknown",
  actor: UNKNOWN_ADMIN_ACTOR,
  email: null,
};

export interface AdminPrincipal {
  readonly kind: AdminPrincipalKind;
  /**
   * Stable, storable identity, derived only from verified claims.
   *
   * `access:user:<issuer host>/<sub>` for a person, `access:service:<issuer host>/<client id>` for a
   * service token. The issuer is part of it because `sub` is unique only within one Access account.
   */
  readonly actor: string;
  /**
   * Display name for the console. Kept out of `actor` on purpose: an address can be reassigned or
   * changed, so it is not an identity, and audit rows should not accumulate a second copy of it.
   */
  readonly email: string | null;
}

/** True for a value with no control characters and a usable length. */
export function usableIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return Boolean(trimmed) && trimmed.length <= MAX_ACTOR_LENGTH && !hasControlCharacter(trimmed);
}

/**
 * Narrows a value that crossed a process boundary back to a storable actor.
 *
 * Only an authenticated admin entry point supplies this, and an older deployment of the admin Worker
 * supplies nothing at all. Anything unrecognized — including a value a request body or an arbitrary
 * header tried to provide — becomes the unknown actor rather than being stored as an identity.
 */
export function trustedActor(value: unknown): string {
  if (!usableIdentifier(value)) return UNKNOWN_ADMIN_ACTOR;
  const trimmed = value.trim();
  return STORED_ACTOR.test(trimmed) ? trimmed : UNKNOWN_ADMIN_ACTOR;
}
