# Tokyo Lambda relay for Audio Union and Hifido

HiFiScout uses a small AWS Lambda function in the Tokyo region (`ap-northeast-1`) as an allowlisted HTTP relay for **Audio Union** and **ハイファイ堂 (Hifido)**. The Lambda only returns source HTML; parsing, normalization, classification, D1 writes, crawl-state handling, and scheduling remain in the Cloudflare Worker.

The function URL uses `AuthType: NONE` so Cloudflare can call it without AWS credentials. The function itself requires a high-entropy Bearer token and is not a general-purpose proxy. It permits only:

- the configured Audio Union new-arrival entry URL;
- exact numeric Audio Union used-detail URLs under `/ct/detail/used/<id>/`;
- the validated Hifido listing URL shape used by the collector, with only the expected query parameters.

Every seller request is evaluated against the seller's current `robots.txt`, and the relay enforces a minimum request delay. `/ct/search` and unrelated Audio Union/Hifido paths remain outside the allowlist. Normal HiFiScout crawl execution is serialized by the Cloudflare crawl queue (`max_concurrency: 1`). Lambda reserved concurrency is intentionally not configured because AWS accounts with a small Lambda concurrency quota can reject a reservation when it would reduce the account's unreserved concurrency below AWS's required minimum.

> Historical naming note: the infrastructure directory, Lambda function, and some workflow names still contain `audiounion`. They are retained for compatibility even though the relay now also serves Hifido listing requests.

## Deploy to Tokyo

Requirements: AWS credentials and AWS SAM CLI.

```bash
cd infra/audiounion-lambda
export RELAY_TOKEN="$(openssl rand -hex 32)"
sam build
sam deploy \
  --guided \
  --region ap-northeast-1 \
  --stack-name hifiscout-audiounion-relay \
  --parameter-overrides "RelayToken=${RELAY_TOKEN}"
```

Use the `FunctionUrl` stack output as the Worker relay URL. The Node.js 22 Lambda runtime is supported by AWS Lambda and runs on Amazon Linux 2023.

## Automatic code deployment from GitHub Actions

After the initial SAM deployment, changes to `infra/audiounion-lambda/index.ts` on `main` are automatically packaged and deployed to the existing `hifiscout-audiounion-fetcher` function in `ap-northeast-1` by `.github/workflows/deploy-audiounion-lambda.yml`. The workflow can also be run manually with `workflow_dispatch`.

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

Once these AWS and GitHub settings are complete, pushing a Lambda code change to `main` will deploy it automatically. Changes to `template.yaml` are intentionally excluded because infrastructure/configuration changes should continue to be applied through SAM/CloudFormation rather than a code-only Lambda update.

## Configure HiFiScout

The deployment workflow synchronizes the Lambda Function URL and relay token into these Cloudflare Worker secrets:

- `CRAWL_RELAY_URL`
- `CRAWL_RELAY_TOKEN`

For a manual setup, use:

```bash
printf '%s' 'https://<function-url-id>.lambda-url.ap-northeast-1.on.aws/' | npx wrangler secret put CRAWL_RELAY_URL
printf '%s' "$RELAY_TOKEN" | npx wrangler secret put CRAWL_RELAY_TOKEN
```

Relay-backed shop collectors are considered configured only when both secrets exist. At present, both `audiounion` and `hifido` use the shared relay transport.

## Smoke tests and verification

### Audio Union

This invokes the seller once, so use it only when needed.

```bash
curl -i -X POST "$CRAWL_RELAY_URL" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://www.audiounion.jp/st/new_arrival_used.html","userAgent":"HiFiScoutBot/0.1 (+https://github.com/apaapapapa/HiFiScout)","requestDelayMs":10000}'
```

A successful response should be `200`, have an HTML content type, and include `x-hifiscout-aws-region: ap-northeast-1` and `x-hifiscout-upstream-status: 200`.

The automatic Lambda deployment workflow also selects one currently active Audio Union used-detail URL from D1 and probes it through the Tokyo relay. The deployment fails if live `robots.txt` rejects that path or if the detail page is not reachable through the relay.

### Hifido

Hifido uses the same Function URL/token pair but a browser-like User-Agent and a separately restricted URL shape. The automatic Lambda deployment workflow probes both Audio Union and Hifido in the same runner after deployment, so relay verification stays aligned without a separate follow-up workflow. Keep that verification aligned with `src/crawler/shops/hifido.ts` whenever the Hifido listing URL format changes.

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
- Every seller target is still subject to the live `robots.txt` policy before seller access.
- Requests without the Bearer token are rejected before any seller request is made.
- The normal scheduler path is serialized by the Cloudflare crawl queue; Lambda reserved concurrency is intentionally omitted for compatibility with low-quota AWS accounts.
- The minimum request delay defaults to 10 seconds; a larger Worker-side delay or `robots.txt` crawl delay wins.
- The function URL is still public at the network layer, so keep both its URL and Bearer token out of source control. If the service is later exposed broadly, move to IAM/SigV4 authentication.
