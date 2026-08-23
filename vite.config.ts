import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

function fromRoot(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function browserBundle(entry: string, outDir: string, fileName: string, name: string) {
  return {
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022" as const,
      minify: false,
      lib: {
        entry: fromRoot(entry),
        name,
        formats: ["iife" as const],
        fileName: () => fileName,
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  publicDir: false,
  resolve: {
    alias: {
      "cloudflare:workers": fromRoot("./test/stubs/cloudflare-workers.ts"),
    },
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    ignorePatterns: [],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  ...(mode === "public"
    ? browserBundle("./frontend/app.tsx", "public", "app.js", "HiFiScoutApp")
    : mode === "admin"
      ? browserBundle(
          "./frontend/admin-console.tsx",
          "admin-public",
          "admin-console.js",
          "HiFiScoutAdmin",
        )
      : mode === "lambda"
        ? {
            build: {
              outDir: "dist/audiounion-lambda",
              emptyOutDir: true,
              target: "node22",
              minify: false,
              ssr: fromRoot("./infra/audiounion-lambda/index.ts"),
              rolldownOptions: {
                external: [/^node:/u],
                output: {
                  entryFileNames: "index.mjs",
                },
              },
            },
            ssr: {
              noExternal: true,
            },
          }
        : {}),
}));
