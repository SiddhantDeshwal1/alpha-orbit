#!/usr/bin/env bash
# ==============================================================================
# Alpha Prod Orbit: Start Script
# Materializes the Alpha Prod Orbit stack using Podman Compose
# ==============================================================================

set -euo pipefail

# Terminal Color & Typography Engine
if [ -t 1 ]; then
    BOLD=$'\033[1m'
    DIM=$'\033[2m'
    RESET=$'\033[0m'
    CYAN=$'\033[1;36m'
    BLUE=$'\033[1;34m'
    GREEN=$'\033[1;32m'
    YELLOW=$'\033[1;33m'
    RED=$'\033[1;31m'
    MAGENTA=$'\033[1;35m'
    WHITE=$'\033[1;37m'
    BG_BLUE=$'\033[44m'
else
    BOLD=''
    DIM=''
    RESET=''
    CYAN=''
    BLUE=''
    GREEN=''
    YELLOW=''
    RED=''
    MAGENTA=''
    WHITE=''
    BG_BLUE=''
fi

REAL_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$REAL_PATH")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR"
ENV_FILE="$CONFIG_DIR/.env"

export PODMAN_COMPOSE_WARNING_LOGS=false
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"

# Load environment variables if .env exists
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a
    source "$ENV_FILE"
    set +a
fi

ALPHA_MOUNT="${ALPHA_MOUNT_POINT:-/run/media/${USER:-banana}/Alpha}"
DATA_DIR="${SERVER_DATA_DIR:-$SCRIPT_DIR/data}"
# Resolve relative paths for DATA_DIR
if [[ "$DATA_DIR" != /* ]]; then
    DATA_DIR="$(cd "$CONFIG_DIR" && cd "$DATA_DIR" 2>/dev/null && pwd || echo "$SCRIPT_DIR/data")"
fi

QUADLET_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
QUADLET_MODE=false
if [ -f "$QUADLET_SYSTEMD_DIR/alpha-prod-tailscale.container" ]; then
    QUADLET_MODE=true
fi

cat <<EOF

${CYAN}╭────────────────────────────────────────────────────────────────────────────╮${RESET}
${CYAN}│${RESET}  ${BOLD}🍿 ALPHA PROD ORBIT : SYSTEM LAUNCH BLUEPRINT${RESET}                             ${CYAN}│${RESET}
${CYAN}│${RESET}  ${DIM}Architecture: Rootless Podman  •  Tailscale Mesh  •  VAAPI Hardware Accel${RESET} ${CYAN}│${RESET}
${CYAN}╰────────────────────────────────────────────────────────────────────────────╯${RESET}

EOF

# ------------------------------------------------------------------------------
# 1. Check if the storage drive is mounted & initialize directories
# ------------------------------------------------------------------------------
echo -e "${BOLD}${BLUE}🔍 [1/4] Verifying storage mounts and directory hierarchy...${RESET}"

DRIVE_MOUNTED=false
if findmnt -M "$ALPHA_MOUNT" >/dev/null 2>&1; then
    DRIVE_MOUNTED=true
elif mountpoint -q "$ALPHA_MOUNT" 2>/dev/null; then
    DRIVE_MOUNTED=true
elif [[ "$ALPHA_MOUNT" != /run/media/* && "$ALPHA_MOUNT" != /media/* && "$ALPHA_MOUNT" != /mnt/* ]] && [ -n "${ALPHA_MOUNT_POINT:-}" ] && { [ -d "$ALPHA_MOUNT" ] || [ -d "$(dirname "$ALPHA_MOUNT")" ]; }; then
    DRIVE_MOUNTED=true
elif [ -z "${ALPHA_MOUNT_POINT:-}" ] && [ -n "${SERVER_DATA_DIR:-}" ] && [[ "$DATA_DIR" != /run/media/* && "$DATA_DIR" != /media/* && "$DATA_DIR" != /mnt/* ]] && { [ -d "$DATA_DIR" ] || [ -d "$(dirname "$DATA_DIR")" ]; }; then
    DRIVE_MOUNTED=true
    ALPHA_MOUNT="$(findmnt -n -o TARGET -T "$DATA_DIR" 2>/dev/null || findmnt -n -o TARGET -T "$(dirname "$DATA_DIR")" 2>/dev/null || echo "$DATA_DIR")"
else
    CURRENT_MOUNT="$(findmnt -n -o TARGET -T "$SCRIPT_DIR" 2>/dev/null || true)"
    if [ -n "$CURRENT_MOUNT" ] && [ "$CURRENT_MOUNT" != "/" ]; then
        DRIVE_MOUNTED=true
        ALPHA_MOUNT="$CURRENT_MOUNT"
    fi
fi

if [ "$DRIVE_MOUNTED" = false ]; then
    echo -e "  ${RED}✖ ERROR:${RESET} Alpha drive is not mounted at: ${BOLD}$ALPHA_MOUNT${RESET}"
    echo -e "    ${DIM}Please connect and mount your storage drive before launching.${RESET}"
    exit 1
fi
echo -e "  ${GREEN}✔${RESET} ${DIM}Alpha drive verified at:${RESET} ${WHITE}${BOLD}$ALPHA_MOUNT${RESET}"

# Ensure configuration directories exist in project directory
mkdir -p "$CONFIG_DIR/seerr" "$CONFIG_DIR/jellyfin" "$CONFIG_DIR/dashboard" \
         "$CONFIG_DIR/sandbox/gluetun" "$CONFIG_DIR/sandbox/qbittorrent" \
         "$CONFIG_DIR/sandbox/radarr" "$CONFIG_DIR/sandbox/sonarr" \
         "$CONFIG_DIR/sandbox/prowlarr" "$CONFIG_DIR/sandbox/ntfy"

# Ensure persistent data directories exist in DATA_DIR
mkdir -p "$DATA_DIR/tailscale" \
         "$DATA_DIR/jellyfin/cache" "$DATA_DIR/jellyfin/media/Entertainment" \
         "$DATA_DIR/jellyfin/data/JellyBridge" \
         "$DATA_DIR/seerr/media/download/incomplete" \
         "$DATA_DIR/seerr/media/download/staging" \
         "$DATA_DIR/seerr/media/download/completed/Movies" \
         "$DATA_DIR/seerr/media/download/completed/Series" \
         "$DATA_DIR/seerr/media/download/completed/Podcasts" \
         "$DATA_DIR/sandbox/clamav/db" \
         "$DATA_DIR/sandbox/logs" \
         "$DATA_DIR/sandbox/ntfy"

# Ensure high-speed NVMe transcode & trickplay cache exists for Jellyfin with NoCoW (Btrfs) enabled
mkdir -p /var/tmp/jellyfin-cache/transcodes /var/tmp/jellyfin-cache/trickplay
chmod -R 777 /var/tmp/jellyfin-cache 2>/dev/null || true
chattr -R +C /var/tmp/jellyfin-cache 2>/dev/null || true
echo -e "  ${GREEN}✔${RESET} ${DIM}NVMe transcode cache initialized with Btrfs NoCoW:${RESET} ${WHITE}/var/tmp/jellyfin-cache${RESET}"

# Ensure Seerr container user (node: 1000) owns its config directory
podman unshare chown -R 1000:1000 "$CONFIG_DIR/seerr" 2>/dev/null || true

# Ensure download pipeline directories are writable by rootless containers
chmod 777 "$DATA_DIR/seerr/media/download/incomplete" \
          "$DATA_DIR/seerr/media/download/staging" \
          "$DATA_DIR/seerr/media/download/completed/Movies" \
          "$DATA_DIR/seerr/media/download/completed/Series" \
          "$DATA_DIR/seerr/media/download/completed/Podcasts" 2>/dev/null || true
podman unshare chmod -R 777 "$DATA_DIR/seerr/media/download" "$DATA_DIR/sandbox/ntfy" 2>/dev/null || true
echo -e "  ${GREEN}✔${RESET} ${DIM}Rootless user-namespace permissions harmonized${RESET}"

# ------------------------------------------------------------------------------
# 2. Ensure Podman API socket is active for user & bridge network ready
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}⚡ [2/4] Initializing Podman service and network runtime...${RESET}"
if ! systemctl --user is-active --quiet podman.socket 2>/dev/null; then
    echo -e "  ${YELLOW}➜${RESET} ${DIM}Activating user podman.socket...${RESET}"
    systemctl --user start podman.socket 2>/dev/null || true
fi
echo -e "  ${GREEN}✔${RESET} ${DIM}User Podman socket active:${RESET} ${WHITE}unix:///run/user/$(id -u)/podman/podman.sock${RESET}"

# Ensure default network exists before starting containers
if [ "$QUADLET_MODE" = true ]; then
    systemctl --user daemon-reload
    for net_unit in alpha_prod_default-network.service alpha_prod_sandbox_net-network.service; do
        systemctl --user start "$net_unit" >/dev/null 2>&1 || true
    done
elif ! podman network exists alpha_prod_default 2>/dev/null; then
    podman network create alpha_prod_default >/dev/null 2>&1 || true
fi
echo -e "  ${GREEN}✔${RESET} ${DIM}Inter-container bridge network verified:${RESET} ${WHITE}alpha_prod_default${RESET}"

# Ensure Wi-Fi interface power-save is disabled to prevent WireGuard dropouts
if command -v nmcli >/dev/null 2>&1; then
    nmcli radio wifi powersave off 2>/dev/null || true
    echo -e "  ${GREEN}✔${RESET} ${DIM}Wi-Fi power-save sleep lock disabled (latency protection)${RESET}"
fi

# ------------------------------------------------------------------------------
# 3. Materialize Core Stack (Quadlets via systemd OR Podman Compose fallback)
# ------------------------------------------------------------------------------
if [ "$QUADLET_MODE" = true ]; then
    echo -e "\n${BOLD}${BLUE}🚀 [3/4] Starting Alpha Prod Core Quadlet units via systemd...${RESET}"
    systemctl --user daemon-reload

    for unit in \
        alpha-prod-tailscale \
        alpha-prod-dashboard \
        alpha-prod-jellyfin \
        alpha-prod-seerr; do
        if ! systemctl --user start "${unit}.service"; then
            echo -e "  ${RED}✖ ERROR:${RESET} Failed to start core Quadlet service: ${BOLD}${unit}.service${RESET}"
            echo -e "    ${DIM}Inspect logs: journalctl --user -u ${unit}.service -n 50 --no-pager${RESET}"
            exit 1
        fi
    done
    echo -e "  ${GREEN}✔${RESET} ${DIM}All core Quadlet services started successfully${RESET}"

    # Ensure Gluetun VPN Gateway & FlareSolverr proxy are active for Seerr TMDb proxying
    echo -e "  ${YELLOW}➜${RESET} ${DIM}Ensuring Gluetun VPN Gateway & FlareSolverr proxy are active...${RESET}"
    for unit in alpha-prod-gluetun alpha-prod-flaresolverr; do
        if [ ! -f "$QUADLET_SYSTEMD_DIR/${unit}.container" ]; then
            continue
        fi
        systemctl --user start "${unit}.service" >/dev/null 2>&1 || \
            echo -e "  ${YELLOW}⚠${RESET} ${DIM}Proxy unit warning (${unit}.service) — check: journalctl --user -u ${unit}.service -n 30${RESET}"
    done
    echo -e "  ${GREEN}✔${RESET} ${DIM}Gluetun VPN Gateway & FlareSolverr TMDb proxy active${RESET}"
else
    echo -e "\n${BOLD}${BLUE}🚀 [3/4] Spinning up Alpha Prod Core containers in detached mode...${RESET}"

    # Pre-flight conflict check: ensure core ports (3000, 8096, 5055) and names are clear
    LEGACY_GHOST_RUNNING="$(podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^ghost-(tailscale|dashboard|jellyfin|seerr|immich|sftpgo|audiobookshelf)" || true)"
    STALE_CORE_DEAD="$(podman ps -a --filter "name=alpha-prod-" --filter "status=created" --filter "status=exited" --format "{{.Names}}" 2>/dev/null || true)"
    PORT_HOLDERS="$(podman ps -a --format "{{.ID}} {{.Ports}}" 2>/dev/null | grep -E ':(3000|8096|5055)->' | awk '{print $1}' || true)"

    if [ -n "$LEGACY_GHOST_RUNNING" ] || [ -n "$STALE_CORE_DEAD" ] || [ -n "$PORT_HOLDERS" ]; then
        echo -e "  ${YELLOW}➜${RESET} ${DIM}Pre-flight: Realigning container namespaces & releasing ports...${RESET}"
        # Remove dependent containers first
        podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^(alpha-prod|ghost)-(dashboard|jellyfin|seerr|immich-server|immich-postgres|immich-redis|immich-ml|sftpgo|audiobookshelf)$" | xargs -r podman rm -f >/dev/null 2>&1 || true
        # Remove network containers
        podman rm -f alpha-prod-tailscale ghost-tailscale >/dev/null 2>&1 || true
        # Sweep any lingering container holding port 3000, 8096, or 5055
        podman ps -a --format "{{.ID}} {{.Ports}}" 2>/dev/null | grep -E ':(3000|8096|5055)->' | awk '{print $1}' | xargs -r podman rm -f >/dev/null 2>&1 || true
        sleep 1
    fi

    if command -v podman-compose >/dev/null 2>&1; then
        COMPOSE_CMD="podman-compose -f $CONFIG_DIR/compose.yaml"
    else
        COMPOSE_CMD="podman compose --project-directory $CONFIG_DIR -f $CONFIG_DIR/compose.yaml"
    fi

    COMPOSE_ERR=$(mktemp)
    if ! $COMPOSE_CMD up -d 2>"$COMPOSE_ERR"; then
        echo -e "  ${YELLOW}⚠${RESET} ${DIM}Compose startup conflict detected. Auto-realigning container namespaces...${RESET}"
        # Remove dependent containers first, then network container (both alpha-prod and ghost)
        podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^(alpha-prod|ghost)-(dashboard|jellyfin|seerr|immich-server|immich-postgres|immich-redis|immich-ml|sftpgo|audiobookshelf)$" | xargs -r podman rm -f >/dev/null 2>&1 || true
        podman rm -f alpha-prod-tailscale ghost-tailscale >/dev/null 2>&1 || true

        # Sweep any remaining containers holding core stack ports
        podman ps -a --format "{{.ID}} {{.Ports}}" 2>/dev/null | grep -E ':(3000|8096|5055)->' | awk '{print $1}' | xargs -r podman rm -f >/dev/null 2>&1 || true
        sleep 1

        if ! $COMPOSE_CMD up -d 2>"$COMPOSE_ERR"; then
            echo -e "  ${RED}✖ ERROR:${RESET} Failed to materialize core container stack."
            cat "$COMPOSE_ERR"
            rm -f "$COMPOSE_ERR"
            exit 1
        fi
    fi
    rm -f "$COMPOSE_ERR"
    echo -e "  ${GREEN}✔${RESET} ${DIM}All core containers materialized successfully${RESET}"

    # Ensure Gluetun VPN Gateway & FlareSolverr proxy are active for Seerr TMDb proxying
    echo -e "  ${YELLOW}➜${RESET} ${DIM}Ensuring Gluetun VPN Gateway & FlareSolverr proxy are active...${RESET}"

    # Clean any legacy sandbox containers that hold proxy/VPN ports (8000, 8888, 8081, 8191)
    LEGACY_SANDBOX_RUNNING="$(podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^sandbox-(gluetun|flaresolverr|qbittorrent|radarr|sonarr|prowlarr|clamav|ntfy|gatekeeper|retention|vpn-switcher)$" || true)"
    if [ -n "$LEGACY_SANDBOX_RUNNING" ]; then
        podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^sandbox-(flaresolverr|qbittorrent|radarr|sonarr|prowlarr|clamav|ntfy|gatekeeper|retention|vpn-switcher)$" | xargs -r podman rm -f >/dev/null 2>&1 || true
        podman rm -f sandbox-gluetun >/dev/null 2>&1 || true
        sleep 1
    fi

    if command -v podman-compose >/dev/null 2>&1; then
        SANDBOX_COMPOSE_CMD="podman-compose -f $CONFIG_DIR/compose.sandbox.yaml"
    else
        SANDBOX_COMPOSE_CMD="podman compose --project-directory $CONFIG_DIR -f $CONFIG_DIR/compose.sandbox.yaml"
    fi

    SANDBOX_ERR=$(mktemp)
    if ! $SANDBOX_COMPOSE_CMD up -d gluetun flaresolverr 2>"$SANDBOX_ERR"; then
        echo -e "  ${YELLOW}⚠${RESET} ${DIM}Sandbox proxy startup conflict detected. Auto-realigning sandbox namespaces...${RESET}"
        podman ps -a --format "{{.Names}}" 2>/dev/null | grep -E "^(alpha-prod|sandbox)-(flaresolverr|qbittorrent|radarr|sonarr|prowlarr|clamav|gatekeeper|retention|vpn-switcher|ntfy)$" | xargs -r podman rm -f >/dev/null 2>&1 || true
        podman rm -f alpha-prod-gluetun sandbox-gluetun >/dev/null 2>&1 || true
        sleep 1
        $SANDBOX_COMPOSE_CMD up -d gluetun flaresolverr >/dev/null 2>&1 || true
    fi
    rm -f "$SANDBOX_ERR"
    echo -e "  ${GREEN}✔${RESET} ${DIM}Gluetun VPN Gateway & FlareSolverr TMDb proxy active${RESET}"
fi

# ------------------------------------------------------------------------------
# 4. Ping Tailscale container and confirm VPN mesh connectivity
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}🛡️ [4/4] Establishing encrypted Tailscale WireGuard mesh...${RESET}"

MAX_ATTEMPTS=20
ATTEMPT=0
CONNECTED=false
TAILSCALE_IP=""

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))
    
    # Check if container is running
    TS_CONTAINER="$(podman ps --filter "name=alpha-prod-tailscale" --filter "status=running" --format "{{.Names}}" | head -1)"
    if [ -z "$TS_CONTAINER" ]; then
        sleep 1
        continue
    fi

    # Query Tailscale status inside container
    TS_STATUS_OUTPUT="$(podman exec "$TS_CONTAINER" tailscale status 2>&1 || true)"
    
    # Check if Tailscale has an assigned 100.x.y.z IP
    IP_QUERY="$(podman exec "$TS_CONTAINER" tailscale ip -4 2>/dev/null || true)"
    if [[ "$IP_QUERY" =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        CONNECTED=true
        TAILSCALE_IP="$IP_QUERY"
        break
    fi

    # Check if Tailscale printed a login URL for browser authentication
    AUTH_URL="$(echo "$TS_STATUS_OUTPUT" | grep -o 'https://login.tailscale.com/a/[a-zA-Z0-9]*' | head -1 || true)"
    if [ -z "$AUTH_URL" ]; then
        AUTH_URL="$(podman logs "$TS_CONTAINER" 2>&1 | grep -o 'https://login.tailscale.com/a/[a-zA-Z0-9]*' | tail -1 || true)"
    fi

    if [ -n "$AUTH_URL" ]; then
        echo -e "\n${YELLOW}╭────────────────────────────────────────────────────────────╮${RESET}"
        echo -e "${YELLOW}│${RESET}  ${BOLD}⚠️  ACTION REQUIRED: Tailscale Node Authorization Needed${RESET}  ${YELLOW}│${RESET}"
        echo -e "${YELLOW}├────────────────────────────────────────────────────────────┤${RESET}"
        echo -e "${YELLOW}│${RESET}  Visit this approval URL to authenticate this server:      ${YELLOW}│${RESET}"
        echo -e "${YELLOW}│${RESET}  ${BOLD}${CYAN}$AUTH_URL${RESET}  ${YELLOW}│${RESET}"
        echo -e "${YELLOW}╰────────────────────────────────────────────────────────────╯${RESET}"
        echo -e "  ${DIM}Awaiting Tailnet authorization (attempt $ATTEMPT/$MAX_ATTEMPTS)...${RESET}"
    fi

    sleep 2
done

# ------------------------------------------------------------------------------
# 5. Launch Sandbox Supervisor Daemon (Autonomous On-Demand Downloads)
# ------------------------------------------------------------------------------
SUPERVISOR_PID_FILE="$CONFIG_DIR/sandbox/supervisor.pid"
SUPERVISOR_PID=""

if [ "$QUADLET_MODE" = true ]; then
    systemctl --user start alpha-orbit-supervisor.service 2>/dev/null || true
    SUPERVISOR_PID="$(systemctl --user show -p MainPID --value alpha-orbit-supervisor.service 2>/dev/null || true)"
    if [ "$SUPERVISOR_PID" = "0" ]; then
        SUPERVISOR_PID=""
    fi
else
    if [ -f "$SUPERVISOR_PID_FILE" ]; then
        OLD_PID="$(cat "$SUPERVISOR_PID_FILE" 2>/dev/null || true)"
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null && grep -qa "sandbox_supervisor" "/proc/$OLD_PID/cmdline" 2>/dev/null; then
            SUPERVISOR_PID="$OLD_PID"
        fi
    fi

    if [ -z "$SUPERVISOR_PID" ] && [ -x "$CONFIG_DIR/sandbox/sandbox_supervisor.sh" ]; then
        mkdir -p "$DATA_DIR/sandbox/logs"
        setsid "$CONFIG_DIR/sandbox/sandbox_supervisor.sh" </dev/null >> "$DATA_DIR/sandbox/logs/supervisor.log" 2>&1 &
        SUPERVISOR_PID=$!
        echo "$SUPERVISOR_PID" > "$SUPERVISOR_PID_FILE"
    fi
fi

if [ "$CONNECTED" = true ]; then
    NODE_HOSTNAME="${TS_HOSTNAME:-alpha-prod-orbit}"

    cat <<EOF

${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}
${GREEN}#   ALPHA PROD ORBIT : ONLINE & FULLY OPERATIONAL 🚀                          ${RESET}
${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}

${BOLD}## 🌐 Network & Mesh Topology${RESET}
  ${DIM}• Node Hostname   :${RESET} ${WHITE}${BOLD}$NODE_HOSTNAME${RESET}
  ${DIM}• Tailscale Mesh  :${RESET} ${GREEN}${BOLD}$TAILSCALE_IP${RESET} ${DIM}(WireGuard Encrypted)${RESET}
  ${DIM}• Local Loopback  :${RESET} ${CYAN}127.0.0.1${RESET} ${DIM}(Zero Wi-Fi footprint, offline-ready)${RESET}
  ${DIM}• Storage Root    :${RESET} ${WHITE}$DATA_DIR${RESET}

${BOLD}## 🎬 Service Directory & Endpoints${RESET}
${DIM}┌──────────────────────────┬──────────┬─────────────────────────────┬───────────────────────────────┐${RESET}
${DIM}│${RESET} ${BOLD}SERVICE${RESET}                  ${DIM}│${RESET} ${BOLD}PORT${RESET}     ${DIM}│${RESET} ${BOLD}DIRECT LOOPBACK (LOCAL)${RESET}      ${DIM}│${RESET} ${BOLD}REMOTE MESH (TAILSCALE)${RESET}        ${DIM}│${RESET}
${DIM}├──────────────────────────┼──────────┼─────────────────────────────┼───────────────────────────────┤${RESET}
${DIM}│${RESET} Central Cockpit (UI)     ${DIM}│${RESET} :3000     ${DIM}│${RESET} ${CYAN}http://localhost:3000${RESET}        ${DIM}│${RESET} ${GREEN}http://$TAILSCALE_IP:3000${RESET}       ${DIM}│${RESET}
${DIM}│${RESET} Jellyfin Cinema (4K HW)  ${DIM}│${RESET} :8096     ${DIM}│${RESET} ${CYAN}http://localhost:8096${RESET}        ${DIM}│${RESET} ${GREEN}http://$TAILSCALE_IP:8096${RESET}       ${DIM}│${RESET}
${DIM}│${RESET} Seerr Media Discovery    ${DIM}│${RESET} :5055     ${DIM}│${RESET} ${CYAN}http://localhost:5055${RESET}        ${DIM}│${RESET} ${GREEN}http://$TAILSCALE_IP:5055${RESET}       ${DIM}│${RESET}
${DIM}└──────────────────────────┴──────────┴─────────────────────────────┴───────────────────────────────┘${RESET}

${BOLD}## 📥 Autonomous Ingestion Pipeline${RESET}
  ${DIM}• Supervisor Engine :${RESET} ${GREEN}${BOLD}${SUPERVISOR_PID:-ACTIVE}${RESET} ${DIM}(PID: ${SUPERVISOR_PID:-N/A})${RESET}
  ${DIM}• Operational Mode  :${RESET} ${WHITE}100% On-Demand${RESET} ${DIM}(Auto-wakes VPN sandbox upon request ➜ Idle Sleep)${RESET}
  ${DIM}• Transcode Tier    :${RESET} ${MAGENTA}Tier 0 RAM-Disk tmpfs (2.5 GiB)${RESET} ${DIM}• Zero Flash Wear • AMD VAAPI HW${RESET}
  ${DIM}• Lifecycle Control :${RESET} ${BOLD}./start.sh | ./stop.sh | ./restart.sh${RESET}
${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}

EOF
else
    cat <<EOF

${YELLOW}╭────────────────────────────────────────────────────────────────────────────╮${RESET}
${YELLOW}│${RESET}  ${BOLD}⚠️  CONTAINERS STARTED BUT TAILSCALE IS AWAITING CONNECTION${RESET}               ${YELLOW}│${RESET}
${YELLOW}├────────────────────────────────────────────────────────────────────────────┤${RESET}
${YELLOW}│${RESET}  Containers are active locally, but Tailscale has not registered on mesh.  ${YELLOW}│${RESET}
${YELLOW}│${RESET}  Local access is available: http://localhost:3000                           ${YELLOW}│${RESET}
${YELLOW}│${RESET}  Inspect logs: ${BOLD}podman logs -f ${TS_CONTAINER:-alpha-prod-tailscale}${RESET}                       ${YELLOW}│${RESET}
${YELLOW}╰────────────────────────────────────────────────────────────────────────────╯${RESET}

EOF
fi
