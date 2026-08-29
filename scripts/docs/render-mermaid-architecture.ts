import { readFile, writeFile } from "node:fs/promises";

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  throw new Error("usage: render-mermaid-architecture.ts <input.mmd> <output.html>");
}

const source = await readFile(inputPath, "utf8");
const escapedSource = source
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HiFiScout architecture overview</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 1rem; background: Canvas; color: CanvasText; }
    .diagram { min-width: max-content; }
    .viewport { overflow: auto; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 1rem; }
    .fallback { white-space: pre-wrap; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <main class="viewport" aria-label="Generated HiFiScout module architecture diagram">
    <pre id="architecture" class="diagram mermaid">${escapedSource}</pre>
  </main>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";

    const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: dark ? "dark" : "default" });
    mermaid.run({ querySelector: ".mermaid" }).catch((error) => {
      console.error(error);
      document.querySelector("#architecture")?.classList.add("fallback");
    });
  </script>
</body>
</html>
`;

await writeFile(outputPath, html, "utf8");
