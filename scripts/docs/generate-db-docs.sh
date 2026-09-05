#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMASPY_VERSION="7.0.2"
SQLITE_JDBC_VERSION="3.42.0.0"
DRIVER_DIR="$ROOT_DIR/.cache/docs/drivers"
WRANGLER_STATE_DIR="$ROOT_DIR/.cache/docs/wrangler-state"
DB_WORK_DIR="$ROOT_DIR/.cache/docs/schema"
OUTPUT_DIR="$ROOT_DIR/docs/public/db"
DRIVER_JAR="$DRIVER_DIR/sqlite-jdbc-${SQLITE_JDBC_VERSION}.jar"
WORK_DB_FILE="$DB_WORK_DIR/hifiscout.sqlite"
SCHEMASPY_TYPE_FILE="$ROOT_DIR/scripts/docs/hifiscout-sqlite.properties"

cd "$ROOT_DIR"

fingerprint="$(vp exec tsx scripts/docs/db-docs-cache.ts)"
fingerprint_file="$ROOT_DIR/.cache/docs/db-docs-fingerprint"
if [[ -s "$OUTPUT_DIR/index.html" && -s "$fingerprint_file" ]] && \
   [[ "$(cat "$fingerprint_file")" == "$fingerprint" ]]; then
  echo "Schema documentation unchanged; using the verified input cache."
  exit 0
fi

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required to generate SchemaSpy documentation." >&2
  exit 1
}

rm -rf "$WRANGLER_STATE_DIR" "$DB_WORK_DIR" "$OUTPUT_DIR"
mkdir -p "$WRANGLER_STATE_DIR" "$DB_WORK_DIR" "$OUTPUT_DIR"

npx wrangler d1 migrations apply DB --local --persist-to "$WRANGLER_STATE_DIR"

DB_FILE="$(npx tsx scripts/docs/find-d1-database.ts "$WRANGLER_STATE_DIR")"

mkdir -p "$DRIVER_DIR"
if [[ ! -f "$DRIVER_JAR" ]]; then
  curl --fail --location --retry 3 \
    "https://repo.maven.apache.org/maven2/org/xerial/sqlite-jdbc/${SQLITE_JDBC_VERSION}/sqlite-jdbc-${SQLITE_JDBC_VERSION}.jar" \
    --output "$DRIVER_JAR"
fi

cp "$DB_FILE" "$WORK_DB_FILE"
chmod u+w "$WORK_DB_FILE"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$DB_WORK_DIR:/db" \
  -v "$DRIVER_DIR:/drivers:ro" \
  -v "$OUTPUT_DIR:/output" \
  -v "$SCHEMASPY_TYPE_FILE:/hifiscout-sqlite.properties:ro" \
  "schemaspy/schemaspy:${SCHEMASPY_VERSION}" \
  -t hifiscout-sqlite \
  -db /db/hifiscout.sqlite \
  -cat main \
  -s main \
  -sso \
  -noschema \
  -imageformat svg

test -s "$OUTPUT_DIR/index.html"
printf '%s\n' "$fingerprint" > "$fingerprint_file"
