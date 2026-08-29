import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  PUBLIC_API_ROUTE_CONTRACTS,
  PUBLIC_API_SCHEMAS,
} from "../../src/api/public-route-contracts.js";
import { buildOpenApiDocument } from "../../src/api/route-contract.js";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  version: string;
};
const output = resolve("docs/public/generated/openapi.json");
const document = buildOpenApiDocument(PUBLIC_API_ROUTE_CONTRACTS, {
  title: "HiFiScout HTTP API",
  version: packageJson.version,
  description:
    "Public HTTP contracts generated from the same route metadata used by the Cloudflare Worker.",
  schemas: PUBLIC_API_SCHEMAS,
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Generated ${output}`);
