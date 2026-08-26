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

const ciShell = (command: string): string => `bash -lc ${JSON.stringify(command)}`;

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
  },
  fmt: {
    ignorePatterns: [],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  run: {
    tasks: {
      "ci:lint": ciShell("vp lint . --deny-warnings"),
      "ci:format-check": ciShell(
        'vp fmt --check --no-error-on-unmatched-pattern "**/*.ts" "**/*.mts" "**/*.cts" "**/*.tsx"',
      ),
      "ci:no-js-source": ciShell("vp exec tsx scripts/check-no-first-party-js.ts"),
      "ci:types-worker": ciShell(
        "vp exec tsx scripts/ensure-directories.ts .generated && vp exec tsx scripts/run-quiet.ts wrangler types .generated/worker-configuration.d.ts",
      ),
      "ci:typecheck": {
        command: ciShell("vp exec tsc --noEmit"),
        dependsOn: ["ci:types-worker"],
      },
      "ci:test-shard-1": ciShell("vp test run --reporter=dot --shard=1/2"),
      "ci:test-shard-2": ciShell("vp test run --reporter=dot --shard=2/2"),
      "ci:build": ciShell(
        "vp build --mode public && vp build --mode admin && vp exec wrangler deploy --dry-run --outdir dist/worker && vp exec wrangler deploy --dry-run --config wrangler.admin.jsonc --outdir dist/admin-worker && vp build --mode lambda",
      ),
    },
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
