# Resolver replay status

Production resolver replay runs automatically after a successful Cloudflare deployment and re-dispatches bounded batches until all stale manufacturer, model, category, identity, and projection signals converge.

The workflow publishes the commit status context `data-quality/resolver-replay` on the main commit:

- `pending`: a successful bounded batch completed but stale signals remain; the workflow dispatches the next batch.
- `success`: replay fully converged and the exhaustive Product Data Audit is dispatched.
- `failure`: the replay batch itself failed and requires investigation.

The status target links to the exact GitHub Actions run that produced the state, so production convergence can be audited without relying on transient workflow summaries.
