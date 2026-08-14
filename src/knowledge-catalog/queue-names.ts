/**
 * Queue names, kept in a leaf module.
 *
 * The Worker's queue router matches on these to identify a batch, and importing them must not drag
 * in the consumer, the verifier, or the repositories that the handler itself needs.
 */

export const KNOWLEDGE_CATALOG_VERIFICATION_QUEUE = "hifiscout-knowledge-verification";

/** Messages Cloudflare gives up redelivering land here so the run can still be closed out. */
export const KNOWLEDGE_CATALOG_VERIFICATION_DLQ = "hifiscout-knowledge-verification-dlq";
