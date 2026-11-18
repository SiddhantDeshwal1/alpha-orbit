#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Sandbox Supervisor Daemon v2.0
# Autonomous on-demand lifecycle manager for the download sandbox stack.
#
# State Machine:
#   SLEEP  -> WAKING  : Seerr queue has pending/processing items
#   WAKING -> ACTIVE  : start_sandbox.sh (gluetun, qbit, radarr, sonarr, gatekeeper)
#   ACTIVE -> COOLDOWN: active torrents=0 AND seerr queue=0 AND gatekeeper idle
#   COOLDOWN -> ACTIVE: New request arrives before cooldown expires (default: 15-min)
#   COOLDOWN -> SLEEP : Cooldown expires -> stop_sandbox.sh (drives park safely)
#
# Polls every POLL_INTERVAL seconds (default: 20s)
# Automatically launched by start.sh in background, stopped by stop.sh
# ==============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$CONFIG_DIR"
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

SEERR_URL="${SEERR_URL:-http://127.0.0.1:5055}"
SEERR_API_KEY="${SEERR_API_KEY:-}"
QBIT_URL="${QBIT_URL:-http://127.0.0.1:8081}"
QBIT_USER="${QBIT_USER:-admin}"
QBIT_PASS="${QBIT_PASS:-}"

RADARR_URL="${RADARR_URL:-http://127.0.0.1:7878}"
RADARR_API_KEY="${RADARR_API_KEY:-}"
if [ -z "$RADARR_API_KEY" ]; then
    if [ -f "$CONFIG_DIR/sandbox/radarr/config.xml" ]; then
        RADARR_API_KEY=$(sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' "$CONFIG_DIR/sandbox/radarr/config.xml" 2>/dev/null || true)
    elif [ -f "$SCRIPT_DIR/radarr/config.xml" ]; then
        RADARR_API_KEY=$(sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' "$SCRIPT_DIR/radarr/config.xml" 2>/dev/null || true)
    fi
fi

SONARR_URL="${SONARR_URL:-http://127.0.0.1:8989}"
SONARR_API_KEY="${SONARR_API_KEY:-}"
if [ -z "$SONARR_API_KEY" ]; then
    if [ -f "$CONFIG_DIR/sandbox/sonarr/config.xml" ]; then
        SONARR_API_KEY=$(sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' "$CONFIG_DIR/sandbox/sonarr/config.xml" 2>/dev/null || true)
    elif [ -f "$SCRIPT_DIR/sonarr/config.xml" ]; then
        SONARR_API_KEY=$(sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' "$SCRIPT_DIR/sonarr/config.xml" 2>/dev/null || true)
    fi
fi

COOLDOWN_MINUTES="${SANDBOX_COOLDOWN_MINUTES:-15}"
POLL_INTERVAL=20
LOG_DIR="${SERVER_DATA_DIR}/sandbox/logs"
SUPERVISOR_LOG="$LOG_DIR/supervisor.log"

mkdir -p "$LOG_DIR"

log() {
    local level="$1"
    shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[$ts] [SUPERVISOR] [$level] $*"
}

# Graceful termination handler
cleanup() {
    log "INFO" "Supervisor received stop signal. Exiting."
    exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

# Current state
STATE="SLEEP"
COOLDOWN_START=0
COOLDOWN_SECONDS=$(( COOLDOWN_MINUTES * 60 ))
LAST_PIPELINE_RUN=0
PIPELINE_INTERVAL=3600
LAST_CLEANER_RUN=0
CLEANER_INTERVAL=3600
LAST_RETRY_RUN=0
RETRY_INTERVAL=300
LAST_STALL_CHECK=0
STALL_CHECK_INTERVAL=1800

run_server_pipeline_if_due() {
    local now
    now=$(date +%s)
    if [ $(( now - LAST_PIPELINE_RUN )) -ge $PIPELINE_INTERVAL ]; then
        log "INFO" "Executing hourly Fast AF Server & Tracker Refresh Pipeline..."
        python3 -u "$SCRIPT_DIR/fast_server_scanner.py" --once >> "$LOG_DIR/server_pipeline.log" 2>&1 &
        LAST_PIPELINE_RUN=$now
    fi
}

# 1. Seerr queue (count of pending/processing)
seerr_has_active_requests() {
    if [ -z "$SEERR_API_KEY" ]; then
        log "WARN" "SEERR_API_KEY not set. Cannot poll Seerr queue."
        return 1
    fi

    # ONLY pending and processing represent ongoing work!
    # Failed requests are terminal (or auto-retried by self_heal_failed_requests)
    local response
    response=$(curl -sfL --max-time 5 \
        -H "X-Api-Key: $SEERR_API_KEY" \
        "$SEERR_URL/api/v1/request?filter=pending&take=1" 2>/dev/null || echo "{}")

    local pending
    pending=$(echo "$response" | jq '.results | length' 2>/dev/null || echo 0)

    local response2
    response2=$(curl -sfL --max-time 5 \
        -H "X-Api-Key: $SEERR_API_KEY" \
        "$SEERR_URL/api/v1/request?filter=processing&take=1" 2>/dev/null || echo "{}")

    local processing
    processing=$(echo "$response2" | jq '.results | length' 2>/dev/null || echo 0)

    [ "$(( pending + processing ))" -gt 0 ]
}

# 2. Radarr queue (api/v3/queue)
radarr_has_active_queue() {
    if [ -z "$RADARR_API_KEY" ]; then
        return 1
    fi

    local response
    response=$(curl -sfL --max-time 5 \
        -H "X-Api-Key: $RADARR_API_KEY" \
        "$RADARR_URL/api/v3/queue?pageSize=1" 2>/dev/null || echo "{}")

    local count
    count=$(echo "$response" | jq -r '.totalRecords // (.records | length) // 0' 2>/dev/null || echo 0)
    [ "$count" -gt 0 ]
}

# 3. Sonarr queue (api/v3/queue)
sonarr_has_active_queue() {
    if [ -z "$SONARR_API_KEY" ]; then
        return 1
    fi

    local response
    response=$(curl -sfL --max-time 5 \
        -H "X-Api-Key: $SONARR_API_KEY" \
        "$SONARR_URL/api/v3/queue?pageSize=1" 2>/dev/null || echo "{}")

    local count
    count=$(echo "$response" | jq -r '.totalRecords // (.records | length) // 0' 2>/dev/null || echo 0)
    [ "$count" -gt 0 ]
}

# 4. qBittorrent torrents (/api/v2/torrents/info?filter=all - downloading, stalled, allocating, or active)
qbit_has_active_torrents() {
    local response
    response=$(curl -sf --max-time 10 \
        --cookie-jar /tmp/qb_cookies.txt \
        --cookie /tmp/qb_cookies.txt \
        "$QBIT_URL/api/v2/torrents/info?filter=all" 2>/dev/null || echo "[]")

    local count
    count=$(echo "$response" | jq '[.[]? | select(
        (.state | test("download|stalled|allocat|meta|check|active"; "i")) or
        ((.dlspeed // 0) > 0)
    )] | length' 2>/dev/null || echo 0)
    [ "$count" -gt 0 ]
}

# 5. Staging directory: check if /data/media/staging or $SERVER_DATA_DIR/seerr/media/download/staging has any files
staging_has_files() {
    local dir
    for dir in "$SERVER_DATA_DIR/seerr/media/download/staging" "/data/media/staging"; do
        if [ -d "$dir" ]; then
            local count
            count=$(find "$dir" -mindepth 1 -maxdepth 1 ! -name '.*' 2>/dev/null | wc -l)
            if [ "$count" -gt 0 ]; then
                return 0
            fi
        fi
    done
    return 1
}

# 6. Gatekeeper active processing: check if gatekeeper container has ffmpeg/sanitization running
gatekeeper_is_busy() {
    if podman ps --filter "name=alpha-prod-gatekeeper" --filter "status=running" --format "{{.Names}}" 2>/dev/null | grep -E "^alpha-prod-gatekeeper$" >/dev/null 2>&1; then
        podman exec alpha-prod-gatekeeper pgrep -f "(ffmpeg|ffprobe|clamscan|clamdscan)" >/dev/null 2>&1
    else
        return 1
    fi
}

# Unified active workload check across all 6 pipeline subsystems
sandbox_has_active_workload() {
    if seerr_has_active_requests; then
        return 0
    fi
    if radarr_has_active_queue; then
        return 0
    fi
    if sonarr_has_active_queue; then
        return 0
    fi
    if qbit_has_active_torrents; then
        return 0
    fi
    if staging_has_files; then
        return 0
    fi
    if gatekeeper_is_busy; then
        return 0
    fi
    return 1
}

self_heal_failed_requests() {
    if [ -z "$SEERR_API_KEY" ]; then return 0; fi

    # Check Radarr health before attempting retries
    local radarr_status
    radarr_status=$(curl -sf --max-time 3 -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/system/status" 2>/dev/null || curl -sf --max-time 3 "$RADARR_URL/ping" 2>/dev/null || echo "")
    if [ -z "$radarr_status" ]; then return 0; fi

    local failed_ids
    failed_ids=$(curl -sfL --max-time 5 -H "X-Api-Key: $SEERR_API_KEY" "$SEERR_URL/api/v1/request?filter=failed&take=10" 2>/dev/null | jq -r '.results[]?.id // empty')
    for req_id in $failed_ids; do
        log "INFO" "[SELF-HEAL] Re-dispatching previously failed Seerr request #$req_id now that Radarr is healthy..."
        curl -sfL -X POST --max-time 10 -H "X-Api-Key: $SEERR_API_KEY" "$SEERR_URL/api/v1/request/$req_id/retry" >/dev/null 2>&1 || true
    done
}

retry_failed_seerr_requests() {
    self_heal_failed_requests
}

sandbox_is_running() {
    local running
    running=$(podman ps --filter "name=alpha-prod-qbittorrent" --filter "status=running" --format "{{.Names}}" 2>/dev/null | grep -E "^alpha-prod-qbittorrent$" || true)
    [ -n "$running" ]
}

start_sandbox() {
    log "INFO" "Active workload detected! Waking up Sandbox Download Stack..."
    "$SCRIPT_DIR/start_sandbox.sh" >> "$SUPERVISOR_LOG" 2>&1 || {
        log "ERROR" "Failed to start sandbox stack!"
        return 1
    }
    log "INFO" "Sandbox Download Stack is ONLINE and routing through VPN."
    # Automatically retry any requests that failed while Radarr/Sonarr were offline
    sleep 5
    retry_failed_seerr_requests
}

stop_sandbox() {
    log "INFO" "${COOLDOWN_MINUTES}-Minute cooldown expired with zero active requests. Stopping sandbox..."
    "$SCRIPT_DIR/stop_sandbox.sh" >> "$SUPERVISOR_LOG" 2>&1 || true
    log "INFO" "Sandbox stopped. Drive heads safely parked. 100% CPU/RAM released."
}

log "INFO" "=========================================================="
log "INFO" "Sandbox Supervisor active. Polling Seerr every ${POLL_INTERVAL}s."
log "INFO" "Mode: Auto Wake on Request -> Auto Sleep after ${COOLDOWN_MINUTES}m idle."
log "INFO" "=========================================================="

while true; do
    case "$STATE" in

        SLEEP)
            if sandbox_has_active_workload; then
                log "INFO" "Active workload detected! Transitioning: SLEEP -> WAKING"
                STATE="WAKING"
            fi
            ;;

        WAKING)
            if ! sandbox_is_running; then
                if start_sandbox; then
                    STATE="ACTIVE"
                else
                    STATE="SLEEP"
                fi
            else
                log "INFO" "Sandbox already running. Transitioning: WAKING -> ACTIVE"
                STATE="ACTIVE"
            fi
            ;;

        ACTIVE)
            if ! sandbox_has_active_workload; then
                log "INFO" "All downloads, queues, staging, and sanitization tasks complete."
                log "INFO" "Entering ${COOLDOWN_MINUTES}-minute cooldown window (keeping stack warm for batch requests)."
                COOLDOWN_START=$(date +%s)
                STATE="COOLDOWN"
            fi
            ;;

        COOLDOWN)
            if sandbox_has_active_workload; then
                log "INFO" "Active workload detected during cooldown window! Resetting timer. Transitioning: COOLDOWN -> ACTIVE"
                COOLDOWN_START=0
                STATE="ACTIVE"
            else
                NOW=$(date +%s)
                ELAPSED=$(( NOW - COOLDOWN_START ))
                REMAINING=$(( COOLDOWN_SECONDS - ELAPSED ))

                if [ $ELAPSED -ge $COOLDOWN_SECONDS ]; then
                    stop_sandbox
                    STATE="SLEEP"
                fi
            fi
            ;;
    esac

    # Run hourly server & tracker refresh pipeline
    run_server_pipeline_if_due

    # Auto-heal transient failed requests periodically (every 5 min)
    now_ts=$(date +%s)
    if [ $(( now_ts - LAST_RETRY_RUN )) -ge $RETRY_INTERVAL ]; then
        self_heal_failed_requests
        LAST_RETRY_RUN=$now_ts
    fi

    # Dead-swarm stall detection (every 30 min, only while sandbox is ACTIVE)
    if [ "$STATE" = "ACTIVE" ] && [ $(( now_ts - LAST_STALL_CHECK )) -ge $STALL_CHECK_INTERVAL ]; then
        log "INFO" "Running stall detection scan..."
        python3 -u "$SCRIPT_DIR/stall_detector.py" >> "$LOG_DIR/stall_detector.log" 2>&1 || true
        LAST_STALL_CHECK=$now_ts
    fi

    # Clean unreleased/unuploaded requests strictly once per hour (never hammer indexers every 20s)
    if [ $(( now_ts - LAST_CLEANER_RUN )) -ge $CLEANER_INTERVAL ]; then
        log "INFO" "Executing periodic unreleased request audit..."
        python3 -u "$SCRIPT_DIR/unreleased_request_cleaner.py" >> "$LOG_DIR/unreleased_cleaner.log" 2>&1 || true
        LAST_CLEANER_RUN=$now_ts
    fi

    sleep "$POLL_INTERVAL"
done
