#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Sandbox Stack Startup Script
# Brings up the isolated download pipeline: Gluetun -> qBit -> Radarr/Sonarr/Prowlarr
# -> ClamAV -> Gatekeeper -> Supervisor -> Retention -> VPN Switcher
#
# NEVER run without the core stack (start.sh) already up.
# All download traffic is forced through Gluetun VPN. No IP leak possible.
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
SERVER_DIR="$CONFIG_DIR"

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

echo "=============================================================="
echo " Starting Orbit Server: Sandbox Download Stack               "
echo "=============================================================="

# ------------------------------------------------------------------------------
# 1. Verify security configuration
# ------------------------------------------------------------------------------
echo "[1/5] Verifying security configuration..."

if [ -z "${SWITCHER_API_KEY:-}" ] || [ "${SWITCHER_API_KEY:-}" = "changeme_use_strong_random_token" ]; then
    echo ""
    echo "[!] WARNING: SWITCHER_API_KEY is not configured or still default."
    echo "    Generate a strong key and add it to serverConfig/.env:"
    echo "    SWITCHER_API_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
    echo ""
fi

if [ -z "${PROWLARR_API_KEY:-}" ]; then
    echo "[!] WARNING: PROWLARR_API_KEY not set in environment."
    echo "    Get your API key from: http://localhost:9696/settings/general -> API Key"
    echo ""
fi

if [ -z "${RADARR_API_KEY:-}" ]; then
    echo "[!] WARNING: RADARR_API_KEY not set in environment."
    echo "    Get your API key from: http://localhost:7878/settings/general -> API Key"
    echo ""
fi

if [ -z "${SEERR_API_KEY:-}" ]; then
    echo "[!] WARNING: SEERR_API_KEY not set. Supervisor daemon cannot poll Seerr queue."
    echo "    Get your API key from: http://localhost:5055/profile -> API Key"
    echo ""
fi

if [ -z "${JELLYFIN_API_KEY:-}" ]; then
    echo "[!] WARNING: JELLYFIN_API_KEY not set. Retention engine cannot query Jellyfin."
    echo "    Get your API key from: http://localhost:8096/web -> Dashboard -> API Keys"
    echo ""
fi

# ------------------------------------------------------------------------------
# 2. Create required sandbox storage directories
# ------------------------------------------------------------------------------
echo "[2/5] Verifying sandbox storage directories on Alpha drive..."

# Config directories in serverConfig/sandbox
mkdir -p \
    "$CONFIG_DIR/sandbox/gluetun" \
    "$CONFIG_DIR/sandbox/qbittorrent" \
    "$CONFIG_DIR/sandbox/radarr" \
    "$CONFIG_DIR/sandbox/sonarr" \
    "$CONFIG_DIR/sandbox/prowlarr" \
    "$CONFIG_DIR/sandbox/ntfy"

# Data and log directories in data
mkdir -p \
    "$SERVER_DATA_DIR/seerr/media/download/incomplete" \
    "$SERVER_DATA_DIR/seerr/media/download/staging" \
    "$SERVER_DATA_DIR/seerr/media/download/completed/Movies" \
    "$SERVER_DATA_DIR/seerr/media/download/completed/Series" \
    "$SERVER_DATA_DIR/sandbox/clamav/db" \
    "$SERVER_DATA_DIR/sandbox/logs" \
    "$SERVER_DATA_DIR/sandbox/ntfy"

# Set permissions for rootless container access (PUID/PGID=1000 inside user namespace)
chmod 777 \
    "$SERVER_DATA_DIR/seerr/media/download/incomplete" \
    "$SERVER_DATA_DIR/seerr/media/download/staging" \
    "$SERVER_DATA_DIR/seerr/media/download/completed/Movies" \
    "$SERVER_DATA_DIR/seerr/media/download/completed/Series" \
    "$SERVER_DATA_DIR/sandbox/ntfy" 2>/dev/null || true
podman unshare chmod -R 777 "$SERVER_DATA_DIR/seerr/media/download" 2>/dev/null || true
podman unshare chmod -R 777 "$SERVER_DATA_DIR/sandbox/ntfy" 2>/dev/null || true

# Inject hardened qBittorrent config if not already present
QB_CONF_DIR="$CONFIG_DIR/sandbox/qbittorrent/qBittorrent"
QB_CONF_FILE="$QB_CONF_DIR/qBittorrent.conf"
if [ ! -f "$QB_CONF_FILE" ]; then
    echo "    Injecting hardened qBittorrent config (zero-upload lock)..."
    mkdir -p "$QB_CONF_DIR"
    cp "$SCRIPT_DIR/qbittorrent.conf" "$QB_CONF_FILE"
    echo "    Hardened qBittorrent.conf installed."
fi

echo "[+] Storage directories ready."

# ------------------------------------------------------------------------------
# 3. Ensure Podman socket & default network are active
# ------------------------------------------------------------------------------
echo "[3/5] Ensuring Podman runtime & network infrastructure..."
if ! systemctl --user is-active --quiet podman.socket 2>/dev/null; then
    systemctl --user start podman.socket 2>/dev/null || true
fi

# Guarantee default inter-stack network exists
if [ "$QUADLET_MODE" = true ]; then
    systemctl --user daemon-reload
    for net_unit in alpha_prod_default-network.service alpha_prod_sandbox_net-network.service; do
        systemctl --user start "$net_unit" >/dev/null 2>&1 || true
    done
elif ! podman network exists alpha_prod_default 2>/dev/null; then
    podman network create alpha_prod_default >/dev/null 2>&1 || true
fi
echo "[+] Podman socket & network ready."

# ------------------------------------------------------------------------------
# 4. Bring up sandbox stack
# ------------------------------------------------------------------------------
echo "[4/5] Starting sandbox containers..."

export PODMAN_COMPOSE_WARNING_LOGS=false
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"

if [ "$QUADLET_MODE" = true ]; then
    systemctl --user daemon-reload
    for unit in \
        alpha-prod-gluetun \
        alpha-prod-flaresolverr \
        alpha-prod-qbittorrent \
        alpha-prod-radarr \
        alpha-prod-sonarr \
        alpha-prod-prowlarr \
        alpha-prod-clamav \
        alpha-prod-gatekeeper \
        alpha-prod-retention \
        alpha-prod-vpn-switcher \
        alpha-prod-ntfy; do
        if [ "$unit" = "alpha-prod-flaresolverr" ] && [ ! -f "$QUADLET_SYSTEMD_DIR/alpha-prod-flaresolverr.container" ]; then
            echo "    [!] Skipping $unit (Quadlet unit not installed)"
            continue
        fi
        if ! systemctl --user start "${unit}.service"; then
            if [ "$unit" = "alpha-prod-flaresolverr" ]; then
                echo "    [!] WARNING: Optional unit ${unit}.service failed to start; continuing sandbox startup."
            else
                echo "[!] ERROR: Failed to start Quadlet unit ${unit}.service"
                exit 1
            fi
        fi
    done
else
    if command -v podman-compose >/dev/null 2>&1; then
        COMPOSE_CMD="podman-compose -f $SANDBOX_COMPOSE"
    else
        COMPOSE_CMD="podman compose --project-directory $CONFIG_DIR -f $SANDBOX_COMPOSE"
    fi

    COMPOSE_ERR=$(mktemp)
    if ! $COMPOSE_CMD up -d 2>"$COMPOSE_ERR"; then
        echo "    Detected sandbox container conflicts. Re-aligning sandbox namespaces..."
        podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^(alpha-prod|sandbox)-(qbittorrent|radarr|sonarr|prowlarr|clamav|gatekeeper|retention|vpn-switcher|ntfy|flaresolverr)$" | xargs -r podman rm -f >/dev/null 2>&1 || true
        podman rm -f alpha-prod-gluetun sandbox-gluetun >/dev/null 2>&1 || true
        sleep 1
        if ! $COMPOSE_CMD up -d 2>"$COMPOSE_ERR"; then
            echo "[!] ERROR: Failed to materialize sandbox stack."
            cat "$COMPOSE_ERR"
            rm -f "$COMPOSE_ERR"
            exit 1
        fi
    fi
    rm -f "$COMPOSE_ERR"
fi

echo "[+] Sandbox containers started."

# ------------------------------------------------------------------------------
# 5. Verify Gluetun VPN and ntfy connectivity
# ------------------------------------------------------------------------------
echo "[5/5] Verifying services..."

MAX_ATTEMPTS=20
ATTEMPT=0
VPN_CONNECTED=false
VPN_IP=""

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$(( ATTEMPT + 1 ))
    if podman ps --filter "name=alpha-prod-gluetun" --filter "status=running" --format "{{.Names}}" 2>/dev/null | grep -q "alpha-prod-gluetun"; then
        VPN_IP=$(podman exec alpha-prod-gluetun cat /tmp/gluetun/ip 2>/dev/null || echo "")
        if [ -z "$VPN_IP" ]; then
            VPN_IP=$(curl -sf --max-time 3 "http://127.0.0.1:8000/v1/publicip/ip" 2>/dev/null | jq -r '.public_ip // ""' || echo "")
        fi
        if [ -n "$VPN_IP" ] && [ "$VPN_IP" != "unknown" ]; then
            VPN_CONNECTED=true
            break
        fi
    fi
    echo "    Waiting for Gluetun VPN tunnel... (attempt $ATTEMPT/$MAX_ATTEMPTS)"
    sleep 3
done

# Verify ntfy
NTFY_CONNECTED=false
ATTEMPT=0
while [ $ATTEMPT -lt 10 ]; do
    ATTEMPT=$(( ATTEMPT + 1 ))
    if curl -sf --max-time 2 "http://127.0.0.1:8003/v1/health" 2>/dev/null | grep -q "healthy"; then
        NTFY_CONNECTED=true
        break
    fi
    sleep 2
done

echo ""
echo "=============================================================="
if [ "$VPN_CONNECTED" = true ]; then
    echo "   SANDBOX STACK ONLINE: All traffic routed through VPN"
    echo "=============================================================="
    echo " VPN Public IP        : $VPN_IP (real IP is hidden)"
    echo " qBittorrent WebUI    : http://localhost:8081 (localhost only)"
    echo " Radarr               : http://localhost:7878 (localhost only)"
    echo " Sonarr               : http://localhost:8989 (localhost only)"
    echo " Prowlarr             : http://localhost:9696 (localhost only)"
    echo " VPN Switcher API     : http://127.0.0.1:8001/api/v1/status"
    echo " ntfy Push Service    : $([ "$NTFY_CONNECTED" = true ] && echo "ONLINE" || echo "STARTING")"
    echo " Download Storage     : $SERVER_DATA_DIR/seerr/media/download/"
    echo "--------------------------------------------------------------"
    echo " Kill-Switch          : ENABLED (iptables DROP if VPN drops)"
    echo " IP Leak Protection   : ALL torrent traffic sandboxed in Gluetun"
    echo "=============================================================="
else
    echo " [!] WARNING: Gluetun VPN did not connect within timeout."
    echo "     Check: podman logs alpha-prod-gluetun"
    echo "     Ensure VPN credentials are set in .env"
    echo "     Download containers are UP but MAY NOT be routing through VPN yet."
    echo "     DO NOT start downloads until VPN is confirmed connected."
    echo "=============================================================="
fi
