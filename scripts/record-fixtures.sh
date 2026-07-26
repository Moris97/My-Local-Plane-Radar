#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="${MLPR_AIRCRAFT_JSON_PATH:-/run/readsb/aircraft.json}"
DURATION_SECONDS="${1:-600}"
INTERVAL_SECONDS="${2:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$REPO_ROOT/fixtures"

mkdir -p "$OUTPUT_DIR"

if [ ! -r "$SOURCE_PATH" ]; then
  echo "Cannot read $SOURCE_PATH — is readsb running?" >&2
  exit 1
fi

echo "Recording $SOURCE_PATH into $OUTPUT_DIR every ${INTERVAL_SECONDS}s for ${DURATION_SECONDS}s..."

END_TIME=$(($(date +%s) + DURATION_SECONDS))
COUNT=0

while [ "$(date +%s)" -lt "$END_TIME" ]; do
  FILENAME=$(printf '%06d.json' "$COUNT")
  cp "$SOURCE_PATH" "$OUTPUT_DIR/$FILENAME"
  COUNT=$((COUNT + 1))
  sleep "$INTERVAL_SECONDS"
done

echo "Recorded $COUNT snapshots into $OUTPUT_DIR"
