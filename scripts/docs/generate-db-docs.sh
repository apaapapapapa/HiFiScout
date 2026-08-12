#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMASPY_VERSION="7.0.2"
SQLITE_JDBC_VERSION="3.42.0.0"
DRIVER_DIR="$ROOT_DIR/.cache/docs/drivers"
OUTPUT_DIR="$ROOT_DIR/docs/public/db"
DRIVER_JAR="$DRIVER_DIR/sqlite-jdbc-${SQLITE_JDBC_VERSION}.jar"

cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required to generate SchemaSpy documentation." >&2
  exit 1
}

npm run db:migrate:local

DB_FILE="$(find "$ROOT_DIR/.wrangler/state/v3/d1" -type f -name '*.sqlite' -print -quit)"
if [[ -z "$DB_FILE" ]]; then
  echo "Could not locate the local D1 SQLite database after applying migrations." >&2
  exit 1
fi

mkdir -p "$DRIVER_DIR"
if [[ ! -f "$DRIVER_JAR" ]]; then
  curl --fail --location --retry 3 \
    "https://repo.maven.apache.org/maven2/org/xerial/sqlite-jdbc/${SQLITE_JDBC_VERSION}/sqlite-jdbc-${SQLITE_JDBC_VERSION}.jar" \
    --output "$DRIVER_JAR"
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$DB_FILE:/db/hifiscout.sqlite:ro" \
  -v "$DRIVER_DIR:/drivers:ro" \
  -v "$OUTPUT_DIR:/output" \
  "schemaspy/schemaspy:${SCHEMASPY_VERSION}" \
  -t sqlite-xerial \
  -db /db/hifiscout.sqlite \
  -cat '%' \
  -sso \
  -noschema \
  -imageformat svg
