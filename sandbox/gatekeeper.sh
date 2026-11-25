#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Zero-Trust Media Gatekeeper v2.1
# 4-Stage File Sanitization Pipeline
# Stage 1: MIME Magic Byte / Subtitle Text / Container Format Verification
# Stage 2: Execution Bit Stripping & Blacklist Purge
# Stage 3: FFmpeg Container Sanitization (Isolated Work Dir)
# Stage 4: ClamAV Antivirus Daemon Scan + Library/Servarr/Jellyfin Triggers
# ==============================================================================

set -euo pipefail

STAGING_DIR="${STAGING_DIR:-/data/media/staging}"
STAGING_DIR="${STAGING_DIR%/}"
COMPLETED_DIR="${COMPLETED_DIR:-/data/media/completed}"
COMPLETED_DIR="${COMPLETED_DIR%/}"
LOG_DIR="${LOG_DIR:-/data/logs}"
QUARANTINE_LOG="$LOG_DIR/security_audit.log"
GATEKEEPER_LOG="$LOG_DIR/gatekeeper.log"
WORK_ROOT="$STAGING_DIR/.gatekeeper-work"

JELLYFIN_INTERNAL_URL="${JELLYFIN_INTERNAL_URL:-}"
JELLYFIN_URL="${JELLYFIN_URL:-}"
JELLYFIN_API_KEY="${JELLYFIN_API_KEY:-}"

RADARR_INTERNAL_URL="${RADARR_INTERNAL_URL:-}"
RADARR_URL="${RADARR_URL:-}"
RADARR_API_KEY="${RADARR_API_KEY:-}"
RADARR_COMPLETED_DIR="${RADARR_COMPLETED_DIR:-/data/seerr/media/download/completed}"

SONARR_INTERNAL_URL="${SONARR_INTERNAL_URL:-}"
SONARR_URL="${SONARR_URL:-}"
SONARR_API_KEY="${SONARR_API_KEY:-}"
SONARR_COMPLETED_DIR="${SONARR_COMPLETED_DIR:-/data/seerr/media/download/completed}"

DASHBOARD_URL="${DASHBOARD_URL:-http://alpha-prod-tailscale:3000}"
CLAMAV_HOST="${CLAMAV_HOST:-alpha-prod-clamav}"
CLAMAV_PORT="${CLAMAV_PORT:-3310}"
SAMPLE_MAX_BYTES="${SAMPLE_MAX_BYTES:-52428800}"

mkdir -p "$LOG_DIR" "$COMPLETED_DIR/Movies" "$COMPLETED_DIR/Series"

# Non-blocking lock to guarantee single-instance execution
LOCK_FILE="/tmp/gatekeeper.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATOMIC_MOVE_BIN="/scripts/atomic_move.sh"
if [ ! -x "$ATOMIC_MOVE_BIN" ]; then
    if [ -x "$SCRIPT_DIR/atomic_move.sh" ]; then
        ATOMIC_MOVE_BIN="$SCRIPT_DIR/atomic_move.sh"
    elif command -v atomic_move.sh >/dev/null 2>&1; then
        ATOMIC_MOVE_BIN="atomic_move.sh"
    fi
fi

# Fallback: read Servarr API keys from config.xml when not exported in env
read_servarr_xml_key() {
    local app_dir="$1"
    local xml_path=""
    for xml_path in "/scripts/$app_dir/config.xml" "$SCRIPT_DIR/$app_dir/config.xml"; do
        if [ -f "$xml_path" ]; then
            sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' "$xml_path" 2>/dev/null | head -n1 || true
            return 0
        fi
    done
}

if [ -z "$RADARR_API_KEY" ]; then
    RADARR_API_KEY="$(read_servarr_xml_key "radarr")"
fi
if [ -z "$SONARR_API_KEY" ]; then
    SONARR_API_KEY="$(read_servarr_xml_key "sonarr")"
fi

JELLYFIN_PREFLIGHT_DOWN=0

log() {
    local level="$1"
    shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[$ts] [$level] $*" | tee -a "$GATEKEEPER_LOG"
}

alert() {
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[$ts] [ALERT] $*" | tee -a "$QUARANTINE_LOG" "$GATEKEEPER_LOG"
}

resolve_service_url() {
    local internal_url="$1"
    local primary_url="$2"
    local probe_paths="$3"
    shift 3
    local container_candidates=("$@")

    local candidates=()
    local seen="|"
    local candidate probe

    if [ -n "$internal_url" ]; then
        candidates+=("${internal_url%/}")
    fi
    if [ -n "$primary_url" ] && [[ ! "$primary_url" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$) ]]; then
        candidates+=("${primary_url%/}")
    fi
    for candidate in "${container_candidates[@]}"; do
        [ -n "$candidate" ] && candidates+=("${candidate%/}")
    done
    if [ -n "$primary_url" ] && [[ "$primary_url" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$) ]]; then
        candidates+=("${primary_url%/}")
    fi

    local -a probes=()
    IFS='|' read -r -a probes <<< "$probe_paths"

    for candidate in "${candidates[@]}"; do
        [ -z "$candidate" ] && continue
        case "$seen" in
            *"|$candidate|"*) continue ;;
        esac
        seen="${seen}${candidate}|"

        for probe in "${probes[@]}"; do
            [ -z "$probe" ] && continue
            if curl -sf --max-time 3 "${candidate}${probe}" >/dev/null 2>&1; then
                printf '%s' "$candidate"
                return 0
            fi
        done
    done

    return 1
}

resolve_jellyfin_url() {
    resolve_service_url \
        "$JELLYFIN_INTERNAL_URL" \
        "$JELLYFIN_URL" \
        "/System/Ping|/System/Info/Public" \
        "http://alpha-prod-tailscale:8096" \
        "http://alpha-prod-jellyfin:8096"
}

notify_jellyfin_resilient() {
    local token="${JELLYFIN_API_KEY:-}"
    if [ -z "$token" ]; then
        log "WARN" "JELLYFIN_API_KEY is empty — skipping Jellyfin Library Refresh."
        return 1
    fi

    if [ "$JELLYFIN_PREFLIGHT_DOWN" -eq 1 ]; then
        return 1
    fi

    local max_attempts=5
    local attempt=1
    local delay=2
    local jf_url=""

    while [ "$attempt" -le "$max_attempts" ]; do
        jf_url="$(resolve_jellyfin_url || true)"
        if [ -z "$jf_url" ]; then
            if [ "$attempt" -eq 1 ]; then
                log "WARN" "Jellyfin pre-flight unreachable across candidates (JELLYFIN_INTERNAL_URL, JELLYFIN_URL, alpha-prod-tailscale:8096, alpha-prod-jellyfin:8096). Retrying..."
            else
                log "WARN" "Jellyfin still unreachable (attempt $attempt/$max_attempts). Retrying in ${delay}s..."
            fi
            if [ "$attempt" -lt "$max_attempts" ]; then
                sleep "$delay"
                delay=$(( delay * 2 ))
            fi
            attempt=$(( attempt + 1 ))
            continue
        fi

        log "INFO" "Dispatching Jellyfin Library Refresh to $jf_url (attempt $attempt/$max_attempts)..."
        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
            -X POST "$jf_url/Library/Refresh" \
            -H "Authorization: MediaBrowser Client=\"OrbitGatekeeper\", Device=\"Gatekeeper\", DeviceId=\"orbit-gatekeeper\", Version=\"2.1\", Token=\"$token\"" 2>/dev/null || echo "000")

        if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
            log "OK" "Jellyfin library refresh successfully accepted (HTTP $http_code)."
            return 0
        fi

        log "WARN" "Jellyfin ($jf_url) responded with HTTP $http_code. Retrying in ${delay}s..."
        if [ "$attempt" -lt "$max_attempts" ]; then
            sleep "$delay"
            delay=$(( delay * 2 ))
        fi
        attempt=$(( attempt + 1 ))
    done

    JELLYFIN_PREFLIGHT_DOWN=1
    log "ERROR" "Failed to notify Jellyfin after $max_attempts attempts."
    return 1
}

build_json_kv_payload() {
    local k1="$1" v1="$2" k2="$3" v2="$4"
    if command -v jq >/dev/null 2>&1; then
        jq -cn --arg k1 "$k1" --arg v1 "$v1" --arg k2 "$k2" --arg v2 "$v2" '{($k1): $v1, ($k2): $v2}'
    else
        v1="${v1//\\/\\\\}"
        v1="${v1//\"/\\\"}"
        v2="${v2//\\/\\\\}"
        v2="${v2//\"/\\\"}"
        printf '{"%s":"%s","%s":"%s"}' "$k1" "$v1" "$k2" "$v2"
    fi
}

notify_servarr_import() {
    local category="$1"
    local target_subdir="${2:-}"
    local app_name="" api_key="" cmd_name="" scan_base="" resolved_url=""

    case "$category" in
        Movies)
            app_name="Radarr"
            api_key="$RADARR_API_KEY"
            cmd_name="DownloadedMoviesScan"
            scan_base="${RADARR_COMPLETED_DIR%/}"
            resolved_url="$(resolve_service_url "$RADARR_INTERNAL_URL" "$RADARR_URL" "/ping" "http://alpha-prod-gluetun:7878" "http://alpha-prod-radarr:7878" || true)"
            [ -z "$resolved_url" ] && resolved_url="${RADARR_INTERNAL_URL:-${RADARR_URL:-http://alpha-prod-gluetun:7878}}"
            ;;
        Series)
            app_name="Sonarr"
            api_key="$SONARR_API_KEY"
            cmd_name="DownloadedEpisodesScan"
            scan_base="${SONARR_COMPLETED_DIR%/}"
            resolved_url="$(resolve_service_url "$SONARR_INTERNAL_URL" "$SONARR_URL" "/ping" "http://alpha-prod-gluetun:8989" "http://alpha-prod-sonarr:8989" || true)"
            [ -z "$resolved_url" ] && resolved_url="${SONARR_INTERNAL_URL:-${SONARR_URL:-http://alpha-prod-gluetun:8989}}"
            ;;
        *)
            return 0
            ;;
    esac

    if [ -z "$api_key" ]; then
        log "INFO" "[$app_name] API key not configured; skipping $cmd_name import trigger."
        return 0
    fi

    local scan_path="$scan_base/$category"
    if [ -n "$target_subdir" ]; then
        scan_path="$scan_path/$target_subdir"
    fi

    local payload http_code
    payload="$(build_json_kv_payload "name" "$cmd_name" "path" "$scan_path")"
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -X POST "${resolved_url%/}/api/v3/command" \
        -H "X-Api-Key: $api_key" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null || echo "000")

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ] || [ "$http_code" = "202" ]; then
        log "OK" "[$app_name] Triggered $cmd_name for '$scan_path' (HTTP $http_code)."
    else
        log "WARN" "[$app_name] $cmd_name notification returned HTTP $http_code for '$scan_path' (non-fatal)."
    fi
    return 0
}

classify_media() {
    local rel_or_name="$1"
    local lower
    lower=$(echo "$rel_or_name" | tr '[:upper:]' '[:lower:]')

    if echo "$lower" | grep -qE '\.(mp3|m4a|m4b|ogg|opus|aac|flac|wav|podcast)$'; then
        echo "Podcasts"
    elif echo "$lower" | grep -qE '(s[0-9]{1,2}e[0-9]{1,3}|(^|[^a-z0-9])s[0-9]{2}([^a-z0-9]|$)|season|episode|e[0-9]{2,3}|web[._ -]?series|series|[0-9]{1,2}x[0-9]{2,3})'; then
        echo "Series"
    else
        echo "Movies"
    fi
}

is_dangerous_executable_name() {
    local lower_name="$1"
    case "$lower_name" in
        *.sh|*.exe|*.bat|*.vbs|*.js|*.py|*.ps1|*.cmd|*.com|*.scr|*.hta|*.msi|*.dll|*.elf|*.bin|*.run|*.jar)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

is_harmless_metadata_name() {
    local lower_name="$1"
    case "$lower_name" in
        *.nfo|*.txt|*.jpg|*.jpeg|*.png|*.gif|*.webp|*.bmp|*.url|*.lnk|*.sfv|*.md5|*.sha1|*.srr|*.srs|*.nzb|*.torrent|*.htm|*.html|*.xml|*.log|*.diz|*.cue|*.m3u)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

is_sample_clip() {
    local rel_lower="$1"
    local file_path="$2"
    local fname_lower
    fname_lower=$(basename "$rel_lower")
    local ext_lower="${fname_lower##*.}"
    local size_bytes

    if [[ "$rel_lower" == *sample* ]]; then
        if [[ "$rel_lower" == sample/* || "$rel_lower" == */sample/* || "$ext_lower" =~ ^(mkv|mp4|avi|mov|wmv|flv|m4v|ts|webm)$ ]]; then
            size_bytes=$(stat -c%s "$file_path" 2>/dev/null || echo 0)
            if [ "$size_bytes" -lt "$SAMPLE_MAX_BYTES" ]; then
                return 0
            fi
        fi
    fi
    return 1
}

has_binary_executable_header() {
    local file="$1"
    local hex_prefix
    hex_prefix=$(head -c 16 "$file" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)
    # Strip optional UTF-8 BOM (efbbbf) before checking shebang/headers
    hex_prefix="${hex_prefix#efbbbf}"
    case "$hex_prefix" in
        7f454c46*|4d5a*|2321*|cafebabe*|cefaedfe*|cffaedfe*|feedface*|feedfacf*|504b0304*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

validate_text_subtitle() {
    local file="$1"
    [ -s "$file" ] || return 1

    if has_binary_executable_header "$file"; then
        return 1
    fi

    # Accept UTF-16 BOM text subtitles cleanly when iconv confirms validity
    local bom4
    bom4=$(head -c 2 "$file" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n' || true)
    if [ "$bom4" = "fffe" ] || [ "$bom4" = "feff" ]; then
        if command -v iconv >/dev/null 2>&1 && iconv -f UTF-16 -t UTF-8 "$file" >/dev/null 2>&1; then
            return 0
        fi
        return 1
    fi

    local nul_count ctrl_count
    nul_count=$(LC_ALL=C tr -cd '\000' < "$file" 2>/dev/null | wc -c || echo 1)
    if [ "$nul_count" -gt 0 ]; then
        return 1
    fi

    ctrl_count=$(LC_ALL=C tr -cd '\001-\010\013\014\016-\037\177' < "$file" 2>/dev/null | wc -c || echo 1)
    if [ "$ctrl_count" -gt 0 ]; then
        return 1
    fi

    if command -v iconv >/dev/null 2>&1 && iconv -f UTF-8 -t UTF-8 "$file" >/dev/null 2>&1; then
        return 0
    fi

    # Fallback for Latin-1 / Windows-1252 subtitles: require >=85% printable ASCII/whitespace
    local total_bytes ascii_bytes
    total_bytes=$(stat -c%s "$file" 2>/dev/null || echo 0)
    ascii_bytes=$(LC_ALL=C tr -cd '[:print:]\t\r\n' < "$file" 2>/dev/null | wc -c || echo 0)
    if [ "$total_bytes" -gt 0 ] && [ $(( ascii_bytes * 100 / total_bytes )) -ge 85 ]; then
        return 0
    fi
    return 1
}

scan_with_clamav() {
    local target="$1"
    local rel_path="${target#$STAGING_DIR/}"
    local clam_scan_path="/scan/staging/$rel_path"
    local output=""

    if command -v nc >/dev/null 2>&1; then
        output=$(echo "SCAN $clam_scan_path" | nc -w 30 "$CLAMAV_HOST" "$CLAMAV_PORT" 2>&1 || true)
    elif command -v clamdscan >/dev/null 2>&1; then
        output=$(clamdscan --no-summary --max-filesize=4096M --max-scansize=4096M "$target" 2>&1 || true)
    elif command -v clamscan >/dev/null 2>&1; then
        output=$(clamscan --no-summary --max-filesize=4096M --max-scansize=4096M "$target" 2>&1 || true)
    else
        # Pure-bash TCP fallback when minimal ffmpeg container lacks netcat
        output=$(timeout 30 bash -c "exec 3<>/dev/tcp/$CLAMAV_HOST/$CLAMAV_PORT && printf 'SCAN %s\n' \"\$1\" >&3 && cat <&3" _ "$clam_scan_path" 2>&1 || true)
        if [ -z "$output" ]; then
            log "WARN" "[Stage 4] Neither netcat nor ClamAV found — skipping AV scan."
            output="OK"
        fi
    fi

    printf '%s' "$output"
}

validate_stage1() {
    local file="$1"
    local basename="$2"
    local ext_lower="$3"
    local basename_lower
    basename_lower=$(echo "$basename" | tr '[:upper:]' '[:lower:]')

    if is_dangerous_executable_name "$basename_lower"; then
        alert "[Stage 1] BLOCKED: Blacklisted extension on file: $basename"
        rm -rf "$file"
        return 1
    fi

    # Subtitle sidecar verification (works both with and without `file` binary)
    if [[ "$ext_lower" =~ ^(srt|vtt|ass|sub)$ ]]; then
        if command -v file >/dev/null 2>&1; then
            local mime_type
            mime_type=$(file --mime-type -b "$file" 2>/dev/null || echo "unknown")
            case "$mime_type" in
                text/plain|text/vtt|text/x-subrip|application/x-subrip|text/x-ssa|text/ass)
                    if has_binary_executable_header "$file"; then
                        alert "[Stage 1] BLOCKED: Executable header disguised as subtitle: $basename"
                        rm -rf "$file"
                        return 1
                    fi
                    log "PASS" "[Stage 1] Valid subtitle MIME ($mime_type) -> $basename"
                    return 0
                    ;;
                application/octet-stream)
                    if validate_text_subtitle "$file"; then
                        log "PASS" "[Stage 1] Validated text subtitle despite generic MIME -> $basename"
                        return 0
                    fi
                    alert "[Stage 1] BLOCKED: Binary payload disguised as subtitle ($mime_type): $basename"
                    rm -rf "$file"
                    return 1
                    ;;
                *)
                    alert "[Stage 1] BLOCKED: Unauthorized subtitle MIME '$mime_type' in file: $basename"
                    rm -rf "$file"
                    return 1
                    ;;
            esac
        elif validate_text_subtitle "$file"; then
            log "PASS" "[Stage 1] Valid printable text subtitle -> $basename"
            return 0
        else
            alert "[Stage 1] BLOCKED: Invalid or binary subtitle payload in file: $basename"
            rm -rf "$file"
            return 1
        fi
    fi

    if [ "$ext_lower" = "idx" ]; then
        if has_binary_executable_header "$file"; then
            alert "[Stage 1] BLOCKED: Executable header disguised as .idx: $basename"
            rm -rf "$file"
            return 1
        fi
        log "PASS" "[Stage 1] Valid subtitle index (.idx) -> $basename"
        return 0
    fi

    if command -v file >/dev/null 2>&1; then
        local MIME_TYPE
        MIME_TYPE=$(file --mime-type -b "$file" 2>/dev/null || echo "unknown")

        case "$MIME_TYPE" in
            video/*|application/x-matroska|audio/*|application/ogg|application/mp4)
                log "PASS" "[Stage 1] Valid MIME type: $MIME_TYPE -> $basename"
                ;;
            application/octet-stream)
                if command -v ffprobe >/dev/null 2>&1; then
                    local FORMAT
                    FORMAT=$(ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "$file" 2>/dev/null || echo "unknown")
                    case "$FORMAT" in
                        *matroska*|*mp4*|*avi*|*mov*|*webm*|*flv*|*mp3*|*ogg*|*flac*|*wav*|*aac*|*m4a*|*asf*|*mpegts*)
                            log "PASS" "[Stage 1] Valid media format ($FORMAT) via ffprobe -> $basename"
                            ;;
                        *)
                            alert "[Stage 1] BLOCKED: Unauthorized octet-stream media format '$FORMAT' in file: $basename"
                            rm -rf "$file"
                            return 1
                            ;;
                    esac
                else
                    log "PASS" "[Stage 1] Valid MIME type: $MIME_TYPE -> $basename"
                fi
                ;;
            *)
                alert "[Stage 1] BLOCKED: Unauthorized MIME type '$MIME_TYPE' in file: $basename"
                rm -rf "$file"
                return 1
                ;;
        esac
    elif command -v ffprobe >/dev/null 2>&1; then
        local FORMAT
        FORMAT=$(ffprobe -v error -show_entries format=format_name -of default=noprint_wrappers=1:nokey=1 "$file" 2>/dev/null || echo "unknown")
        case "$FORMAT" in
            *matroska*|*mp4*|*avi*|*mov*|*webm*|*flv*|*mp3*|*ogg*|*flac*|*wav*|*aac*|*m4a*|*asf*|*mpegts*|*srt*|*subrip*|*webvtt*|*ass*)
                log "PASS" "[Stage 1] Valid media format ($FORMAT) via ffprobe -> $basename"
                ;;
            *)
                alert "[Stage 1] BLOCKED: Unauthorized media format '$FORMAT' in file: $basename"
                rm -rf "$file"
                return 1
                ;;
        esac
    fi

    return 0
}

process_file() {
    local file="$1"
    local rel_path="${file#$STAGING_DIR/}"
    local rel_dir
    rel_dir=$(dirname "$rel_path")
    local basename
    basename=$(basename "$file")
    local ext="${basename##*.}"
    local ext_lower
    ext_lower=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
    local stem="${basename%.*}"
    local EXTRACTED_SRTS=()
    local work_dir=""
    local scan_target="$file"
    local remuxed=0

    log "INFO" "Processing: $rel_path"

    # STAGE 1: MIME Magic Byte / Subtitle Text / Container Verification
    validate_stage1 "$file" "$basename" "$ext_lower" || return 1

    # STAGE 2: Execution Bit Stripping & Permissions Lock
    chmod 644 "$file"
    log "PASS" "[Stage 2] Execution bits stripped. Permissions: 644 -> $basename"

    # STAGE 3: FFmpeg Container Sanitization inside isolated work directory
    if [[ "$ext_lower" =~ ^(mkv|mp4|avi|mov|wmv|flv|m4v|ts|webm)$ ]]; then
        log "INFO" "[Stage 3] Running Direct-Play First harmonization on: $basename"

        mkdir -p "$WORK_ROOT"
        chmod 755 "$WORK_ROOT"
        work_dir=$(mktemp -d "$WORK_ROOT/job.XXXXXX")
        chmod 755 "$work_dir"

        local TARGET_EXT="mkv"
        if [[ "$ext_lower" =~ ^(mp4|m4v)$ ]]; then
            TARGET_EXT="mp4"
        fi
        local CLEAN_FILE="$work_dir/${stem}.sanitized.${TARGET_EXT}"

        local PROBE_JSON=""
        if ! PROBE_JSON=$(ffprobe -v quiet -print_format json -show_streams "$file" 2>> "$GATEKEEPER_LOG"); then
            alert "[Stage 3] BLOCKED: ffprobe stream inspection failed for: $basename"
            rm -rf "$work_dir" "$file"
            return 1
        fi

        if [ -z "$PROBE_JSON" ]; then
            alert "[Stage 3] BLOCKED: ffprobe returned empty stream metadata for: $basename"
            rm -rf "$work_dir" "$file"
            return 1
        fi

        local HAS_VIDEO="true" AUDIO_COUNT=0 HAS_STEREO_AAC="false" A0_LANG=""
        if command -v jq >/dev/null 2>&1; then
            while IFS= read -r sub_info; do
                [ -z "$sub_info" ] && continue
                local SUB_IDX SUB_CODEC SUB_LANG
                SUB_IDX=$(echo "$sub_info" | jq -r '.index')
                SUB_CODEC=$(echo "$sub_info" | jq -r '.codec_name')
                SUB_LANG=$(echo "$sub_info" | jq -r '.tags.language // "und"')
                SUB_LANG=$(echo "$SUB_LANG" | tr -cd '[:alnum:]_')
                [ -z "$SUB_LANG" ] && SUB_LANG="und"

                local SRT_TARGET="$work_dir/${stem}.${SUB_LANG}.srt"
                if [ -f "$SRT_TARGET" ]; then
                    SRT_TARGET="$work_dir/${stem}.${SUB_LANG}.${SUB_IDX}.srt"
                fi

                log "INFO" "[Stage 3] Extracting text subtitle stream #$SUB_IDX ($SUB_CODEC, $SUB_LANG) -> $(basename "$SRT_TARGET")"
                if ffmpeg -nostdin -v error -y -i "$file" -map "0:$SUB_IDX" -c:s srt "$SRT_TARGET" 2>> "$GATEKEEPER_LOG"; then
                    chmod 644 "$SRT_TARGET"
                    EXTRACTED_SRTS+=("$SRT_TARGET")
                else
                    log "WARN" "[Stage 3] Failed to extract subtitle stream #$SUB_IDX to $SRT_TARGET"
                fi
            done < <(echo "$PROBE_JSON" | jq -c '.streams[]? | select(.codec_type=="subtitle" and (.codec_name=="subrip" or .codec_name=="webvtt" or .codec_name=="ass" or .codec_name=="mov_text"))')

            HAS_VIDEO=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="video")] | length > 0')
            AUDIO_COUNT=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="audio")] | length')
            HAS_STEREO_AAC=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="audio")] | any(.codec_name=="aac" and (.channels != null and .channels <= 2))')
            A0_LANG=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="audio")][0].tags.language // empty')
        else
            AUDIO_COUNT=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$file" 2>/dev/null | wc -l || echo 0)
        fi

        local FFMPEG_CMD=("ffmpeg" "-nostdin" "-v" "error" "-y" "-i" "$file")
        if [ "$HAS_VIDEO" = "true" ]; then
            FFMPEG_CMD+=("-map" "0:v:0" "-c:v:0" "copy")
        fi

        if [ "$AUDIO_COUNT" -gt 0 ]; then
            if [ "$HAS_STEREO_AAC" = "true" ]; then
                log "PASS" "[Stage 3] Stereo AAC track already present. Stream-copying audio."
                FFMPEG_CMD+=("-map" "0:a" "-c:a" "copy")
            else
                log "INFO" "[Stage 3] No stereo AAC track found ($AUDIO_COUNT audio track(s) present). Synthesizing AAC stereo Track 0 & copying master surround."
                FFMPEG_CMD+=("-map" "0:a:0" "-c:a:0" "aac" "-ac:a:0" "2" "-b:a:0" "192k")
                if [ -n "$A0_LANG" ] && [ "$A0_LANG" != "und" ]; then
                    FFMPEG_CMD+=("-metadata:s:a:0" "language=$A0_LANG" "-metadata:s:a:0" "title=Stereo ($A0_LANG)")
                else
                    FFMPEG_CMD+=("-metadata:s:a:0" "title=Stereo")
                fi
                FFMPEG_CMD+=("-map" "0:a" "-c:a" "copy" "-c:a:0" "aac")
                FFMPEG_CMD+=("-disposition:a" "0" "-disposition:a:0" "default")
            fi
        fi

        if [ "$TARGET_EXT" = "mkv" ]; then
            FFMPEG_CMD+=("-map" "0:s?" "-c:s" "copy" "-disposition:s" "0")
        fi

        FFMPEG_CMD+=("-dn" "-map_metadata" "-1" "-fflags" "+genpts")
        if [ "$TARGET_EXT" = "mp4" ]; then
            FFMPEG_CMD+=("-movflags" "+faststart")
        fi
        FFMPEG_CMD+=("$CLEAN_FILE")

        log "INFO" "[Stage 3] Executing FFmpeg remux in isolated work dir on: $basename"
        if "${FFMPEG_CMD[@]}" 2>> "$GATEKEEPER_LOG"; then
            local orig_size clean_size
            orig_size=$(stat -c%s "$file" 2>/dev/null || echo 0)
            clean_size=$(stat -c%s "$CLEAN_FILE" 2>/dev/null || echo 0)

            if [ "$clean_size" -lt $(( orig_size * 85 / 100 )) ] && [ "$orig_size" -gt 10485760 ]; then
                alert "[Stage 3] SUSPICIOUS: Sanitized file too small (${clean_size}B vs orig ${orig_size}B) for: $basename"
                rm -rf "$work_dir" "$file"
                return 1
            fi

            local final_name="${stem}.${TARGET_EXT}"
            scan_target="$work_dir/$final_name"
            mv -f "$CLEAN_FILE" "$scan_target"
            chmod 644 "$scan_target"
            basename="$final_name"
            remuxed=1
            log "PASS" "[Stage 3] FFmpeg Direct-Play harmonization complete. Clean size: ${clean_size}B -> $basename"
        else
            alert "[Stage 3] BLOCKED: FFmpeg stream remux failed for: $basename"
            rm -rf "$work_dir" "$file"
            return 1
        fi
    elif [[ "$ext_lower" =~ ^(mp3|m4a|m4b|ogg|opus|aac|flac|wav)$ ]]; then
        log "INFO" "[Stage 3] Audio file — skipping FFmpeg container sanitization (stream copy pass): $basename"
    elif [[ "$ext_lower" =~ ^(srt|vtt|sub|idx|ass)$ ]]; then
        log "INFO" "[Stage 3] Subtitle sidecar — skipping FFmpeg remux: $basename"
    else
        log "WARN" "[Stage 3] Unknown extension '$ext_lower' — proceeding to ClamAV only"
    fi

    # STAGE 4: ClamAV Antivirus Daemon Scan
    log "INFO" "[Stage 4] Running ClamAV scan on: $basename"
    local CLAM_OUTPUT
    CLAM_OUTPUT=$(scan_with_clamav "$scan_target")
    echo "$CLAM_OUTPUT" >> "$GATEKEEPER_LOG"

    if echo "$CLAM_OUTPUT" | grep -q "FOUND"; then
        alert "[Stage 4] BLOCKED: ClamAV detected malicious payload in: $basename ($CLAM_OUTPUT)"
        [ -n "$work_dir" ] && rm -rf "$work_dir"
        rm -rf "$file"
        return 1
    elif echo "$CLAM_OUTPUT" | grep -q "OK"; then
        log "PASS" "[Stage 4] ClamAV media scan clean: $basename"
    else
        log "WARN" "[Stage 4] ClamAV scan inconclusive or unreachable for $basename: $CLAM_OUTPUT"
    fi

    local srt
    for srt in "${EXTRACTED_SRTS[@]}"; do
        if [ -f "$srt" ]; then
            local srt_base srt_output
            srt_base=$(basename "$srt")
            srt_output=$(scan_with_clamav "$srt")
            echo "$srt_output" >> "$GATEKEEPER_LOG"
            if echo "$srt_output" | grep -q "FOUND"; then
                alert "[Stage 4] BLOCKED: ClamAV detected malicious payload in subtitle: $srt_base ($srt_output)"
                [ -n "$work_dir" ] && rm -rf "$work_dir"
                rm -rf "$file"
                return 1
            fi
        fi
    done

    log "PASS" "[Stage 4] ClamAV pipeline scan clean: $basename"

    # ATOMIC MOVE: Verified clean file to /completed/<category>/[<subdir>/]
    local CATEGORY
    CATEGORY=$(classify_media "$rel_path")
    local TARGET_SUBDIR=""

    if [ "$rel_dir" != "." ] && [ -n "$rel_dir" ]; then
        TARGET_SUBDIR="$rel_dir"
    elif [ "$CATEGORY" = "Movies" ]; then
        if [[ "$ext_lower" =~ ^(mkv|mp4|avi|mov|wmv|flv|m4v|ts|webm)$ ]]; then
            TARGET_SUBDIR="$stem"
        elif [[ "$ext_lower" =~ ^(srt|vtt|sub|idx|ass)$ ]]; then
            local movie_guess="${stem%.[a-zA-Z][a-zA-Z]}"
            movie_guess="${movie_guess%.[a-zA-Z][a-zA-Z][a-zA-Z]}"
            if [ -d "$COMPLETED_DIR/Movies/$movie_guess" ]; then
                TARGET_SUBDIR="$movie_guess"
            elif [ -d "$COMPLETED_DIR/Movies/$stem" ]; then
                TARGET_SUBDIR="$stem"
            fi
        fi
    fi

    local move_ok=0
    if [ -n "$TARGET_SUBDIR" ]; then
        if "$ATOMIC_MOVE_BIN" "$scan_target" "$CATEGORY" "$TARGET_SUBDIR"; then
            move_ok=1
        fi
    else
        if "$ATOMIC_MOVE_BIN" "$scan_target" "$CATEGORY"; then
            move_ok=1
        fi
    fi

    if [ "$move_ok" -eq 1 ]; then
        log "OK" "Verified clean media atomically moved: $basename -> $COMPLETED_DIR/$CATEGORY${TARGET_SUBDIR:+/$TARGET_SUBDIR}/"
    else
        alert "CRITICAL: Atomic move failed for: $basename. File left in staging."
        [ -n "$work_dir" ] && rm -rf "$work_dir"
        return 1
    fi

    # Move any remaining extracted subtitle sidecars not already moved alongside primary media
    for srt in "${EXTRACTED_SRTS[@]}"; do
        if [ -f "$srt" ]; then
            local srt_base
            srt_base=$(basename "$srt")
            if [ -n "$TARGET_SUBDIR" ]; then
                if "$ATOMIC_MOVE_BIN" "$srt" "$CATEGORY" "$TARGET_SUBDIR"; then
                    log "OK" "Subtitle sidecar atomically moved: $srt_base -> $COMPLETED_DIR/$CATEGORY/$TARGET_SUBDIR/"
                else
                    alert "WARN: Subtitle atomic move failed for: $srt_base"
                fi
            else
                if "$ATOMIC_MOVE_BIN" "$srt" "$CATEGORY"; then
                    log "OK" "Subtitle sidecar atomically moved: $srt_base -> $COMPLETED_DIR/$CATEGORY/"
                else
                    alert "WARN: Subtitle atomic move failed for: $srt_base"
                fi
            fi
        fi
    done

    # Clean up original staged source after sanitized work copy moved safely
    if [ "$remuxed" -eq 1 ] && [ -f "$file" ]; then
        rm -f "$file"
    fi
    [ -n "$work_dir" ] && rm -rf "$work_dir"

    # Notify Radarr/Sonarr import scanner, Jellyfin, and Dashboard Priority Engine
    notify_servarr_import "$CATEGORY" "$TARGET_SUBDIR" || true
    notify_jellyfin_resilient || true

    if command -v curl >/dev/null 2>&1; then
        local dash_payload
        dash_payload="$(build_json_kv_payload "file" "$basename" "category" "$CATEGORY")"
        curl -s --max-time 3 -X POST "${DASHBOARD_URL%/}/api/downloads/gatekeeper-complete" \
             -H "Content-Type: application/json" \
             -d "$dash_payload" >/dev/null 2>&1 || true
    fi
    return 0
}

cleanup_finished_releases() {
    local release_dir
    while IFS= read -r -d '' release_dir; do
        [ -d "$release_dir" ] || continue
        local has_active=0
        local f f_base f_lower rel_sub rel_lower
        while IFS= read -r -d '' f; do
            f_base=$(basename "$f")
            f_lower=$(echo "$f_base" | tr '[:upper:]' '[:lower:]')
            rel_sub="${f#$STAGING_DIR/}"
            rel_lower=$(echo "$rel_sub" | tr '[:upper:]' '[:lower:]')

            case "$f_lower" in
                .*|*.part|*.!qb|*.crdownload|*.tmp|*.sanitized.*|*.aria2)
                    has_active=1
                    break
                    ;;
            esac

            if is_harmless_metadata_name "$f_lower" || is_sample_clip "$rel_lower" "$f"; then
                continue
            fi

            # Real media or unknown file still present -> release is not finished
            has_active=1
            break
        done < <(find "$release_dir" -type f -print0 2>/dev/null)

        if [ "$has_active" -eq 0 ]; then
            while IFS= read -r -d '' f; do
                f_base=$(basename "$f")
                f_lower=$(echo "$f_base" | tr '[:upper:]' '[:lower:]')
                rel_sub="${f#$STAGING_DIR/}"
                rel_lower=$(echo "$rel_sub" | tr '[:upper:]' '[:lower:]')
                if is_harmless_metadata_name "$f_lower" || is_sample_clip "$rel_lower" "$f"; then
                    log "CLEAN" "Removing finished release metadata/sample: $rel_sub"
                    rm -f "$f"
                fi
            done < <(find "$release_dir" -type f -print0 2>/dev/null)
        fi
    done < <(find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print0 2>/dev/null)

    # Remove empty subdirectories left anywhere under STAGING_DIR (excluding hidden work dirs)
    find "$STAGING_DIR" -mindepth 1 -depth -type d \
        ! -name '.gatekeeper-work' ! -path "$STAGING_DIR/.gatekeeper-work/*" \
        ! -name '.gatekeeper-tmp' ! -path "$STAGING_DIR/.gatekeeper-tmp/*" \
        ! -name '.*' -empty -delete 2>/dev/null || true

    # Clean stale top-level harmless metadata (>1m old) only when staging has no active files/folders left
    local remaining_non_meta=0
    local top_f top_base top_lower
    while IFS= read -r -d '' top_f; do
        top_base=$(basename "$top_f")
        top_lower=$(echo "$top_base" | tr '[:upper:]' '[:lower:]')
        if is_harmless_metadata_name "$top_lower" || is_sample_clip "$top_lower" "$top_f"; then
            continue
        fi
        remaining_non_meta=1
        break
    done < <(find "$STAGING_DIR" -mindepth 1 -maxdepth 4 \
        \( -path "$STAGING_DIR/.gatekeeper-work" -o -path "$STAGING_DIR/.gatekeeper-work/*" -o -path "$STAGING_DIR/.gatekeeper-tmp" -o -path "$STAGING_DIR/.gatekeeper-tmp/*" \) -prune \
        -o -type f ! -name '.*' -print0 2>/dev/null)

    if [ "$remaining_non_meta" -eq 0 ]; then
        while IFS= read -r -d '' top_f; do
            top_base=$(basename "$top_f")
            top_lower=$(echo "$top_base" | tr '[:upper:]' '[:lower:]')
            if is_harmless_metadata_name "$top_lower" || is_sample_clip "$top_lower" "$top_f"; then
                log "CLEAN" "Removing stale staging metadata/sample: $top_base"
                rm -f "$top_f"
            fi
        done < <(find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -mmin +1 -print0 2>/dev/null)
    fi
}

main() {
    local count=0
    mkdir -p "$STAGING_DIR"

    # Clean any stale work directories left behind by a previous killed run
    if [ -d "$WORK_ROOT" ]; then
        find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    fi

    while IFS= read -r -d '' file; do
        [ -e "$file" ] || continue
        [ -f "$file" ] || continue

        local rel_path fname fname_lower rel_lower
        rel_path="${file#$STAGING_DIR/}"
        fname=$(basename "$file")
        fname_lower=$(echo "$fname" | tr '[:upper:]' '[:lower:]')
        rel_lower=$(echo "$rel_path" | tr '[:upper:]' '[:lower:]')

        # Skip hidden files/folders and partial/in-progress temp files
        case "$rel_path" in
            .*|*/.*)
                continue
                ;;
        esac
        case "$fname_lower" in
            *.part|*.!qb|*.crdownload|*.tmp|*.sanitized.*|*.aria2)
                log "SKIP" "Skipping partial/temp file: $rel_path"
                continue
                ;;
        esac

        # Immediately quarantine/purge dangerous executables or scripts
        if is_dangerous_executable_name "$fname_lower"; then
            alert "[Stage 1] BLOCKED: Dangerous executable/script purged from staging: $rel_path"
            rm -f "$file"
            continue
        fi

        # Skip tiny sample clips (<50MB) and harmless non-media torrent metadata
        if is_sample_clip "$rel_lower" "$file"; then
            log "SKIP" "Skipping sample clip (<50MB): $rel_path"
            continue
        fi
        if is_harmless_metadata_name "$fname_lower"; then
            log "SKIP" "Skipping torrent metadata file: $rel_path"
            continue
        fi

        if process_file "$file"; then
            count=$(( count + 1 ))
        fi
    done < <(find "$STAGING_DIR" -mindepth 1 -maxdepth 4 \
        \( -path "$STAGING_DIR/.gatekeeper-work" -o -path "$STAGING_DIR/.gatekeeper-work/*" -o -path "$STAGING_DIR/.gatekeeper-tmp" -o -path "$STAGING_DIR/.gatekeeper-tmp/*" \) -prune \
        -o -type f -print0 2>/dev/null | sort -z)

    cleanup_finished_releases

    if [ "$count" -gt 0 ]; then
        log "INFO" "Gatekeeper cycle complete. Processed $count file(s)."
        if [ "$JELLYFIN_PREFLIGHT_DOWN" -eq 1 ]; then
            JELLYFIN_PREFLIGHT_DOWN=0
            notify_jellyfin_resilient || true
        fi
    fi
}

main
