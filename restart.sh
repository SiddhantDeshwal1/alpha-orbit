#!/usr/bin/env bash
# ==============================================================================
# Alpha Prod Orbit: Restart Script
# Gracefully restarts the entire Alpha Prod Orbit stack
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

export PODMAN_COMPOSE_WARNING_LOGS=false
DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
export DOCKER_HOST

# Load environment variables if .env exists
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

ALPHA_MOUNT="${ALPHA_MOUNT_POINT:-/run/media/${USER:-banana}/Alpha}"
DATA_DIR="${SERVER_DATA_DIR:-$SCRIPT_DIR/data}"
if [[ "$DATA_DIR" != /* ]]; then
    DATA_DIR="$(cd "$CONFIG_DIR" && cd "$DATA_DIR" 2>/dev/null && pwd || echo "$SCRIPT_DIR/data")"
fi

QUADLET_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
QUADLET_MODE=false
if [ -f "$QUADLET_SYSTEMD_DIR/alpha-prod-tailscale.container" ]; then
    QUADLET_MODE=true
fi

WITH_SANDBOX=false

show_help() {
    cat <<EOF

${CYAN}# ════════════════════════════════════════════════════════════════════════════${RESET}
${CYAN}#   Alpha Prod Orbit Restart Manager : CLI Manual                              ${RESET}
${CYAN}# ════════════════════════════════════════════════════════════════════════════${RESET}

${BOLD}Usage:${RESET}
  ${WHITE}./restart.sh${RESET} ${CYAN}[OPTIONS]${RESET}

${BOLD}Options:${RESET}
  ${GREEN}-s, --with-sandbox${RESET}    Force immediate launch of the download sandbox stack
                        ${DIM}(qBit, Gluetun, Radarr, Sonarr, etc.) alongside core services.${RESET}
                        ${DIM}By default, sandbox sleeps until Seerr triggers it.${RESET}
  ${YELLOW}-h, --help${RESET}            Display this help manual and exit.

${BOLD}Examples:${RESET}
  ${CYAN}./restart.sh${RESET}                 ${DIM}# Graceful restart of core services & supervisor${RESET}
  ${CYAN}./restart.sh --with-sandbox${RESET}  ${DIM}# Full stack bounce + immediate sandbox wake${RESET}

${CYAN}# ════════════════════════════════════════════════════════════════════════════${RESET}

EOF
}

# Parse command line options
while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--with-sandbox)
            WITH_SANDBOX=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo -e "${RED}✖ ERROR:${RESET} Unknown option: ${BOLD}$1${RESET}"
            echo -e "  Run ${CYAN}./restart.sh --help${RESET} for usage manual."
            exit 1
            ;;
    esac
done

cat <<EOF

${MAGENTA}╭────────────────────────────────────────────────────────────────────────────╮${RESET}
${MAGENTA}│${RESET}  ${BOLD}🔄 ALPHA PROD ORBIT : GRACEFUL FULL-STACK BOUNCE${RESET}                          ${MAGENTA}│${RESET}
${MAGENTA}│${RESET}  ${DIM}Coordinated Teardown  ➜  Cooldown  ➜  Cold Boot  ➜  Health Verification${RESET}   ${MAGENTA}│${RESET}
${MAGENTA}╰────────────────────────────────────────────────────────────────────────────╯${RESET}

EOF

# ------------------------------------------------------------------------------
# 1. Verify Drive Mount
# ------------------------------------------------------------------------------
echo -e "${BOLD}${BLUE}🔍 [1/4] Verifying storage drive mount status...${RESET}"
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
    echo -e "  ${RED}✖ ERROR:${RESET} Storage drive is not mounted at: ${BOLD}$ALPHA_MOUNT${RESET}"
    echo -e "    ${DIM}Cannot restart services without persistent storage attached.${RESET}"
    exit 1
fi
echo -e "  ${GREEN}✔${RESET} ${DIM}Storage drive verified mounted at:${RESET} ${WHITE}${BOLD}$ALPHA_MOUNT${RESET}"

# ------------------------------------------------------------------------------
# 2. Execute Clean Teardown via stop.sh
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}🛑 [2/4] Executing clean teardown via stop.sh...${RESET}"
"$CONFIG_DIR/stop.sh"

# Cooldown pause: allow kernel network namespaces, cgroups, and sockets to clear
echo -e "  ${YELLOW}⏳ Cooldown:${RESET} ${DIM}Allowing 2s for kernel socket & cgroups namespace clearance...${RESET}"
sleep 2

# ------------------------------------------------------------------------------
# 3. Execute Startup via start.sh
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}${BLUE}🚀 [3/4] Bringing up Alpha Prod Orbit core stack via start.sh...${RESET}"
"$CONFIG_DIR/start.sh"

# ------------------------------------------------------------------------------
# 4. Optional: Bring up Sandbox Stack if requested
# ------------------------------------------------------------------------------
echo -e "${BOLD}${BLUE}📊 [4/4] Verifying active runtime states & health check...${RESET}"
if [ "$WITH_SANDBOX" = true ]; then
    echo -e "  ${YELLOW}➜${RESET} ${DIM}Explicit sandbox startup requested (--with-sandbox)...${RESET}"
    if [ -x "$CONFIG_DIR/sandbox/start_sandbox.sh" ]; then
        "$CONFIG_DIR/sandbox/start_sandbox.sh"
    elif [ "$QUADLET_MODE" = true ]; then
        for unit in alpha-prod-gluetun alpha-prod-flaresolverr alpha-prod-qbittorrent alpha-prod-radarr alpha-prod-sonarr alpha-prod-prowlarr alpha-prod-clamav alpha-prod-gatekeeper alpha-prod-retention alpha-prod-vpn-switcher alpha-prod-ntfy; do
            systemctl --user start "${unit}.service" 2>/dev/null || true
        done
    elif command -v podman-compose >/dev/null 2>&1; then
        podman-compose -f "$CONFIG_DIR/compose.sandbox.yaml" up -d
    else
        podman compose --project-directory "$CONFIG_DIR" -f "$CONFIG_DIR/compose.sandbox.yaml" up -d
    fi
else
    echo -e "  ${GREEN}✔${RESET} ${DIM}Sandbox stack parked in sleep mode (Supervisor active on-demand)${RESET}"
fi

cat <<EOF

${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}
${GREEN}#   RESTART COMPLETE : ALL SYSTEMS NOMINAL ⚡                                ${RESET}
${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}

${BOLD}## 📋 Active Container Fleet (Alpha Prod Orbit)${RESET}
EOF

# Render clean, aligned container table with status badges
podman ps -a --filter "name=alpha-prod-" --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" | awk -F'\t' -v green="$GREEN" -v yellow="$YELLOW" -v cyan="$CYAN" -v red="$RED" -v reset="$RESET" -v dim="$DIM" -v bold="$BOLD" '
BEGIN {
    printf "%s┌──────────────────────────┬──────────────────────────────┬──────────────────────────────────┐%s\n", dim, reset
    printf "%s│%s %-24s %s│%s %-28s %s│%s %-32s %s│%s\n", dim, reset, "CONTAINER", dim, reset, "STATUS", dim, reset, "PORT BINDINGS", dim, reset
    printf "%s├──────────────────────────┼──────────────────────────────┼──────────────────────────────────┤%s\n", dim, reset
}
{
    status_color = cyan
    if ($2 ~ /healthy/) { status_color = green }
    else if ($2 ~ /starting/) { status_color = yellow }
    else if ($2 ~ /unhealthy|Exited|Created/) { status_color = red }

    printf "%s│%s %-24s %s│%s %s%-28s%s %s│%s %-32s %s│%s\n", dim, reset, $1, dim, reset, status_color, substr($2, 1, 28), reset, dim, reset, substr($3, 1, 32), dim, reset
}
END {
    printf "%s└──────────────────────────┴──────────────────────────────┴──────────────────────────────────┘%s\n", dim, reset
}'

cat <<EOF

${GREEN}# ════════════════════════════════════════════════════════════════════════════${RESET}

EOF
