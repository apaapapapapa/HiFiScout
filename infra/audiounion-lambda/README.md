# Tokyo Lambda relay for Audio Union and Hifido

HiFiScout uses a small AWS Lambda function in the Tokyo region (`ap-northeast-1`) as an allowlisted HTTP relay for **Audio Union** and **ハイファイ堂 (Hifido)**. The Lambda only returns source HTML; parsing, normalization, classification, D1 writes, crawl-state handling, and scheduling remain in the Cloudflare Worker.

The function URL uses `AuthType: NONE` so Cloudflare can call it without AWS credentials. The function itself requires a high-entropy Bearer token and is not a general-purpose proxy. It permits only:

- the configured Audio Union new-arrival entry URL;
- exact numeric Audio Union used-detail URLs under `/ct/detail/used/<id>/`;
- the validated Hifido listing URL shape used by the collector, with only the expected query parameters.

The normal DO path uses signed PREPARE/FETCH permits. PREPARE validates the allowlisted target
against `robots.txt` and returns an eligible time, expiry, and signed permit. The per-shop
`CrawlScheduler` waits through an Alarm; FETCH verifies the permit and proxies the target without
holding Lambda open for the pacing delay. `/ct/search` and unrelated seller paths stay outside the
allowlist. Single-flight ownership is per shop, not a global crawl Queue or global Lambda lock.
The SAM template intentionally leaves Lambda reserved concurrency unset.

> Historical naming note: the infrastructure directory, Lambda function, and some workflow names still contain `audiounion`. They are retained for compatibility even though the relay now also serves Hifido listing requests.

## Deploy to Tokyo

Initial setup needs AWS credentials and AWS SAM/CloudFormation. Use `template.yaml` to provision
the named function, Function URL, runtime, and environment, including a high-entropy `RelayToken`.
The function runtime and resource configuration are authoritative in that template.

Provisioning is only the infrastructure step. The source directory contains TypeScript; a plain
copy/SAM package of that directory is not the deployable signed runtime. After provisioning,
configure the OIDC role below and run **Deploy AudioUnion Lambda**. That workflow builds
`dist/audiounion-lambda/index.mjs` with `vp run build:lambda`, injects a private per-deployment
`RELAY_PERMIT_SECRET`, packages the bundle, and updates the function. Keep the relay disabled in
Worker configuration until that deployment and its PREPARE/FETCH probes succeed.

Use the `FunctionUrl` stack output for `CRAWL_RELAY_URL`. The Bearer token is shared with the Worker;
the permit-signing secret stays inside Lambda's private deployment and is not shared with the Worker.

## Automatic code deployment from GitHub Actions

After the initial SAM deployment, changes matching the path filter in `.github/workflows/deploy-audiounion-lambda.yml` on `main` are automatically packaged and deployed to the existing `hifiscout-audiounion-fetcher` function in `ap-northeast-1` by `.github/workflows/deploy-audiounion-lambda.yml`. The workflow can also be run manually with `workflow_dispatch`.

Authentication uses GitHub Actions OIDC. Do not create long-lived AWS access keys for this workflow.

### 1. Create the GitHub OIDC provider in AWS

In AWS IAM, add an OpenID Connect identity provider with:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

This provider only needs to be created once per AWS account.

### 2. Create an IAM role for GitHub Actions

Create a role that trusts the GitHub OIDC provider. Restrict it to this repository's `main` branch.

Replace `<AWS_ACCOUNT_ID>` with your AWS account ID in the trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:apaapapapapa/HiFiScout:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Attach a least-privilege policy that allows updating and verifying only this Lambda function:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:ap-northeast-1:<AWS_ACCOUNT_ID>:function:hifiscout-audiounion-fetcher"
    }
  ]
}
```

### 3. Add the role ARN to GitHub

In the repository, open **Settings > Secrets and variables > Actions > Variables** and create:

- Name: `AWS_LAMBDA_DEPLOY_ROLE_ARN`
- Value: the IAM role ARN, for example `arn:aws:iam::<AWS_ACCOUNT_ID>:role/hifiscout-lambda-github-deploy`

The role ARN is not a secret, so it is stored as a GitHub Actions variable rather than a secret.

The workflow path filter includes `index.ts`, `template.yaml`, and the workflow itself. It performs a code update, not a SAM/CloudFormation deployment: triggering it with a template change does not apply infrastructure/environment changes. Apply those through SAM/CloudFormation, and then run the code deployment to install the built signed bundle.

## Configure HiFiScout

The deployment workflow synchronizes the Lambda Function URL and relay token into these Cloudflare Worker secrets:

- `CRAWL_RELAY_URL`
- `CRAWL_RELAY_TOKEN`

For a manual setup, use:

```bash
printf '%s' 'https://<function-url-id>.lambda-url.ap-northeast-1.on.aws/' | vp exec wrangler secret put CRAWL_RELAY_URL
printf '%s' "$RELAY_TOKEN" | vp exec wrangler secret put CRAWL_RELAY_TOKEN
```

Relay-backed shop collectors are considered configured only when both secrets exist. At present, both `audiounion` and `hifido` use the shared relay transport.

## Smoke tests and verification

The automatic Lambda deployment workflow probes an active Audio Union used-detail URL selected
from D1 and the validated Hifido listing URL. It uses the same protocol as the crawler:

| Step | Request / result |
| --- | --- |
| PREPARE | Authenticated POST with `operation: "prepare"`, the allowlisted `url`, and request profile; returns `permit`, `targetUrl`, `requestedUserAgent`, `notBeforeMs`, and `expiresAtMs` |
| Wait | GitHub runner waits outside Lambda; production crawl waits through a DO Alarm |
| FETCH | Authenticated POST with `operation: "fetch"`, the permit, and the returned URL/User-Agent binding |
| Validate | Successful HTML response, expected region/upstream headers, and seller-specific content checks |

PREPARE may access `robots.txt`; FETCH accesses the seller page. These are live integration probes,
not offline unit tests. Keep the workflow targets aligned with the registered adapters. An expired
permit must be prepared again; a redeploy rotates the signing key, so an in-flight old permit may
also need re-preparation. Do not log tokens or permits.

The relay retains a legacy one-call compatibility handler, but it is not the normal crawl protocol
or the recommended smoke test. Do not use that handler to bypass Alarm-based pacing.

## Low-frequency Audio Union inventory recheck

The Worker uses Audio Union detail pages only for stale-product inventory verification. The defaults are deliberately conservative:

- the product must not have been observed in the normal listing for at least 24 hours;
- at most one stale Audio Union product is rechecked after each successful Audio Union crawl;
- the same product is attempted at most once per 24 hours;
- `last_inventory_check_attempt_at` is separate from `last_inventory_checked_at`, so robots rejection, rate limiting, and transient failures can back off without being recorded as a successful inventory verification;
- contradictory or ambiguous HTML never deactivates a product;
- explicit sold-out evidence or HTTP 404/410 must be observed twice consecutively before the product is marked inactive;
- a later normal-listing observation resets the effective unavailable streak.

The settings are controlled by `AUDIOUNION_INVENTORY_RECHECK_*` variables in `wrangler.jsonc`.

## Security and cost controls

- The relay is not a general-purpose proxy: it permits the configured Audio Union entry URL, exact numeric Audio Union used-detail URLs, and the separately validated Hifido listing shape only.
- PREPARE checks the live `robots.txt` policy; FETCH verifies the signed target/profile and permit timing before accessing the seller page.
- Requests without the Bearer token are rejected before any seller request is made.
- The normal scheduler path is single-flight per shop through `CrawlScheduler`; there is no crawl Queue. Lambda reserved concurrency is not configured by the template.
- The minimum request delay defaults to 10 seconds; a larger Worker-side delay or `robots.txt` crawl delay wins.
- The function URL is still public at the network layer, so keep both its URL and Bearer token out of source control. If the service is later exposed broadly, move to IAM/SigV4 authentication.
