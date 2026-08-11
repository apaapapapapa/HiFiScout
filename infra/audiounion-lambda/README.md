# AudioUnion Tokyo Lambda relay

AudioUnion is fetched through a small AWS Lambda function in the Tokyo region (`ap-northeast-1`). The Lambda only returns the source HTML; parsing, normalization, D1 writes, and crawl-state handling remain in the Cloudflare Worker.

The function URL uses `AuthType: NONE` so Cloudflare can call it without AWS credentials. The function itself requires a high-entropy Bearer token, only permits the configured AudioUnion entry URL, respects `robots.txt`, and enforces a minimum request delay. Normal HiFiScout crawl execution is serialized by the Cloudflare crawl queue (`max_concurrency: 1`). Lambda reserved concurrency is intentionally not configured because AWS accounts with a small Lambda concurrency quota can reject a reservation when it would reduce the account's unreserved concurrency below AWS's required minimum.

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

## Configure HiFiScout

Set both values as Cloudflare Worker secrets; do not commit them to `wrangler.jsonc`.

```bash
printf '%s' 'https://<function-url-id>.lambda-url.ap-northeast-1.on.aws/' | npx wrangler secret put AUDIOUNION_RELAY_URL
printf '%s' "$RELAY_TOKEN" | npx wrangler secret put AUDIOUNION_RELAY_TOKEN
```

After the relay code is deployed, AudioUnion is considered configured only when both secrets exist. Other shop collectors continue to use their existing transports.

## Smoke test

This invokes the seller once, so use it only when needed.

```bash
curl -i -X POST "$AUDIOUNION_RELAY_URL" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://www.audiounion.jp/st/new_arrival_used.html","userAgent":"HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)","requestDelayMs":10000}'
```

A successful response should be `200`, have an HTML content type, and include `x-hifiscout-aws-region: ap-northeast-1` and `x-hifiscout-upstream-status: 200`.

## Security and cost controls

- The target URL is fixed to the configured `www.audiounion.jp` entry URL; the Lambda is not a general-purpose proxy.
- Requests without the Bearer token are rejected before any seller request is made.
- The normal scheduler path is serialized by the Cloudflare crawl queue; Lambda reserved concurrency is intentionally omitted for compatibility with low-quota AWS accounts.
- The minimum request delay defaults to 10 seconds; a larger Worker-side delay or `robots.txt` crawl delay wins.
- The function URL is still public at the network layer, so keep both its URL and Bearer token out of source control. If the service is later exposed broadly, move to IAM/SigV4 authentication.
