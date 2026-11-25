#!/usr/bin/env bash
# ==============================================================================
# Alpha Prod Orbit: Automated Git Sync & Selective Service Restarter
# Invoked every 2 minutes by alpha-orbit-git-sync.timer.
# Uses flock to serialize runs, aborts safely on local dirty state,
# renders updated Quadlets/units via install-quadlets.sh --sync, and performs
# minimal selective restarts based strictly on changed paths.
# ==============================================================================

set -euo pipefail

REAL_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
QUADLETS_DIR="$(cd "$(dirname "$REAL_PATH")" && pwd)"
CONFIG_DIR="$(dirname "$QUADLETS_DIR")"

log() {
    local level="$1"
    shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '[%s] [GIT-SYNC] [%s] %s\n' "$ts" "$level" "$*"
}

LOCK_DIR="${XDG_RUNTIME_DIR:-/tmp}"
if [ ! -w "$LOCK_DIR" ]; then
    LOCK_DIR="/tmp"
fi
LOCK_FILE="$LOCK_DIR/alpha-orbit-git-sync.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    log "INFO" "Another git-sync instance is already running; skipping."
    exit 0
fi

if [ ! -d "$CONFIG_DIR/.git" ] && ! git -C "$CONFIG_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "ERROR" "$CONFIG_DIR is not a git repository; aborting."
    exit 1
fi

# Never clobber local debugging edits or uncommitted work
if [ -n "$(git -C "$CONFIG_DIR" status --porcelain)" ]; then
    log "WARN" "Local uncommitted changes detected in $CONFIG_DIR; aborting sync safely."
    exit 0
fi

if ! git -C "$CONFIG_DIR" fetch origin main --quiet; then
    log "WARN" "Failed to fetch origin/main (offline or remote unreachable); skipping sync."
    exit 0
fi

LOCAL_SHA="$(git -C "$CONFIG_DIR" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$CONFIG_DIR" rev-parse origin/main)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    exit 0
fi

CHANGED_FILES="$(git -C "$CONFIG_DIR" diff --name-only "$LOCAL_SHA" "$REMOTE_SHA")"
log "INFO" "Upstream update detected (${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7}). Applying..."

git -C "$CONFIG_DIR" reset --hard origin/main --quiet

shopt -s nullglob
for script_file in "$CONFIG_DIR"/*.sh "$CONFIG_DIR"/scripts/*.sh "$CONFIG_DIR"/sandbox/*.sh "$CONFIG_DIR"/sandbox/*.py "$CONFIG_DIR"/quadlets/*.sh; do
    chmod +x "$script_file"
done
shopt -u nullglob

# Re-render Quadlets/units and run daemon-reload preserving active services
"$QUADLETS_DIR/install-quadlets.sh" --sync

restart_tailscale=false
restart_jellyfin=false
restart_seerr=false
restart_dashboard=false
restart_gluetun=false
restart_flaresolverr=false
restart_supervisor=false
try_restart_gatekeeper=false
try_restart_retention=false
try_restart_vpn_switcher=false

while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
        quadlets/core/alpha-prod-tailscale*)
            restart_tailscale=true
            ;;
        jellyfin/index.html|jellyfin/custom-signup-request.js|jellyfin/custom-*.js|jellyfin/config/*|quadlets/core/alpha-prod-jellyfin*)
            restart_jellyfin=true
            ;;
        quadlets/core/alpha-prod-seerr*)
            restart_seerr=true
            ;;
        dashboard/lib/*|dashboard/*|quadlets/core/alpha-prod-dashboard*)
            restart_dashboard=true
            ;;
        quadlets/core/alpha-prod-gluetun*|quadlets/sandbox/alpha-prod-gluetun*)
            restart_gluetun=true
            ;;
        quadlets/core/alpha-prod-flaresolverr*|quadlets/sandbox/alpha-prod-flaresolverr*)
            restart_flaresolverr=true
            ;;
        sandbox/*.sh|sandbox/*.py|quadlets/systemd/alpha-orbit-supervisor*)
            restart_supervisor=true
            try_restart_gatekeeper=true
            try_restart_retention=true
            try_restart_vpn_switcher=true
            ;;
        quadlets/sandbox/alpha-prod-gatekeeper*)
            try_restart_gatekeeper=true
            ;;
        quadlets/sandbox/alpha-prod-retention*)
            try_restart_retention=true
            ;;
        quadlets/sandbox/alpha-prod-vpn-switcher*)
            try_restart_vpn_switcher=true
            ;;
    esac
done <<< "$CHANGED_FILES"

rc=0

restart_unit() {
    local unit="$1"
    log "INFO" "Restarting $unit..."
    if ! systemctl --user restart "$unit"; then
        log "ERROR" "Failed to restart $unit"
        rc=1
    fi
}

try_restart_if_active() {
    local unit="$1"
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
        log "INFO" "Restarting active sandbox service $unit..."
        if ! systemctl --user try-restart "$unit"; then
            log "ERROR" "Failed to try-restart $unit"
            rc=1
        fi
    fi
}

if [ "$restart_tailscale" = true ]; then
    restart_unit alpha-prod-tailscale
else
    if [ "$restart_jellyfin" = true ]; then
        restart_unit alpha-prod-jellyfin
    fi
    if [ "$restart_seerr" = true ]; then
        restart_unit alpha-prod-seerr
    fi
    if [ "$restart_dashboard" = true ]; then
        restart_unit alpha-prod-dashboard
    fi
fi

if [ "$restart_gluetun" = true ]; then
    restart_unit alpha-prod-gluetun
fi
if [ "$restart_flaresolverr" = true ]; then
    restart_unit alpha-prod-flaresolverr
fi

if [ "$restart_supervisor" = true ]; then
    restart_unit alpha-orbit-supervisor.service
fi

if [ "$try_restart_gatekeeper" = true ]; then
    try_restart_if_active alpha-prod-gatekeeper.service
fi
if [ "$try_restart_retention" = true ]; then
    try_restart_if_active alpha-prod-retention.service
fi
if [ "$try_restart_vpn_switcher" = true ]; then
    try_restart_if_active alpha-prod-vpn-switcher.service
fi

exit "$rc"
