/**
 * Browser hardening for the public Worker.
 *
 * This is deliberately not a copy of `src/admin/http.ts`. The admin console is a single-operator,
 * Access-gated application whose every byte is same-origin; this is a public, shareable catalogue.
 * Referrer policy, resource isolation and HSTS are decided for this surface rather than inherited
 * from that one, and the admin console's `Referrer-Policy: no-referrer` and
 * `Cross-Origin-Resource-Policy: same-origin` are deliberately *not* carried over — see below.
 */

/**
 * Enforced (not Report-Only) Content Security Policy for public responses.
 *
 * Every source is `'self'`: the application ships one first-party script bundle, four first-party
 * stylesheets, one first-party image, and talks only to its own `/api/` routes. There is no CDN,
 * no web font host and no analytics endpoint to allow.
 *
 * The one exception is inline `style` **attributes**. React writes them in
 * `frontend/public-app.tsx` and `frontend/search-suggestion-input.tsx`, and CSP Level 3 governs
 * them with `style-src-attr` rather than `style-src`. Confining `'unsafe-inline'` to that directive
 * keeps `style-src-elem 'self'` blocking an injected `<style>` element, which is the vector that
 * matters. `style-src` repeats the permissive form only as the fallback for browsers that do not
 * implement the two specific directives and would otherwise drop the attributes those components
 * need. The alternatives were moving those styles into a stylesheet, or a per-response nonce — and
 * a nonce cannot work for documents served from a shared 30-second edge cache.
 *
 * CSP is defence in depth here, never a substitute for the escaping in `product-permalink.ts` or
 * the URL validation in the DTO boundary.
 */
export const PUBLIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
].join("; ");

/**
 * The header set applied to every public response.
 *
 * `Strict-Transport-Security` carries neither `includeSubDomains` nor `preload`: the deployment is
 * a `workers.dev` hostname, and neither the sibling subdomains of that zone nor a preload-list
 * entry are ours to assert. Adding either would make a claim about hosts this project does not own.
 *
 * `Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy` are deliberately absent. The
 * catalogue is public and meant to be linked to and embedded from elsewhere; the admin console's
 * `same-origin` isolation answers a different question, and porting it here would restrict sharing
 * without removing any threat this surface has.
 */
export const PUBLIC_SECURITY_HEADERS: ReadonlyMap<string, string> = new Map([
  ["content-security-policy", PUBLIC_CONTENT_SECURITY_POLICY],
  ["x-content-type-options", "nosniff"],
  // Framing is refused twice: `frame-ancestors` for browsers that enforce CSP, `X-Frame-Options`
  // for anything older. Nothing in this application is designed to be framed.
  ["x-frame-options", "DENY"],
  // Outbound seller links already carry `rel="noopener noreferrer"`. This keeps the origin — never
  // the search terms in the path or query — on the cross-origin navigations that remain.
  ["referrer-policy", "strict-origin-when-cross-origin"],
  [
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  ],
  ["cross-origin-opener-policy", "same-origin"],
  ["strict-transport-security", "max-age=31536000"],
]);

/**
 * Applies {@link PUBLIC_SECURITY_HEADERS} to a response.
 *
 * The body is passed through as a stream and never read, and status, status text, `Content-Type`
 * and `Cache-Control` are preserved. Applying this at the outermost boundary means an edge-cache
 * hit is covered too, so entries stored before this shipped are served with the current headers
 * rather than needing a purge.
 */
export function withPublicSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of PUBLIC_SECURITY_HEADERS) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
