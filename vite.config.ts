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

const vendoredAgentSkillPatterns = [".agents/skills/archify/**"];

export default defineConfig(({ mode }) => ({
  publicDir: false,
  resolve: {
    alias: {
      "cloudflare:workers": fromRoot("./test/stubs/cloudflare-workers.ts"),
    },
  },
  lint: {
    ignorePatterns: vendoredAgentSkillPatterns,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
  },
  fmt: {
    ignorePatterns: vendoredAgentSkillPatterns,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
  run: {
    tasks: {
      "ci:lint": ciShell("vp lint . --deny-warnings"),
      "ci:format-check": ciShell(
        'vp fmt --check --no-error-on-unmatched-pattern "**/*.ts" "**/*.mts" "**/*.cts" "**/*.tsx"',
      ),
      "ci:no-js-source": ciShell("vp exec tsx scripts/check-no-first-party-js.ts"),
      "ci:types-worker": {
        command: ciShell(
          "vp exec tsx scripts/ensure-directories.ts .generated && vp exec tsx scripts/run-quiet.ts wrangler types .generated/worker-configuration.d.ts",
        ),
        input: ["wrangler.jsonc", "package.json", "package-lock.json"],
        output: [".generated/worker-configuration.d.ts"],
      },
      "ci:typecheck": {
        command: ciShell("vp exec tsc --noEmit"),
        dependsOn: ["ci:types-worker"],
        output: [],
      },
      "ci:test-shard-1": {
        command: ciShell("vp test run --reporter=dot --shard=1/2"),
        output: [],
      },
      "ci:test-shard-2": {
        command: ciShell("vp test run --reporter=dot --shard=2/2"),
        output: [],
      },
      "ci:build-public": ciShell("vp build --mode public"),
      "ci:build-admin": ciShell("vp build --mode admin"),
      "ci:build-worker": {
        command: ciShell("vp exec wrangler deploy --dry-run --outdir dist/worker"),
        dependsOn: ["ci:build-public"],
      },
      "ci:build-admin-worker": {
        command: ciShell(
          "vp exec wrangler deploy --dry-run --config wrangler.admin.jsonc --outdir dist/admin-worker",
        ),
        dependsOn: ["ci:build-admin"],
      },
      "ci:build-lambda": ciShell("vp build --mode lambda"),
      "ci:build": {
        command: "true",
        dependsOn: ["ci:build-worker", "ci:build-admin-worker", "ci:build-lambda"],
        input: [],
        output: [],
      },
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
