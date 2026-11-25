#!/usr/bin/env bash
# ==============================================================================
# Alpha Prod Orbit: Quadlet & Systemd User Unit Renderer / Installer
# Renders *.tmpl Quadlets and systemd user units/drop-ins, generates
# alpha-orbit-mapped.env (0600), initializes host directories, and optionally
# reloads/enables/starts the systemd user services.
# ==============================================================================

set -euo pipefail

REAL_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
QUADLETS_DIR="$(cd "$(dirname "$REAL_PATH")" && pwd)"
CONFIG_DIR="$(dirname "$QUADLETS_DIR")"
ENV_FILE="$CONFIG_DIR/.env"

MODE="install"
RENDER_DIR=""

log() {
    local level="$1"
    shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '[%s] [INSTALL-QUADLETS] [%s] %s\n' "$ts" "$level" "$*"
}

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --render-only         Render Quadlet/systemd templates and mapped env file
                        without invoking systemctl, podman unshare, or creating
                        host runtime directories.
  --render-dir <DIR>    Override target base config dir (equivalent to setting
                        XDG_CONFIG_HOME=<DIR>; default: \${XDG_CONFIG_HOME:-\$HOME/.config}).
  --sync                Render templates, ensure directories exist, and run
                        'systemctl --user daemon-reload' preserving running state.
  -h, --help            Show this help message and exit.

Default (no mode flags):
  Full initial install: verify mount, create runtime dirs, copy hardened
  qbittorrent.conf if absent, harmonize rootless permissions, render templates,
  daemon-reload, enable socket/timers/supervisor, and start Core Quadlets + Supervisor.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --render-only)
            if [ "$MODE" = "sync" ]; then
                log "ERROR" "--render-only and --sync are mutually exclusive."
                exit 1
            fi
            MODE="render-only"
            shift
            ;;
        --sync)
            if [ "$MODE" = "render-only" ]; then
                log "ERROR" "--render-only and --sync are mutually exclusive."
                exit 1
            fi
            MODE="sync"
            shift
            ;;
        --render-dir)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                log "ERROR" "--render-dir requires a directory argument."
                exit 1
            fi
            RENDER_DIR="$2"
            shift 2
            ;;
        --render-dir=*)
            RENDER_DIR="${1#--render-dir=}"
            if [ -z "$RENDER_DIR" ]; then
                log "ERROR" "--render-dir requires a non-empty directory."
                exit 1
            fi
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log "ERROR" "Unknown option: $1"
            usage >&2
            exit 1
            ;;
    esac
done

# Load .env if present
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
elif [ "$MODE" = "install" ]; then
    log "WARN" "$ENV_FILE not found; using defaults for template rendering and mapped env."
fi

resolve_path() {
    local raw_path="$1"
    local abs_input
    if [[ "$raw_path" == /* ]]; then
        abs_input="$raw_path"
    else
        abs_input="$CONFIG_DIR/$raw_path"
    fi
    if command -v realpath >/dev/null 2>&1; then
        realpath -m "$abs_input"
    elif command -v readlink >/dev/null 2>&1; then
        readlink -m "$abs_input"
    else
        echo "$abs_input"
    fi
}

DATA_DIR="$(resolve_path "${SERVER_DATA_DIR:-$CONFIG_DIR/data}")"
MOUNT_POINT="$(resolve_path "${ALPHA_MOUNT_POINT:-$DATA_DIR}")"
GHCR_DASHBOARD_IMAGE="${GHCR_DASHBOARD_IMAGE:-ghcr.io/your-github-username/alpha-prod-dashboard:latest}"
FLARESOLVERR_IMAGE="${FLARESOLVERR_IMAGE:-ghcr.io/flaresolverr/flaresolverr:latest}"
TS_HOSTNAME="${TS_HOSTNAME:-alpha-prod-orbit}"

CONFIG_BASE="${RENDER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}}"
QUADLET_DEST_DIR="$CONFIG_BASE/containers/systemd"
SYSTEMD_DEST_DIR="$CONFIG_BASE/systemd/user"
MAPPED_ENV_FILE="$QUADLET_DEST_DIR/alpha-orbit-mapped.env"

escape_sed() {
    printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

render_template() {
    local src="$1"
    local dest="$2"
    mkdir -p "$(dirname "$dest")"

    local tmp_dest
    tmp_dest="$(mktemp "$(dirname "$dest")/.tmp.XXXXXX")"

    if command -v python3 >/dev/null 2>&1; then
        SRC_PATH="$src" DEST_PATH="$tmp_dest" \
        R_APP_DIR="$CONFIG_DIR" \
        R_DATA_DIR="$DATA_DIR" \
        R_MOUNT_POINT="$MOUNT_POINT" \
        R_GHCR_DASHBOARD_IMAGE="$GHCR_DASHBOARD_IMAGE" \
        R_FLARESOLVERR_IMAGE="$FLARESOLVERR_IMAGE" \
        R_TS_HOSTNAME="$TS_HOSTNAME" \
        python3 - <<'PYEOF'
import os

with open(os.environ["SRC_PATH"], "r", encoding="utf-8") as fh:
    content = fh.read()

replacements = (
    ("__APP_DIR__", os.environ["R_APP_DIR"]),
    ("__DATA_DIR__", os.environ["R_DATA_DIR"]),
    ("__MOUNT_POINT__", os.environ["R_MOUNT_POINT"]),
    ("__GHCR_DASHBOARD_IMAGE__", os.environ["R_GHCR_DASHBOARD_IMAGE"]),
    ("__FLARESOLVERR_IMAGE__", os.environ["R_FLARESOLVERR_IMAGE"]),
    ("__TS_HOSTNAME__", os.environ["R_TS_HOSTNAME"]),
)
for placeholder, value in replacements:
    content = content.replace(placeholder, value)

with open(os.environ["DEST_PATH"], "w", encoding="utf-8") as fh:
    fh.write(content)
PYEOF
    else
        local esc_app esc_data esc_mount esc_dash esc_flare esc_ts
        esc_app="$(escape_sed "$CONFIG_DIR")"
        esc_data="$(escape_sed "$DATA_DIR")"
        esc_mount="$(escape_sed "$MOUNT_POINT")"
        esc_dash="$(escape_sed "$GHCR_DASHBOARD_IMAGE")"
        esc_flare="$(escape_sed "$FLARESOLVERR_IMAGE")"
        esc_ts="$(escape_sed "$TS_HOSTNAME")"
        sed -e "s|__APP_DIR__|${esc_app}|g" \
            -e "s|__DATA_DIR__|${esc_data}|g" \
            -e "s|__MOUNT_POINT__|${esc_mount}|g" \
            -e "s|__GHCR_DASHBOARD_IMAGE__|${esc_dash}|g" \
            -e "s|__FLARESOLVERR_IMAGE__|${esc_flare}|g" \
            -e "s|__TS_HOSTNAME__|${esc_ts}|g" \
            "$src" > "$tmp_dest"
    fi

    chmod 644 "$tmp_dest"
    mv -f "$tmp_dest" "$dest"
}

generate_mapped_env() {
    mkdir -p "$QUADLET_DEST_DIR"
    local tmp_env
    tmp_env="$(umask 077 && mktemp "$QUADLET_DEST_DIR/.alpha-orbit-mapped.env.XXXXXX")"
    chmod 600 "$tmp_env"
    cat >"$tmp_env" <<EOF
# Auto-generated by quadlets/install-quadlets.sh — do not edit manually
VPN_SERVICE_PROVIDER=${GLUETUN_VPN_PROVIDER:-${VPN_SERVICE_PROVIDER:-custom}}
VPN_TYPE=${GLUETUN_VPN_TYPE:-${VPN_TYPE:-wireguard}}
WIREGUARD_PRIVATE_KEY=${WARP_PRIVATE_KEY:-${WIREGUARD_PRIVATE_KEY:-}}
WIREGUARD_ADDRESSES=${WARP_ADDRESS:-${WIREGUARD_ADDRESSES:-172.16.0.2/32}}
WIREGUARD_PUBLIC_KEY=${WARP_PUBLIC_KEY:-${WIREGUARD_PUBLIC_KEY:-bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=}}
WIREGUARD_ENDPOINT_IP=${WARP_ENDPOINT_IP:-${WIREGUARD_ENDPOINT_IP:-162.159.192.5}}
WIREGUARD_ENDPOINT_PORT=${WARP_ENDPOINT_PORT:-${WIREGUARD_ENDPOINT_PORT:-2408}}
VPN_ENDPOINT_IP=${WARP_ENDPOINT_IP:-${VPN_ENDPOINT_IP:-162.159.192.5}}
VPN_ENDPOINT_PORT=${WARP_ENDPOINT_PORT:-${VPN_ENDPOINT_PORT:-2408}}
OPENVPN_USER=${PROTON_USER:-${OPENVPN_USER:-}}
OPENVPN_PASSWORD=${PROTON_PASS:-${OPENVPN_PASSWORD:-}}
WINDSCRIBE_USERNAME=${WINDSCRIBE_USER:-${WINDSCRIBE_USERNAME:-}}
WINDSCRIBE_PASSWORD=${WINDSCRIBE_PASS:-${WINDSCRIBE_PASSWORD:-}}
MULLVAD_PRIVATE_KEY=${MULLVAD_PRIVATE_KEY:-}
MULLVAD_ADDRESSES=${MULLVAD_ADDRESSES:-}
AIRVPN_KEY=${AIRVPN_KEY:-}
EOF
    chmod 600 "$tmp_env"
    mv -f "$tmp_env" "$MAPPED_ENV_FILE"
    chmod 600 "$MAPPED_ENV_FILE"
    log "INFO" "Generated mapped environment file: $MAPPED_ENV_FILE (mode 0600)"
}

RENDERED_QUADLETS=0
RENDERED_SYSTEMD=0

render_all_templates() {
    mkdir -p "$QUADLET_DEST_DIR" "$SYSTEMD_DEST_DIR"

    local subdir src_root src_file rel_path dest_rel
    for subdir in networks core sandbox; do
        src_root="$QUADLETS_DIR/$subdir"
        [ -d "$src_root" ] || continue
        while IFS= read -r -d '' src_file; do
            rel_path="${src_file#"$src_root"/}"
            case "$rel_path" in
                *.container|*.container.tmpl|\
                *.network|*.network.tmpl|\
                *.volume|*.volume.tmpl|\
                *.pod|*.pod.tmpl|\
                *.image|*.image.tmpl|\
                *.kube|*.kube.tmpl|\
                *.build|*.build.tmpl|\
                *.artifact|*.artifact.tmpl|\
                *.conf|*.conf.tmpl|\
                *.env|*.env.tmpl)
                    dest_rel="${rel_path%.tmpl}"
                    render_template "$src_file" "$QUADLET_DEST_DIR/$dest_rel"
                    RENDERED_QUADLETS=$((RENDERED_QUADLETS + 1))
                    ;;
            esac
        done < <(find "$src_root" -type f -print0 | sort -z)
    done

    src_root="$QUADLETS_DIR/systemd"
    if [ -d "$src_root" ]; then
        while IFS= read -r -d '' src_file; do
            rel_path="${src_file#"$src_root"/}"
            case "$rel_path" in
                *.service|*.service.tmpl|\
                *.timer|*.timer.tmpl|\
                *.target|*.target.tmpl|\
                *.socket|*.socket.tmpl|\
                *.path|*.path.tmpl|\
                *.conf|*.conf.tmpl)
                    dest_rel="${rel_path%.tmpl}"
                    render_template "$src_file" "$SYSTEMD_DEST_DIR/$dest_rel"
                    RENDERED_SYSTEMD=$((RENDERED_SYSTEMD + 1))
                    ;;
            esac
        done < <(find "$src_root" -type f -print0 | sort -z)
    fi

    log "INFO" "Rendered $RENDERED_QUADLETS Quadlet file(s) -> $QUADLET_DEST_DIR"
    log "INFO" "Rendered $RENDERED_SYSTEMD systemd unit/drop-in file(s) -> $SYSTEMD_DEST_DIR"
}

verify_storage_mount() {
    if [ -n "${ALPHA_MOUNT_POINT:-}" ] && [[ "$MOUNT_POINT" == /run/media/* || "$MOUNT_POINT" == /mnt/* ]]; then
        local target_fs=""
        target_fs="$(findmnt -n -o TARGET -T "$MOUNT_POINT" 2>/dev/null || true)"
        if ! findmnt -M "$MOUNT_POINT" >/dev/null 2>&1 && ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
            if [ -z "$target_fs" ] || [ "$target_fs" = "/" ]; then
                log "ERROR" "External storage mount point is not mounted: $MOUNT_POINT"
                exit 1
            fi
        fi
    fi
}

ensure_directories() {
    mkdir -p \
        "$CONFIG_DIR/seerr" \
        "$CONFIG_DIR/jellyfin" \
        "$CONFIG_DIR/dashboard" \
        "$CONFIG_DIR/sandbox/gluetun" \
        "$CONFIG_DIR/sandbox/qbittorrent" \
        "$CONFIG_DIR/sandbox/radarr" \
        "$CONFIG_DIR/sandbox/sonarr" \
        "$CONFIG_DIR/sandbox/prowlarr" \
        "$CONFIG_DIR/sandbox/ntfy/cache"

    mkdir -p \
        "$DATA_DIR/tailscale" \
        "$DATA_DIR/jellyfin/cache" \
        "$DATA_DIR/jellyfin/media/Entertainment" \
        "$DATA_DIR/jellyfin/data/JellyBridge" \
        "$DATA_DIR/seerr/media/download/incomplete" \
        "$DATA_DIR/seerr/media/download/staging" \
        "$DATA_DIR/seerr/media/download/completed/Movies" \
        "$DATA_DIR/seerr/media/download/completed/Series" \
        "$DATA_DIR/seerr/media/download/completed/Podcasts" \
        "$DATA_DIR/sandbox/clamav/db" \
        "$DATA_DIR/sandbox/logs" \
        "$DATA_DIR/sandbox/ntfy"

    mkdir -p /var/tmp/jellyfin-cache/transcodes /var/tmp/jellyfin-cache/trickplay

    local qb_conf_dir="$CONFIG_DIR/sandbox/qbittorrent/qBittorrent"
    local qb_conf_file="$qb_conf_dir/qBittorrent.conf"
    if [ ! -f "$qb_conf_file" ] && [ -f "$CONFIG_DIR/sandbox/qbittorrent.conf" ]; then
        mkdir -p "$qb_conf_dir"
        cp "$CONFIG_DIR/sandbox/qbittorrent.conf" "$qb_conf_file"
        log "INFO" "Installed hardened qBittorrent.conf -> $qb_conf_file"
    fi

    shopt -s nullglob
    local f
    for f in "$CONFIG_DIR"/*.sh "$CONFIG_DIR"/scripts/*.sh "$CONFIG_DIR"/sandbox/*.sh "$CONFIG_DIR"/sandbox/*.py "$CONFIG_DIR"/quadlets/*.sh; do
        chmod +x "$f"
    done
    shopt -u nullglob
}

harmonize_permissions() {
    chmod -R 777 /var/tmp/jellyfin-cache 2>/dev/null || true
    chattr -R +C /var/tmp/jellyfin-cache 2>/dev/null || true

    podman unshare chown -R 1000:1000 "$CONFIG_DIR/seerr" 2>/dev/null || true

    chmod 777 \
        "$DATA_DIR/seerr/media/download/incomplete" \
        "$DATA_DIR/seerr/media/download/staging" \
        "$DATA_DIR/seerr/media/download/completed/Movies" \
        "$DATA_DIR/seerr/media/download/completed/Series" \
        "$DATA_DIR/seerr/media/download/completed/Podcasts" \
        "$DATA_DIR/sandbox/ntfy" \
        "$CONFIG_DIR/sandbox/ntfy/cache" 2>/dev/null || true

    podman unshare chmod -R 777 \
        "$DATA_DIR/seerr/media/download" \
        "$DATA_DIR/sandbox/ntfy" \
        "$CONFIG_DIR/sandbox/ntfy/cache" 2>/dev/null || true

    log "INFO" "Rootless permissions and NVMe transcode cache harmonized."
}

cleanup_unmanaged_conflicts() {
    # Stop legacy PID-file supervisor if not yet managed by systemd
    local sup_pid_file="$CONFIG_DIR/sandbox/supervisor.pid"
    if ! systemctl --user is-active --quiet alpha-orbit-supervisor.service 2>/dev/null; then
        if [ -f "$sup_pid_file" ]; then
            local old_pid
            old_pid="$(cat "$sup_pid_file" 2>/dev/null || true)"
            if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null && grep -qa "sandbox_supervisor" "/proc/$old_pid/cmdline" 2>/dev/null; then
                log "INFO" "Stopping legacy non-systemd supervisor (PID $old_pid) before starting systemd unit..."
                pkill -P "$old_pid" 2>/dev/null || true
                kill -TERM "$old_pid" 2>/dev/null || true
                sleep 1
            fi
            rm -f "$sup_pid_file"
        fi
    fi

    # Remove pre-existing unmanaged compose containers (dependents first) if their systemd service is not active
    local container_name svc_name
    for container_name in \
        alpha-prod-dashboard \
        alpha-prod-jellyfin \
        alpha-prod-seerr \
        alpha-prod-flaresolverr \
        alpha-prod-tailscale \
        alpha-prod-gluetun; do
        svc_name="${container_name}.service"
        if ! systemctl --user is-active --quiet "$svc_name" 2>/dev/null; then
            if podman container exists "$container_name" 2>/dev/null; then
                log "INFO" "Removing unmanaged container $container_name prior to Quadlet handoff..."
                podman rm -f "$container_name" >/dev/null 2>&1 || true
            fi
        fi
    done
}

start_core_and_supervisor() {
    # Start network units first if generated
    local net_file net_unit
    if [ -d "$QUADLETS_DIR/networks" ]; then
        while IFS= read -r -d '' net_file; do
            net_unit="$(basename "${net_file%.tmpl}")"
            net_unit="${net_unit%.network}-network.service"
            systemctl --user start "$net_unit" 2>/dev/null || true
        done < <(find "$QUADLETS_DIR/networks" -maxdepth 1 -type f \( -name '*.network' -o -name '*.network.tmpl' \) -print0 | sort -z)
    fi

    # Build ordered list of Core Quadlet services (sidecars/gateways first)
    local core_units=()
    local deferred_units=()
    local c_file c_base c_svc

    if [ -d "$QUADLETS_DIR/core" ]; then
        while IFS= read -r -d '' c_file; do
            c_base="$(basename "${c_file%.tmpl}")"
            c_svc="${c_base%.container}.service"
            case "$c_svc" in
                alpha-prod-tailscale.service|alpha-prod-gluetun.service)
                    core_units+=("$c_svc")
                    ;;
                *)
                    deferred_units+=("$c_svc")
                    ;;
            esac
        done < <(find "$QUADLETS_DIR/core" -maxdepth 1 -type f \( -name '*.container' -o -name '*.container.tmpl' \) -print0 | sort -z)
    fi

    # Ensure tailscale precedes gluetun if both exist
    local ordered_priority=()
    local u
    for u in alpha-prod-tailscale.service alpha-prod-gluetun.service; do
        for c_svc in "${core_units[@]+"${core_units[@]}"}"; do
            if [ "$c_svc" = "$u" ]; then
                ordered_priority+=("$c_svc")
            fi
        done
    done

    local all_core=("${ordered_priority[@]+"${ordered_priority[@]}"}" "${deferred_units[@]+"${deferred_units[@]}"}")
    for c_svc in "${all_core[@]+"${all_core[@]}"}"; do
        log "INFO" "Starting Core Quadlet service: $c_svc"
        systemctl --user start "$c_svc"
    done

    log "INFO" "Starting Sandbox Supervisor service: alpha-orbit-supervisor.service"
    systemctl --user start alpha-orbit-supervisor.service
}

case "$MODE" in
    render-only)
        generate_mapped_env
        render_all_templates
        log "INFO" "Render-only dry-run complete (no systemctl/podman side effects)."
        ;;
    sync)
        ensure_directories
        generate_mapped_env
        render_all_templates
        log "INFO" "Reloading systemd user daemon..."
        systemctl --user daemon-reload
        log "INFO" "Sync complete (running services preserved)."
        ;;
    install)
        verify_storage_mount
        ensure_directories
        harmonize_permissions
        generate_mapped_env
        render_all_templates

        log "INFO" "Reloading systemd user daemon..."
        systemctl --user daemon-reload

        log "INFO" "Enabling user socket, timers, and supervisor service..."
        systemctl --user enable --now podman.socket
        systemctl --user enable --now podman-auto-update.timer
        systemctl --user enable --now alpha-orbit-git-sync.timer
        systemctl --user enable alpha-orbit-supervisor.service

        if command -v loginctl >/dev/null 2>&1; then
            if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q "Linger=no"; then
                loginctl enable-linger "$USER" 2>/dev/null || \
                    log "WARN" "Could not enable lingering automatically; run: loginctl enable-linger $USER"
            fi
        fi

        cleanup_unmanaged_conflicts
        start_core_and_supervisor
        log "INFO" "Full Quadlet installation complete."
        ;;
esac
