#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Sandbox Stack Stop Script
# Gracefully tears down the isolated download pipeline.
# Preserves all downloads-in-progress notification in log.
# Flushes disk write buffers before stopping.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$(dirname "$SCRIPT_DIR")"
SANDBOX_COMPOSE="$CONFIG_DIR/compose.sandbox.yaml"
if [ ! -f "$SANDBOX_COMPOSE" ] && [ -f "$SCRIPT_DIR/compose.sandbox.yaml" ]; then
    SANDBOX_COMPOSE="$SCRIPT_DIR/compose.sandbox.yaml"
fi
ENV_FILE="$CONFIG_DIR/.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    ENV_FILE="$SCRIPT_DIR/.env"
fi

# Load environment variables
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

SERVER_DATA_DIR="${SERVER_DATA_DIR:-$CONFIG_DIR/data}"
if [[ "$SERVER_DATA_DIR" != /* ]]; then
    SERVER_DATA_DIR="$(cd "$CONFIG_DIR" && cd "$SERVER_DATA_DIR" 2>/dev/null && pwd || echo "$CONFIG_DIR/data")"
fi

QUADLET_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
QUADLET_MODE=false
if [ -f "$QUADLET_SYSTEMD_DIR/alpha-prod-qbittorrent.container" ]; then
    QUADLET_MODE=true
fi

DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
export DOCKER_HOST

echo "=============================================================="
echo " Stopping Orbit Server: Sandbox Download Stack              "
echo "=============================================================="

# Check for in-progress gatekeeper processes and warn
echo "[1/4] Checking for active sanitization processes..."
if podman ps --filter "name=alpha-prod-gatekeeper" --filter "status=running" --format "{{.Names}}" 2>/dev/null | grep -q "alpha-prod-gatekeeper"; then
    if podman exec alpha-prod-gatekeeper pgrep ffmpeg >/dev/null 2>&1; then
        echo "[!] WARNING: FFmpeg sanitization is currently running!"
        echo "    Waiting 30 seconds to allow current file to finish..."
        sleep 30
    fi
fi
echo "[+] No active sanitization processes."

# Check for active torrents
echo "[2/4] Checking for active downloads..."
ACTIVE_TORRENTS=0
if podman ps --filter "name=alpha-prod-qbittorrent" --filter "status=running" --format "{{.Names}}" 2>/dev/null | grep -q "alpha-prod-qbittorrent"; then
    TORRENT_INFO=$(curl -sf --max-time 5 "http://localhost:8081/api/v2/torrents/info?filter=active" 2>/dev/null || echo "[]")
    ACTIVE_TORRENTS=$(echo "$TORRENT_INFO" | jq '. | length' 2>/dev/null || echo 0)
fi
if [ "$ACTIVE_TORRENTS" -gt 0 ]; then
    echo "[!] WARNING: $ACTIVE_TORRENTS active torrent(s) will be interrupted."
    echo "    They will resume from partial progress on next start."
fi
echo "[+] Active torrents: $ACTIVE_TORRENTS"

# Selective sleep: Stop disk-intensive ingestion workers (protect HDD lifespan)
# Keep Radarr, Sonarr, Prowlarr & Gluetun warm in memory (0% disk I/O, prevents Seerr UI lag)
echo "[3/4] Parking disk-intensive download engines (qBit, ClamAV, Gatekeeper)..."
if [ "$QUADLET_MODE" = true ]; then
    for unit in alpha-prod-qbittorrent alpha-prod-gatekeeper alpha-prod-clamav; do
        systemctl --user stop "${unit}.service" 2>/dev/null || true
    done
else
    podman stop alpha-prod-qbittorrent alpha-prod-gatekeeper alpha-prod-clamav 2>/dev/null || true
fi

# Flush write buffers to Alpha drive
echo "[4/4] Flushing write buffers to Alpha drive..."
sync

echo ""
echo "=============================================================="
echo "      SANDBOX INGESTION WORKERS SAFELY PARKED                "
echo "=============================================================="
echo " Parked units   : qBittorrent, Gatekeeper & ClamAV stopped"
echo " Warm services  : Gluetun VPN, Radarr, Sonarr & Prowlarr remain warm"
echo " VPN & firewall : Gluetun tunnel & iptables kill-switch remain active"
echo " Downloads      : Partial files preserved in incomplete/"
echo " Staging        : $(find "$SERVER_DATA_DIR/seerr/media/download/staging" -mindepth 1 -maxdepth 4 -type f ! -path '*/.*' 2>/dev/null | wc -l) file(s) awaiting gatekeeper on next start"
echo " Completed      : $(find "$SERVER_DATA_DIR/seerr/media/download/completed" -type f 2>/dev/null | wc -l) verified file(s) in library"
echo " Drive          : Write buffers flushed (ingestion disk I/O parked)."
echo "=============================================================="
