import { WorkerEntrypoint } from "cloudflare:workers";
import { publicSearchResponse } from "./public-search-response.js";

/** Called after the gateway's validation, canonicalization and rate limit. */
export class PublicSearchCache extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return publicSearchResponse(request, this.env);
  }
}
