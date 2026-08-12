#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Mechanical source migration. This runs only on the Phase 2.5 feature branch.
mkdir -p frontend
for file in public/app.js public/catalog-url-state.js public/shop-links.js; do
  if [[ -f "$file" ]]; then
    git mv "$file" "frontend/$(basename "${file%.js}.ts")"
  fi
done

while IFS= read -r -d '' file; do
  case "$file" in
    docs/.vitepress/config.mjs)
      git mv "$file" docs/.vitepress/config.mts
      ;;
    .dependency-cruiser.mjs|release.config.mjs)
      ;;
    *)
      target="${file%.*}.ts"
      git mv "$file" "$target"
      ;;
  esac
done < <(find src test e2e scripts infra -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.jsx' \) -print0)

if [[ -f docs/.vitepress/config.mjs ]]; then
  git mv docs/.vitepress/config.mjs docs/.vitepress/config.mts
fi

cat > .dependency-cruiser.json <<'JSON'
{
  "forbidden": [
    {
      "name": "no-circular",
      "severity": "error",
      "comment": "Keep production module dependencies acyclic.",
      "from": { "path": "^src" },
      "to": { "circular": true }
    }
  ],
  "options": {
    "doNotFollow": { "path": "node_modules" },
    "includeOnly": "^src"
  }
}
JSON
rm -f .dependency-cruiser.mjs release.config.mjs

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": [
    "src/**/*.ts",
    "test/**/*.ts",
    "scripts/**/*.ts",
    "e2e/**/*.ts",
    "infra/**/*.ts",
    "frontend/**/*.ts",
    "docs/**/*.ts",
    "docs/**/*.mts",
    ".generated/**/*.d.ts"
  ],
  "exclude": ["node_modules", "dist", "build", "docs/.vitepress/dist"]
}
JSON

mkdir -p scripts
cat > scripts/check-no-first-party-js.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mapfile -t files < <(git ls-files '*.js' '*.mjs' '*.cjs' '*.jsx')
if ((${#files[@]} > 0)); then
  printf 'Tracked first-party JavaScript source/config is forbidden after Phase 2.5:\n' >&2
  printf ' - %s\n' "${files[@]}" >&2
  exit 1
fi
echo 'No tracked first-party JavaScript source/config files found.'
SH
chmod +x scripts/check-no-first-party-js.sh

cat > docs/typescript.md <<'MD'
# TypeScript development

HiFiScout is a TypeScript application. First-party JavaScript source (`.js`, `.mjs`, `.cjs`, `.jsx`) must not be committed.

## Compiler policy

`tsconfig.json` uses `strict: true` and `noEmit: true`. `allowJs`, `checkJs`, `strict: false`, `noImplicitAny: false`, and `strictNullChecks: false` are intentionally not used. `skipLibCheck` is limited to third-party/runtime declaration compatibility; all first-party source directories remain in the TypeScript program.

Run `npm run typecheck` before opening or updating a PR. The command regenerates Cloudflare binding/runtime declarations with Wrangler and then runs `tsc --noEmit`.

## Modules and imports

The repository remains ESM (`"type": "module"`). TypeScript uses ESNext modules with bundler-compatible resolution because Workers are built by Wrangler/esbuild and Node scripts/tests execute through `tsx`. Existing relative ESM imports use `.js` specifiers in TypeScript source where they describe the emitted/runtime module path; TypeScript and `tsx` resolve those specifiers back to the `.ts` source. Do not introduce `.ts` import suffixes.

## Runtime boundaries

Wrangler owns Cloudflare binding declarations. `npm run types:worker` writes them to `.generated/worker-configuration.d.ts`; generated declarations and JavaScript build artifacts are not hand edited or committed.

External HTML/HTTP/query-string/D1/queue/environment input remains runtime-validated where the application already validates it. TypeScript types do not replace runtime validation. DB row shapes are kept separate from domain/API shapes at repository boundaries when their structures differ.

## Execution and builds

- Node scripts/tests: `tsx` (`npm test`, `npm run create-shop`, search verification scripts).
- Browser source: `frontend/*.ts` -> generated `public/*.js` via esbuild. Static HTML/CSS remain unchanged.
- Cloudflare Worker: Wrangler consumes `src/index.ts` directly; no second Worker transpilation layer is added.
- Lambda relay: `infra/audiounion-lambda/index.ts` -> generated ESM artifact under `dist/audiounion-lambda/` via esbuild.
- E2E: Playwright runs `.ts` specs/config directly.

## Type design

Prefer domain-local `type`/`interface` declarations, string-literal unions for status/state, `unknown` for untrusted external values, and discriminated unions for multi-state results. Avoid broad `any`, blanket assertions, `@ts-ignore`, and `@ts-nocheck`. Use `@ts-expect-error` only for a narrow documented upstream limitation.

## JavaScript source guard

`npm run check:no-js-source` examines tracked files and fails if first-party JavaScript source/config is reintroduced. Generated browser/Worker/Lambda JavaScript stays ignored and is produced during build/deploy.
MD

cat >> .gitignore <<'EOF'

# TypeScript/JavaScript generated artifacts
.generated/
dist/
public/app.js
public/catalog-url-state.js
public/shop-links.js
EOF

python3 - <<'PY'
from pathlib import Path
import json

p = Path('package.json')
data = json.loads(p.read_text())
s = data.setdefault('scripts', {})
s.update({
    'test': 'npm run test:unit',
    'test:unit': 'tsx --test test/*.test.ts',
    'test:e2e': 'npm --prefix e2e test',
    'typecheck': 'npm run types:worker && tsc --noEmit',
    'types:worker': 'mkdir -p .generated && wrangler types .generated/worker-configuration.d.ts',
    'build': 'npm run build:frontend && npm run build:worker && npm run build:lambda',
    'build:frontend': 'esbuild frontend/app.ts frontend/catalog-url-state.ts frontend/shop-links.ts --outdir=public --format=iife --target=es2022',
    'build:worker': 'wrangler deploy --dry-run --outdir dist/worker',
    'build:lambda': 'mkdir -p dist/audiounion-lambda && esbuild infra/audiounion-lambda/index.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/audiounion-lambda/index.mjs',
    'check:no-js-source': 'bash scripts/check-no-first-party-js.sh',
    'create-shop': 'tsx scripts/create-shop.ts',
    'docs:api': 'npx --yes documentation@14.0.0 build src/index.ts --document-exported --github -f md -o docs/reference/api.md',
    'docs:architecture:check': 'npx --yes dependency-cruiser@18.1.0 src --config .dependency-cruiser.json --ts-config tsconfig.json --output-type err',
    'docs:architecture': 'mkdir -p docs/public/generated && npx --yes dependency-cruiser@18.1.0 src --config .dependency-cruiser.json --ts-config tsconfig.json --output-type html --output-to docs/public/generated/dependencies.html'
})
# Oxfmt is now TypeScript-first; JSON/Markdown remain handled by their existing tools/pipelines.
s['format'] = 'oxfmt --no-error-on-unmatched-pattern "**/*.ts" "**/*.mts" "**/*.cts" "**/*.tsx"'
s['format:check'] = 'oxfmt --check --no-error-on-unmatched-pattern "**/*.ts" "**/*.mts" "**/*.cts" "**/*.tsx"'
data['release'] = {
    'branches': ['main'],
    'tagFormat': 'v${version}',
    'plugins': [
        ['@semantic-release/commit-analyzer', {'releaseRules': [
            {'type': 'security', 'release': 'patch'},
            {'type': 'perf', 'release': 'patch'},
            {'type': 'refactor', 'release': 'patch'}
        ]}],
        '@semantic-release/release-notes-generator',
        ['@semantic-release/github', {'successComment': False, 'failComment': False}]
    ]
}
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PY

# Entrypoints and first-party direct execution references.
sed -i 's#src/index\.js#src/index.ts#g' wrangler.jsonc README.md docs/*.md 2>/dev/null || true
find .github docs infra -type f \( -name '*.yml' -o -name '*.yaml' -o -name '*.md' \) -print0 | xargs -0 sed -i \
  -e 's#scripts/verify-search-integration\.mjs#scripts/verify-search-integration.ts#g' \
  -e 's#scripts/create-shop\.mjs#scripts/create-shop.ts#g' \
  -e 's#infra/audiounion-lambda/index\.mjs#infra/audiounion-lambda/index.ts#g'

# CI/deploy commands execute TypeScript source through tsx and build browser assets before Worker packaging.
sed -i 's#node scripts/verify-search-integration\.ts#npx tsx scripts/verify-search-integration.ts#g' .github/workflows/*.yml

python3 - <<'PY'
from pathlib import Path
p = Path('AGENTS.md')
text = p.read_text()
addition = '''\n## TypeScript-only source policy\n\n- New first-party application, test, script, E2E, infrastructure, frontend, and tooling source must be TypeScript (or a non-JavaScript declarative format).\n- Do not add tracked `.js`, `.mjs`, `.cjs`, or `.jsx` first-party source/config files. Generated JavaScript belongs in ignored build output only.\n- Run `npm run typecheck`, `npm run format:check`, `npm run lint`, and `npm run check:no-js-source` before publishing changes.\n'''
if '## TypeScript-only source policy' not in text:
    p.write_text(text.rstrip() + '\n' + addition)
PY

# Add the minimal compiler/runtime tooling and regenerate the root lockfile.
npm install --save-dev \
  typescript@latest \
  tsx@latest \
  esbuild@latest \
  @types/node@22 \
  @types/aws-lambda@latest \
  @playwright/test@1.62.0 \
  vitepress@1.6.4

# Ensure browser output is generated from TS and not tracked as source.
rm -f public/app.js public/catalog-url-state.js public/shop-links.js

# Ensure E2E config/spec names use TypeScript and root direct references are updated.
find e2e -type f -name '*.mjs' -print0 | while IFS= read -r -d '' f; do git mv "$f" "${f%.mjs}.ts"; done

# Basic workflow modernization. Detailed CI/deploy updates may follow after strict typecheck feedback.
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/ci.yml')
text = p.read_text()
text = text.replace('      - run: npm run lint\n', '      - run: npm run check:no-js-source\n      - run: npm run lint\n')
text = text.replace('      - run: npm run db:migrate:local\n', '      - run: npm run typecheck\n      - run: npm run build:frontend\n      - run: npm run db:migrate:local\n')
text = text.replace('      - run: npx wrangler deploy --dry-run\n', '      - run: npm run build\n')
p.write_text(text)
PY

# Format only after dependencies are installed. Type errors are intentionally handled in follow-up commits.
npm run format || true

echo 'Phase 2.5 mechanical bootstrap complete.'
