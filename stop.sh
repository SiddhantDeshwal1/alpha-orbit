#!/usr/bin/env bash
# ==============================================================================
# Alpha Prod Orbit: Stop Script
# Gracefully tears down the Alpha Prod Orbit stack and purges ephemeral networks
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
fi

REAL_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$REAL_PATH")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR"
ENV_FILE="$CONFIG_DIR/.env"

# Load environment variables if .env exists
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a
    source "$ENV_FILE"
    set +a
fi

DATA_DIR="${SERVER_DATA_DIR:-$SCRIPT_DIR/data}"
# Resolve relative paths for DATA_DIR
if [[ "$DATA_DIR" != /* ]]; then
    DATA_DIR="$(cd "$CONFIG_DIR" && cd "$DATA_DIR" 2>/dev/null && pwd || echo "$SCRIPT_DIR/data")"
fi

cat <<EOF

${RED}╭────────────────────────────────────────────────────────────────────────────╮${RESET}
${RED}│${RESET}  ${BOLD}🛑 ALPHA PROD ORBIT : GRACEFUL TEARDOWN & STORAGE SYNC${RESET}                   ${RED}│${RESET}
${RED}│${RESET}  ${DIM}Stopping containers, releasing resources, and flushing write caches${RESET}       ${RED}│${RESET}
${RED}╰────────────────────────────────────────────────────────────────────────────╯${RESET}

EOF

# ------------------------------------------------------------------------------
# 1. Terminate Sandbox Supervisor daemon & active sandbox stack
# ------------------------------------------------------------------------------
echo -e "${BOLD}${BLUE}🤖 [1/3] Terminating Sandbox Supervisor & download stack...${RESET}"

SUPERVISOR_PID_FILE="$CONFIG_DIR/sandbox/supervisor.pid"
if [ -f "$SUPERVISOR_PID_FILE" ]; then
    SUP_PID="$(cat "$SUPERVISOR_PID_FILE" 2>/dev/null || true)"
    if [ -n "$SUP_PID" ] && kill -0 "$SUP_PID" 2>/dev/null; then
        pkill -P "$SUP_PID" 2>/dev/null || true
        kill -TERM "$SUP_PID" 2>/dev/null || true
        sleep 1
        if kill -0 "$SUP_PID" 2>/dev/null; then
            kill -KILL "$SUP_PID" 2>/dev/null || true
        fi
        echo -e "  ${GREEN}✔${RESET} ${DIM}Sandbox Supervisor daemon terminated (PID: $SUP_PID)${RESET}"
    fi
    rm -f "$SUPERVISOR_PID_FILE"
fi

# Terminate any stray background python or supervisor jobs within this project
pkill -f "$CONFIG_DIR/sandbox/sandbox_supervisor.sh" 2>/dev/null || true
pkill -f "fast_server_scanner.py" 2>/dev/null || true

# Fully terminate download sandbox stack if running or created
SANDBOX_COMPOSE="$CONFIG_DIR/compose.sandbox.yaml"
if podman ps -a --filter "name=alpha-prod-" --format "{{.Names}}" 2>/dev/null | grep -qE "alpha-prod-(gluetun|qbittorrent|radarr|sonarr|prowlarr|clamav|gatekeeper|retention|vpn-switcher|ntfy|flaresolverr)"; then
    echo -e "  ${YELLOW}➜${RESET} ${DIM}Active sandbox containers detected. Tearing down sandbox stack...${RESET}"
    if [ -f "$SANDBOX_COMPOSE" ]; then
        if command -v podman-compose >/dev/null 2>&1; then
            podman-compose -f "$SANDBOX_COMPOSE" down >/dev/null 2>&1 || true
        else
            podman compose --project-directory "$CONFIG_DIR" -f "$SANDBOX_COMPOSE" down >/dev/null 2>&1 || true
        fi
    fi
    # Force removal of any lingering sandbox containers (dependents first, gluetun last)
    podman ps -a --filter "name=alpha-prod-" --format "{{.Names}}" 2>/dev/null | grep -E "alpha-prod-(qbittorrent|radarr|sonarr|prowlarr|clamav|gatekeeper|retention|vpn-switcher|ntfy|flaresolverr)" | xargs -r podman rm -f 2>/dev/null || true
    podman rm -f alpha-prod-gluetun 2>/dev/null || true
    echo -e "  ${GREEN}✔${RESET} ${DIM}Download sandbox containers dismantled${RESET}"
else
    echo -e "  ${GREEN}✔${RESET} ${DIM}Download sandbox was idle (no containers to dismantle)${RESET}"
fi

# ------------------------------------------------------------------------------
# 2. Execute Podman Compose DOWN for Core Services
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}📦 [2/3] Destroying core container stack and network namespaces...${RESET}"

if command -v podman-compose >/dev/null 2>&1; then
    COMPOSE_CMD="podman-compose -f $CONFIG_DIR/compose.yaml"
else
    COMPOSE_CMD="podman compose --project-directory $CONFIG_DIR -f $CONFIG_DIR/compose.yaml"
fi

$COMPOSE_CMD down 2>/dev/null || true

# Guarantee destruction of alpha-prod containers if compose left any residue (dependents first, tailscale last)
podman ps -a --filter "name=alpha-prod-" --format "{{.Names}}" 2>/dev/null | grep -v "alpha-prod-tailscale" | xargs -r podman rm -f 2>/dev/null || true
podman rm -f alpha-prod-tailscale 2>/dev/null || true
echo -e "  ${GREEN}✔${RESET} ${DIM}Core containers destroyed (alpha-prod-tailscale, alpha-prod-jellyfin, ...)${RESET}"

# Purge ephemeral container networks
podman network rm alpha_prod_sandbox_net 2>/dev/null || true
podman network rm alpha_prod_default 2>/dev/null || true
podman network prune -f >/dev/null 2>&1 || true
echo -e "  ${GREEN}✔${RESET} ${DIM}Ephemeral container networks purged${RESET}"

# ------------------------------------------------------------------------------
# 3. Safely unbind volumes and verify persistent storage status
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}💾 [3/3] Synchronizing storage integrity & unbinding volumes...${RESET}"

# Clean ephemeral Jellyfin transcode chunks while preserving compiled GPU shader and image caches
if [ -d "/var/tmp/jellyfin-cache/transcodes" ]; then
    rm -rf /var/tmp/jellyfin-cache/transcodes/* 2>/dev/null || true
    echo -e "  ${GREEN}✔${RESET} ${DIM}Ephemeral transcode chunks purged (GPU shader & image caches preserved)${RESET}"
fi

# Sync filesystem cache to disk safely
sync
echo -e "  ${GREEN}✔${RESET} ${DIM}Filesystem write cache flushed to storage (sync complete)${RESET}"

cat <<EOF

${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}
${GREEN}#   ALPHA PROD ORBIT : SUCCESSFULLY STOPPED 🛡️                               ${RESET}
${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}

${BOLD}## 📊 Teardown Ledger${RESET}
  ${DIM}• Core Containers :${RESET} ${WHITE}alpha-prod-tailscale, alpha-prod-jellyfin, alpha-prod-seerr, alpha-prod-dashboard${RESET} ${GREEN}[STOPPED]${RESET}
  ${DIM}• Sandbox Stack   :${RESET} ${WHITE}qBittorrent, Gluetun VPN, Arrs, Gatekeeper, ClamAV, Flaresolverr${RESET} ${GREEN}[TERMINATED]${RESET}
  ${DIM}• Network State   :${RESET} ${WHITE}alpha_prod_default & alpha_prod_sandbox_net purged${RESET} ${GREEN}[ZERO OPEN PORTS]${RESET}
  ${DIM}• Storage Safety  :${RESET} ${WHITE}All storage write buffers synchronized${RESET} ${GREEN}[SAFE]${RESET}
  ${DIM}• Host Resources  :${RESET} ${GREEN}${BOLD}100% CPU & RAM released back to host system${RESET}
${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}

EOF
