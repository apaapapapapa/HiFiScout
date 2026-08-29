import { copyFile, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const sourceDir = resolve("docs/ai-generated");
const outputDir = resolve("docs/public/generated");
const htmlSource = resolve(sourceDir, "architecture.html");
const htmlOutput = resolve(outputDir, "ai-architecture.html");
const jsonSource = resolve(sourceDir, "architecture.json");
const jsonOutput = resolve(outputDir, "ai-architecture.json");

await mkdir(outputDir, { recursive: true });
await copyFile(htmlSource, htmlOutput);

try {
  const metadata = await stat(jsonSource);
  if (metadata.isFile()) {
    await copyFile(jsonSource, jsonOutput);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
