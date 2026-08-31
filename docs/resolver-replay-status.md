# Resolver replay status

Production resolver replay is an operator-triggered maintenance workflow. Run **Resolver Replay Drain** manually when stale manufacturer, model, category, identity, or projection signals need to be drained. Each dispatch processes one bounded batch through the Cloudflare D1 REST API and stops so the result can be inspected before any continuation.

The workflow publishes the commit status context `data-quality/resolver-replay` on the commit used for that manual run:

- `pending`: the bounded batch completed successfully, but stale signals remain. Inspect the run summary, then manually dispatch **Resolver Replay Drain** again if continuing the repair is appropriate.
- `success`: replay fully converged. If an exhaustive validation is required, manually run **Product Data Audit**; convergence does not dispatch it automatically.
- `failure`: the replay batch itself failed and requires investigation before another manual dispatch.

The status target links to the exact GitHub Actions run that produced the state. Neither deployment nor a `pending` replay status starts another replay batch automatically, and replay convergence does not launch the Product Data Audit automatically.