#!/usr/bin/env bash
# Runs edge-connector natively on this machine (a Mac Mini, or any macOS/Linux box with Go) as the
# edge server for a stack on another machine, usually the laptop running `pnpm demo:laptop`.
# Natively, not in Docker, so its mDNS announcement reaches the LAN and drones find it on their own.
#
#   bash scripts/run-edge.sh --manager LAPTOP_IP [options]
#
#   --manager HOST|URL  edge-manager, e.g. 192.168.1.20 or http://192.168.1.20:8060 (required)
#   --key KEY           shared edge key (default: $EMBER_EDGE_KEY, else compose's local-dev-edge-key)
#   --public-url URL    URL edge-manager reaches this connector at (default: worked out from the route)
#   --port PORT         drone link and task port (default: 8070)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGER=""
KEY="${EMBER_EDGE_KEY:-local-dev-edge-key}"
PUBLIC_URL=""
PORT=8070

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manager) MANAGER="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$MANAGER" ]] || { echo "--manager is required (the laptop's LAN address)" >&2; exit 1; }
[[ "$MANAGER" == http* ]] || MANAGER="http://$MANAGER:8060"

command -v go >/dev/null 2>&1 || { echo "Go is not installed (macOS: brew install go)" >&2; exit 1; }

log() { printf '\n==> %s\n' "$*"; }

host="${MANAGER#http*://}"
host="${host%%/*}"
log "Checking edge-manager at $MANAGER"
if ! curl -fsS --max-time 3 "$MANAGER/healthz" >/dev/null; then
  echo "cannot reach $MANAGER/healthz: start the laptop first, and allow TCP 8060 through its firewall" >&2
  exit 1
fi

# A stable binary path keeps macOS's firewall approval across runs; go run would ask every time.
OUT="$ROOT/.demo"
mkdir -p "$OUT"
log "Building edge-connector"
(cd "$ROOT" && go build -o "$OUT/edge-connector" ./services/edge-connector/cmd)

export EMBER_EDGE_MANAGER_URL="$MANAGER"
export EMBER_EDGE_KEY="$KEY"
export EMBER_EDGE_ADDR=":$PORT"
# The store holds this edge server's id, so it survives restarts.
export EMBER_EDGE_DB="$OUT/edge-connector.db"
[[ -n "$PUBLIC_URL" ]] && export EMBER_EDGE_PUBLIC_URL="$PUBLIC_URL"

log "edge-connector on :$PORT, uplink to $host; Ctrl+C stops it"
exec "$OUT/edge-connector"
