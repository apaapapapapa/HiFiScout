import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const generatedApi = resolve(".cache/docs/typedoc/api.md");
const publishedApi = resolve("docs/reference/api.md");

mkdirSync(dirname(publishedApi), { recursive: true });
copyFileSync(generatedApi, publishedApi);

console.log("Published TypeDoc API reference to docs/reference/api.md");
