#!/usr/bin/env bash
# Sets up a Raspberry Pi (64-bit Raspberry Pi OS / Debian) to run drone-runtime against an edge server.
# Run on the Pi:  curl -fsSL https://raw.githubusercontent.com/RayHCai/ember/master/scripts/setup-pi.sh | bash -s -- [options]
#   or from a checkout:  bash scripts/setup-pi.sh [options]
#
#   --id ID            drone id sent in hello (default: drone-<hostname>)
#   --edge URL|auto    edge-connector WebSocket, e.g. ws://10.0.0.5:8070/v1/drone (default: auto, mDNS)
#   --edge-id ID       with auto, connect only to this edge server
#   --yolo-model PATH  ONNX model; installs onnxruntime and enables YOLO
#   --sensor-url URL   take frames from Demo Data, e.g. ws://10.0.0.5:8090/v1/stream (default: synthetic camera)
#   --dir PATH         checkout location (default: ~/ember)
#   --ref REF          git branch or tag (default: master)
#   --no-service       install only; do not create or start the systemd unit
set -euo pipefail

REPO_URL="${EMBER_REPO_URL:-https://github.com/RayHCai/ember.git}"
DRONE_ID="drone-$(hostname -s)"
EDGE_URL="auto"
EDGE_ID=""
YOLO_MODEL=""
SENSOR_URL=""
DIR="$HOME/ember"
REF="master"
SERVICE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) DRONE_ID="$2"; shift 2 ;;
    --edge) EDGE_URL="$2"; shift 2 ;;
    --edge-id) EDGE_ID="$2"; shift 2 ;;
    --yolo-model) YOLO_MODEL="$2"; shift 2 ;;
    --sensor-url) SENSOR_URL="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }

arch="$(uname -m)"
if [[ "$arch" != "aarch64" ]]; then
  # numpy, scipy and onnxruntime ship wheels for aarch64 only; 32-bit OS would build from source.
  echo "warning: $arch detected; use 64-bit Raspberry Pi OS for prebuilt wheels" >&2
fi

log "Installing system packages"
sudo apt-get update
# avahi gives mDNS so --edge auto can find _ember-edge._tcp; libopenblas backs numpy/scipy.
sudo apt-get install -y --no-install-recommends \
  git curl ca-certificates build-essential avahi-daemon avahi-utils libnss-mdns libopenblas0 chrony
sudo systemctl enable --now avahi-daemon chrony

log "Installing uv"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
UV="$(command -v uv)"

log "Fetching ember ($REF) into $DIR"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch --depth 1 origin "$REF"
  git -C "$DIR" checkout -B "$REF" FETCH_HEAD
else
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR"
fi

log "Installing drone-runtime"
cd "$DIR"
"$UV" python install 3.12
sync_args=(--package ember-drone-runtime --no-dev)
[[ -n "$YOLO_MODEL" ]] && sync_args+=(--extra yolo)
"$UV" sync "${sync_args[@]}"
"$UV" run --package ember-drone-runtime --no-sync drone-runtime --help >/dev/null

ENV_FILE="$DIR/services/drone-runtime/drone.env"
log "Writing $ENV_FILE"
{
  echo "EMBER_DRONE_ID=$DRONE_ID"
  echo "EMBER_EDGE_URL=$EDGE_URL"
  [[ -n "$EDGE_ID" ]] && echo "EMBER_EDGE_ID=$EDGE_ID"
  [[ -n "$YOLO_MODEL" ]] && echo "EMBER_YOLO_MODEL=$YOLO_MODEL"
  [[ -n "$SENSOR_URL" ]] && echo "EMBER_SENSOR_URL=$SENSOR_URL"
} > "$ENV_FILE"

if [[ "$EDGE_URL" == "auto" ]]; then
  log "Looking for edge servers over mDNS (5 s)"
  if command -v avahi-browse >/dev/null 2>&1; then
    timeout 5 avahi-browse -rtp _ember-edge._tcp 2>/dev/null | grep '^=' || echo "none found yet; the drone keeps browsing"
  else
    echo "avahi-utils not installed; skipping (the drone browses on its own)"
  fi
fi

RUN_CMD="$UV run --package ember-drone-runtime --no-sync drone-runtime run"
[[ -n "$SENSOR_URL" ]] && RUN_CMD+=" --camera sensor-stream"

if [[ "$SERVICE" -eq 0 ]]; then
  log "Done. Start it with:"
  echo "  cd $DIR && set -a && . $ENV_FILE && set +a && $RUN_CMD"
  exit 0
fi

log "Installing systemd unit ember-drone.service"
sudo tee /etc/systemd/system/ember-drone.service >/dev/null <<EOF
[Unit]
Description=Ember drone-runtime ($DRONE_ID)
Wants=network-online.target avahi-daemon.service
After=network-online.target avahi-daemon.service

[Service]
User=$(id -un)
WorkingDirectory=$DIR
EnvironmentFile=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=$RUN_CMD
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable ember-drone.service
sudo systemctl restart ember-drone.service

log "Done. drone-runtime is running as $DRONE_ID against edge '$EDGE_URL'"
echo "  logs:    journalctl -u ember-drone -f"
echo "  config:  $ENV_FILE (then: sudo systemctl restart ember-drone)"
