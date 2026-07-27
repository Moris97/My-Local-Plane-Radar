#!/usr/bin/env bash
set -euo pipefail

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13
NODESOURCE_HINT="  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -\n  sudo apt-get install -y nodejs"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} from NodeSource (never 'apt install nodejs' — Debian's own package is too old):" >&2
  echo -e "$NODESOURCE_HINT" >&2
  exit 1
fi

NODE_VERSION="$(node --version)"
NODE_VERSION_NUM="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_VERSION_NUM%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION_NUM" | cut -d. -f2)"

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  echo "Node.js ${NODE_VERSION} is too old (need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0)." >&2
  echo "Install from NodeSource instead of apt:" >&2
  echo -e "$NODESOURCE_HINT" >&2
  exit 1
fi

echo "Node.js ${NODE_VERSION} OK."

cd "$REPO_ROOT"

echo "Installing dependencies (production only — skipping devDependencies like Playwright)..."
npm ci --omit=dev

if [ ! -d "$REPO_ROOT/data/naturalearth" ]; then
  echo "Fetching basemap data..."
  ./scripts/fetch-mapdata.sh
fi

if [ ! -f "$REPO_ROOT/data/airlines.json" ]; then
  echo "Fetching airline database (for Stats -> most common airline)..."
  ./scripts/fetch-airlines.sh || echo "Could not fetch the airline database (offline?) -- skipping, airline names just won't resolve until this is re-run." >&2
fi

READSB_ENV_FILE="/etc/default/readsb"
TAR1090_DB_DIR="/usr/local/share/tar1090"
TAR1090_DB_FILE="$TAR1090_DB_DIR/aircraft.csv.gz"
TAR1090_DB_URL="https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz"

# readsb only reports registration/aircraft-type (used by the aircraft
# details panel and notifications) when started with --db-file pointing at
# this database. Wire it up automatically on a fresh install so nobody has
# to go find this out the hard way (see CLAUDE.md). Best-effort and
# idempotent: skipped entirely if readsb isn't installed the standard way,
# left alone if --db-file is already configured, and a failed download
# (offline, GitHub unreachable) is a warning, not a failed install.
if [ -f "$READSB_ENV_FILE" ]; then
  if grep -q -- '--db-file' "$READSB_ENV_FILE"; then
    echo "readsb already has --db-file configured -- leaving it alone."
  else
    echo
    echo "readsb found without --db-file (needed for aircraft registration/type) -- setting it up..."
    if sudo mkdir -p "$TAR1090_DB_DIR" && sudo wget -q -O "$TAR1090_DB_FILE" "$TAR1090_DB_URL"; then
      if grep -q '^JSON_OPTIONS=' "$READSB_ENV_FILE"; then
        sudo sed -i "s#^JSON_OPTIONS=\"\(.*\)\"#JSON_OPTIONS=\"\1 --db-file $TAR1090_DB_FILE\"#" "$READSB_ENV_FILE"
      else
        echo "JSON_OPTIONS=\"--db-file $TAR1090_DB_FILE\"" | sudo tee -a "$READSB_ENV_FILE" >/dev/null
      fi
      sudo systemctl restart readsb
      echo "Done -- readsb now has --db-file configured and was restarted."
    else
      echo "Could not download the aircraft database (offline? GitHub unreachable?) -- skipping." >&2
      echo "You can do this manually later -- see CLAUDE.md for the --db-file steps." >&2
    fi
  fi
else
  echo "No $READSB_ENV_FILE found -- skipping aircraft database setup (is readsb installed?)."
fi

SERVICE_NAME="mlpr@$(whoami).service"
UNIT_SRC="$REPO_ROOT/systemd/mlpr@.service"
UNIT_DST="/etc/systemd/system/mlpr@.service"

echo
echo "Installing systemd unit as $SERVICE_NAME (requires sudo)..."
sudo cp "$UNIT_SRC" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

echo
echo "Done. My Local Plane Radar should now be running and will start on every boot."
echo "  Status: sudo systemctl status $SERVICE_NAME"
echo "  Logs:   journalctl -u $SERVICE_NAME -f"
echo "  Update: git pull && sudo systemctl restart $SERVICE_NAME"
