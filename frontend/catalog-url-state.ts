/**
 * Bootstrap: rewrites the address bar before `app.ts` reads it.
 *
 * Loaded as its own entry so the correction happens before the catalog script parses the query and
 * issues its first request. The rules live in {@link sanitizedCatalogUrl}, which is why this file
 * has nothing in it but the browser calls.
 */

import { sanitizedCatalogUrl } from "./catalog-url-sanitizer.js";

const nextUrl = sanitizedCatalogUrl(location.pathname, location.search, location.hash);
// `replaceState`, not `pushState`: correcting a bad link must not add a back-button step.
if (nextUrl) history.replaceState(null, "", nextUrl);
