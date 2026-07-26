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
