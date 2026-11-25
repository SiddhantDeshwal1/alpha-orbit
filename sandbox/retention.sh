#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Jellyfin-Aware Retention Engine v3.0 (True Inactive Usage)
# Purges media strictly by inactive usage across ALL Jellyfin users:
#   - Active Playback Guard (/Sessions): currently playing/paused media NEVER deleted
#   - Played items: purged only when (now - max(UserData.LastPlayedDate)) >= INACTIVE_MAX_AGE_DAYS
#   - Unplayed items: purged when (now - file_mtime) >= UNWATCHED_MAX_AGE_DAYS
# Fail-closed: aborts safely if Jellyfin API is unreachable or rejects auth.
# ==============================================================================

set -uo pipefail

# ------------------------------------------------------------------------------
# Configuration & CLI Flags
# ------------------------------------------------------------------------------
DRY_RUN="${DRY_RUN:-false}"

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run|-n)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            cat <<'EOF'
Usage: retention.sh [--dry-run|-n] [--help|-h]

Environment overrides:
  JELLYFIN_INTERNAL_URL   Primary internal Jellyfin base URL
  JELLYFIN_URL            Configured Jellyfin base URL
  JELLYFIN_API_KEY        Required Jellyfin API token
  COMPLETED_DIR           Media directory to audit (default: /data/media/completed)
  INACTIVE_MAX_AGE_DAYS   Days after last play across all users (default: 7)
  UNWATCHED_MAX_AGE_DAYS  Days from file mtime when never played (default: 7)
  UNMONITOR_ON_DELETE     Unmonitor purged items in Radarr/Sonarr (default: true)
  DRY_RUN                 Set true to simulate without deleting (default: false)
  LOG_DIR                 Audit log directory (default: /data/logs)
  LOG_FILE                Explicit audit log file path override
EOF
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

normalize_bool() {
    local val
    val="$(printf '%s' "${1:-false}" | tr '[:upper:]' '[:lower:]')"
    case "$val" in
        1|true|yes|on) echo "true" ;;
        *) echo "false" ;;
    esac
}

DRY_RUN="$(normalize_bool "$DRY_RUN")"
UNMONITOR_ON_DELETE="$(normalize_bool "${UNMONITOR_ON_DELETE:-true}")"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JELLYFIN_INTERNAL_URL="${JELLYFIN_INTERNAL_URL:-}"
JELLYFIN_URL="${JELLYFIN_URL:-}"
JELLYFIN_API_KEY="${JELLYFIN_API_KEY:-}"
COMPLETED_DIR="${COMPLETED_DIR:-/data/media/completed}"
COMPLETED_DIR="${COMPLETED_DIR%/}"
[ -z "$COMPLETED_DIR" ] && COMPLETED_DIR="/"

INACTIVE_MAX_AGE_DAYS="${INACTIVE_MAX_AGE_DAYS:-${WATCHED_MAX_AGE_DAYS:-7}}"
UNWATCHED_MAX_AGE_DAYS="${UNWATCHED_MAX_AGE_DAYS:-7}"

LOG_DIR="${LOG_DIR:-/data/logs}"
AUDIT_LOG="${LOG_FILE:-${AUDIT_LOG:-$LOG_DIR/retention_audit.log}}"
mkdir -p "$(dirname "$AUDIT_LOG")"

RADARR_URL="${RADARR_URL:-}"
RADARR_API_KEY="${RADARR_API_KEY:-}"
SONARR_URL="${SONARR_URL:-}"
SONARR_API_KEY="${SONARR_API_KEY:-}"
NTFY_URL="${NTFY_URL:-}"
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_TOKEN="${NTFY_TOKEN:-}"

log() {
    local level="$1"
    shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '[%s] [RETENTION] [%s] %s\n' "$ts" "$level" "$*" | tee -a "$AUDIT_LOG"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

# Verify required POSIX/container binaries (pure bash + curl + jq, zero python3)
for bin in curl jq find date stat; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        log "ERROR" "Required dependency '$bin' is missing. Aborting safely."
        exit 0
    fi
done

if ! [[ "$INACTIVE_MAX_AGE_DAYS" =~ ^[0-9]+$ ]] || ! [[ "$UNWATCHED_MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then
    log "ERROR" "Invalid age threshold (INACTIVE_MAX_AGE_DAYS='$INACTIVE_MAX_AGE_DAYS', UNWATCHED_MAX_AGE_DAYS='$UNWATCHED_MAX_AGE_DAYS'). Aborting safely."
    exit 0
fi

if [ ! -d "$COMPLETED_DIR" ]; then
    log "WARN" "COMPLETED_DIR '$COMPLETED_DIR' does not exist. Nothing to audit."
    exit 0
fi

if [ -z "$JELLYFIN_API_KEY" ]; then
    log "ERROR" "JELLYFIN_API_KEY is not set. Fail-closed: aborting retention audit without deleting any media."
    exit 0
fi

# ------------------------------------------------------------------------------
# HTTP & Jellyfin Discovery Helpers
# ------------------------------------------------------------------------------
CURL_LAST_CODE="000"

http_request() {
    local method="$1"
    local url="$2"
    local out_file="$3"
    local timeout="${4:-15}"
    local data="${5:-}"
    shift 5 || true

    local code=""
    if [ -n "$data" ]; then
        code="$(curl -s -o "$out_file" -w "%{http_code}" --max-time "$timeout" \
            -X "$method" "$@" -d "$data" "$url" 2>/dev/null)" || true
    else
        code="$(curl -s -o "$out_file" -w "%{http_code}" --max-time "$timeout" \
            -X "$method" "$@" "$url" 2>/dev/null)" || true
    fi
    [ -z "$code" ] && code="000"
    CURL_LAST_CODE="$code"
}

jf_auth_header() {
    printf 'Authorization: MediaBrowser Client="OrbitRetention", Device="Retention", DeviceId="orbit-retention", Version="2.0", Token="%s"' "$JELLYFIN_API_KEY"
}

jf_get() {
    local url="$1"
    local out_file="$2"
    local timeout="${3:-15}"
    http_request "GET" "$url" "$out_file" "$timeout" "" \
        -H "Accept: application/json" \
        -H "$(jf_auth_header)"
}

dedup_urls() {
    local seen=""
    local raw clean
    for raw in "$@"; do
        clean="${raw%/}"
        [ -z "$clean" ] && continue
        case " $seen " in
            *" $clean "*) continue ;;
        esac
        seen="$seen $clean"
        printf '%s\n' "$clean"
    done
}

JELLYFIN_BASE=""
PROBE_ERRORS=""
USERS_FILE="$TMP_DIR/users.json"

while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    jf_get "${candidate}/Users" "$USERS_FILE" 8
    if [ "$CURL_LAST_CODE" = "200" ] && jq -e 'type == "array"' "$USERS_FILE" >/dev/null 2>&1; then
        JELLYFIN_BASE="$candidate"
        log "INFO" "Jellyfin connectivity & auth verified at ${JELLYFIN_BASE}/Users (HTTP 200)."
        break
    fi

    # Distinguish auth rejection from transport/unconfigured endpoints
    local_detail="${candidate}/Users -> HTTP ${CURL_LAST_CODE}"
    if [ "$CURL_LAST_CODE" = "404" ] || [ "$CURL_LAST_CODE" = "405" ]; then
        http_request "GET" "${candidate}/System/Info/Public" "$TMP_DIR/sysinfo.json" 6 "" -H "Accept: application/json"
        local_detail="${local_detail} (/System/Info/Public -> HTTP ${CURL_LAST_CODE})"
    elif [ "$CURL_LAST_CODE" = "401" ] || [ "$CURL_LAST_CODE" = "403" ]; then
        log "ERROR" "Jellyfin rejected API credentials at ${candidate}/Users (HTTP ${CURL_LAST_CODE})."
    else
        log "WARN" "Jellyfin probe failed at ${candidate}/Users (HTTP ${CURL_LAST_CODE})."
    fi
    PROBE_ERRORS="${PROBE_ERRORS}${PROBE_ERRORS:+; }${local_detail}"
done < <(dedup_urls \
    "$JELLYFIN_INTERNAL_URL" \
    "$JELLYFIN_URL" \
    "http://alpha-prod-tailscale:8096" \
    "http://alpha-prod-jellyfin:8096" \
    "http://127.0.0.1:8096")

if [ -z "$JELLYFIN_BASE" ]; then
    log "ERROR" "Fail-closed: unable to verify Jellyfin state across all candidate URLs (${PROBE_ERRORS}). Exiting safely with zero deletions."
    exit 0
fi

# Extract all registered user IDs (fail-closed if empty)
mapfile -t USER_IDS < <(jq -r '.[].Id // empty' "$USERS_FILE" 2>/dev/null || true)
if [ "${#USER_IDS[@]}" -eq 0 ]; then
    log "ERROR" "Fail-closed: Jellyfin returned 0 users from ${JELLYFIN_BASE}/Users. Exiting safely."
    exit 0
fi

# ------------------------------------------------------------------------------
# Active Playback Guard (/Sessions) & Per-Run Cached User Inventories
# ------------------------------------------------------------------------------
SESSIONS_RAW="$TMP_DIR/sessions.json"
ACTIVE_SESSIONS_FILE="$TMP_DIR/active_sessions.json"

jf_get "${JELLYFIN_BASE}/Sessions" "$SESSIONS_RAW" 10
if [ "$CURL_LAST_CODE" != "200" ] || ! jq -e 'type == "array"' "$SESSIONS_RAW" >/dev/null 2>&1; then
    log "ERROR" "Fail-closed: failed to query active playback sessions at ${JELLYFIN_BASE}/Sessions (HTTP ${CURL_LAST_CODE}). Exiting safely."
    exit 0
fi

# Shared jq normalization/date helpers used across inventory merge & file matching
read -r -d '' JQ_COMMON_DEFS <<'JQEOF' || true
def norm_str:
  (. // "") | tostring | ascii_downcase | gsub("[^a-z0-9]+"; " ") | sub("^ +"; "") | sub(" +$"; "");

def norm_path:
  (. // "") | tostring | gsub("\\\\"; "/");

def path_base_lower:
  norm_path | ascii_downcase | split("/") | last // "";

def parse_iso_epoch:
  if (. == null or . == "") then 0
  else
    (tostring | capture("^(?<dt>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?<tz>Z|[+-][0-9]{2}:[0-9]{2})?$") // null) as $m
    | if $m == null then 0
      else
        (try (($m.dt + "Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) catch 0) as $utc
        | if $utc == 0 then 0
          elif ($m.tz == null or $m.tz == "" or $m.tz == "Z") then $utc
          else
            ($m.tz | capture("^(?<sign>[+-])(?<hh>[0-9]{2}):(?<mm>[0-9]{2})$")) as $o
            | (($o.hh | tonumber) * 3600 + ($o.mm | tonumber) * 60) as $off
            | if $o.sign == "+" then ($utc - $off) else ($utc + $off) end
          end
      end
  end;

def is_generic_ep_filename:
  test("^(s[0-9]{1,2}e[0-9]{1,3}|e[0-9]{1,3}|ep[ ._0-9-]*|episode[ ._0-9-]*|[0-9]{1,3})\\.[a-z0-9]+$"; "i");

def item_match_tier($media_lower; $rel_lower; $parent_file_lower; $base_lower; $norm_clean; $season; $episode; $year):
  if (.path_lower != "" and .path_lower == $media_lower) then 1
  elif (.path_lower != "" and $rel_lower != "" and ($rel_lower | contains("/")) and (.path_lower | endswith("/" + $rel_lower))) then 2
  elif (.path_lower != "" and $parent_file_lower != "" and (.path_lower | endswith("/" + $parent_file_lower))) then 3
  elif (.basename_lower != "" and .basename_lower == $base_lower and (($base_lower | is_generic_ep_filename) | not)) then 4
  elif ($season != null and $episode != null and .type == "Episode" and $norm_clean != "" and .norm_series == $norm_clean and .season == $season and .episode == $episode) then 5
  elif ($season == null and .type != "Episode" and $norm_clean != "" and .norm_title == $norm_clean and ($year == null or .year == null or .year == $year)) then 6
  else 0
  end;
JQEOF

jq "$JQ_COMMON_DEFS"'
  [ .[]
    | select(.NowPlayingItem != null)
    | .NowPlayingItem as $npi
    | {
        id: (($npi.Id // "") | tostring),
        type: ($npi.Type // ""),
        name: ($npi.Name // ""),
        series_name: ($npi.SeriesName // ""),
        season: ($npi.ParentIndexNumber // null),
        episode: ($npi.IndexNumber // null),
        year: ($npi.ProductionYear // null),
        path: ($npi.Path // "" | norm_path),
        path_lower: ($npi.Path // "" | norm_path | ascii_downcase),
        basename_lower: ($npi.Path // "" | path_base_lower),
        norm_title: ($npi.Name | norm_str),
        norm_series: ($npi.SeriesName | norm_str)
      }
  ]
' "$SESSIONS_RAW" > "$ACTIVE_SESSIONS_FILE"

ACTIVE_COUNT="$(jq 'length' "$ACTIVE_SESSIONS_FILE")"

USER_ITEM_FILES=()
for uid in "${USER_IDS[@]}"; do
    user_file="$TMP_DIR/items_${uid}.json"
    items_url="${JELLYFIN_BASE}/Users/${uid}/Items?Recursive=true&IncludeItemTypes=Movie,Episode,Audio,MusicVideo&Fields=Path,UserData"
    jf_get "$items_url" "$user_file" 30
    if [ "$CURL_LAST_CODE" != "200" ] || ! jq -e '((.Items? // .) | type) == "array"' "$user_file" >/dev/null 2>&1; then
        log "ERROR" "Fail-closed: failed to cache inventory for user ${uid} at ${items_url} (HTTP ${CURL_LAST_CODE}). Exiting safely."
        exit 0
    fi
    USER_ITEM_FILES+=("$user_file")
done

MERGED_INVENTORY_FILE="$TMP_DIR/merged_inventory.json"
jq -s "$JQ_COMMON_DEFS"'
  [ .[] | (.Items? // .)[]
    | {
        id: ((.Id // "") | tostring),
        type: (.Type // ""),
        name: (.Name // ""),
        series_name: (.SeriesName // ""),
        season: (.ParentIndexNumber // null),
        episode: (.IndexNumber // null),
        year: (.ProductionYear // null),
        path: (.Path // "" | norm_path),
        path_lower: (.Path // "" | norm_path | ascii_downcase),
        basename_lower: (.Path // "" | path_base_lower),
        norm_title: (.Name | norm_str),
        norm_series: (.SeriesName | norm_str),
        last_played_date: (.UserData.LastPlayedDate // ""),
        last_played_epoch: ((.UserData.LastPlayedDate // "") | parse_iso_epoch),
        play_count: (if ((.UserData.Played // false) == true and ((.UserData.PlayCount // 0) == 0)) then 1 else (.UserData.PlayCount // 0) end),
        played: (.UserData.Played // false),
        playback_ticks: (.UserData.PlaybackPositionTicks // 0)
      }
  ]
  | group_by(if .id != "" then .id else .path_lower end)
  | map(
      (max_by(.last_played_epoch)) as $latest
      | {
          id: .[0].id,
          type: (map(select(.type != "")) | .[0].type // ""),
          name: (map(select(.name != "")) | .[0].name // ""),
          series_name: (map(select(.series_name != "")) | .[0].series_name // ""),
          season: (map(select(.season != null)) | .[0].season // null),
          episode: (map(select(.episode != null)) | .[0].episode // null),
          year: (map(select(.year != null)) | .[0].year // null),
          path: (map(select(.path != "")) | .[0].path // ""),
          path_lower: (map(select(.path_lower != "")) | .[0].path_lower // ""),
          basename_lower: (map(select(.basename_lower != "")) | .[0].basename_lower // ""),
          norm_title: (map(select(.norm_title != "")) | .[0].norm_title // ""),
          norm_series: (map(select(.norm_series != "")) | .[0].norm_series // ""),
          max_last_played_epoch: ($latest.last_played_epoch // 0),
          max_last_played_date: (if ($latest.last_played_epoch // 0) > 0 then ($latest.last_played_date // "") else "" end),
          total_plays: (map(.play_count) | add // 0),
          any_played: any(.played == true or .play_count > 0),
          max_playback_ticks: (map(.playback_ticks) | max // 0)
        }
    )
' "${USER_ITEM_FILES[@]}" > "$MERGED_INVENTORY_FILE"

INVENTORY_COUNT="$(jq 'length' "$MERGED_INVENTORY_FILE")"

# ------------------------------------------------------------------------------
# Title, Episode & File Helper Functions
# ------------------------------------------------------------------------------
extract_clean_title() {
    local raw="$1"
    local base parent
    base="$(basename "$raw")"
    base="${base%.*}"

    parent="$(basename "$(dirname "$raw")")"
    local parent_lower
    parent_lower="$(printf '%s' "$parent" | tr '[:upper:]' '[:lower:]')"
    if [[ "$parent_lower" =~ ^(s[0-9]+|season[ ._-]*[0-9]+|specials)$ ]]; then
        parent="$(basename "$(dirname "$(dirname "$raw")")")"
        parent_lower="$(printf '%s' "$parent" | tr '[:upper:]' '[:lower:]')"
    fi
    if [[ "$parent_lower" != "movies" && "$parent_lower" != "series" && "$parent_lower" != "podcasts" && "$parent_lower" != "music" && "$parent_lower" != "completed" && "$parent_lower" != "staging" && -n "$parent" && "$parent" != "." && "$parent" != "/" ]]; then
        base="$parent"
    fi

    # Replace dots/underscores with spaces and normalize case-insensitively without GNU sed /I
    local clean
    clean="$(printf '%s' "$base" | sed -E 's/[._]+/ /g; s/\[[^]]*\]//g')"
    # Strip release year (and everything after) only when preceded by a title (preserves "1917", "Blade Runner 2049", "2001 A Space Odyssey")
    clean="$(printf '%s' "$clean" | sed -E 's/^(.+[^([[:space:]-])[([[:space:]-]+(19[0-9]{2}|20[0-9]{2})([]. ) -].*)?$/\1/')"
    clean="$(printf '%s' "$clean" | sed -E 's/\b([Ss][0-9]{1,2}[Ee][0-9]{1,3}|[Ss][0-9]{1,2}|[Ss][Ee][Aa][Ss][Oo][Nn][ ]*[0-9]+)\b.*//')"
    clean="$(printf '%s' "$clean" | sed -E 's/\b([0-9]{3,4}[pP]|4[kK]|[uU][hH][dD]|[bB][lL][uU][rR][aA][yY]|[bB][lL][uU]-[rR][aA][yY]|[wW][eE][bB]-[dD][lL]|[wW][eE][bB][rR][iI][pP]|[hH][dD][tT][vV]|[bB][dD][rR][iI][pP]|[dD][vV][dD][rR][iI][pP]|[rR][eE][mM][uU][xX]|[xXhH]\.?26[45]|[hH][eE][vV][cC]|[aA][aA][cC]|[dD][tT][sS]|[tT][rR][uU][eE][hH][dD]|[aA][tT][mM][oO][sS]|[rR][eE][pP][aA][cC][kK])\b.*//')"
    clean="$(printf '%s' "$clean" | tr -s ' ' | sed -E 's/^[[:space:]-]+//; s/[[:space:]-]+$//')"

    if [ -z "$clean" ]; then
        clean="$(basename "$raw")"
        clean="${clean%.*}"
    fi
    printf '%s' "$clean"
}

parse_season_episode() {
    local name="$1"
    local season="null"
    local episode="null"
    local old_nocase
    old_nocase="$(shopt -p nocasematch || true)"
    shopt -s nocasematch
    if [[ "$name" =~ s([0-9]{1,2})[._-]*e([0-9]{1,3}) ]]; then
        season="$((10#${BASH_REMATCH[1]}))"
        episode="$((10#${BASH_REMATCH[2]}))"
    elif [[ "$name" =~ (^|[^0-9])([0-9]{1,2})x([0-9]{2,3})([^0-9]|$) ]]; then
        season="$((10#${BASH_REMATCH[2]}))"
        episode="$((10#${BASH_REMATCH[3]}))"
    fi
    eval "$old_nocase" >/dev/null 2>&1 || true
    printf '%s %s' "$season" "$episode"
}

parse_year() {
    local text="$1"
    if [[ "$text" =~ (^|[^0-9])((19|20)[0-9]{2})([^0-9]|$) ]]; then
        printf '%s' "${BASH_REMATCH[2]}"
    else
        printf 'null'
    fi
}

cleanup_subtitle_sidecars() {
    local media_file="$1"
    local stem="${media_file%.*}"
    local old_nullglob
    old_nullglob="$(shopt -p nullglob || true)"
    shopt -s nullglob

    local ext sidecar
    for ext in srt vtt ass SRT VTT ASS; do
        for sidecar in "${stem}.${ext}" "${stem}."*.${ext}; do
            if [ -f "$sidecar" ]; then
                rm -f -- "$sidecar"
            fi
        done
    done

    eval "$old_nullglob" >/dev/null 2>&1 || true
}

cleanup_empty_parents() {
    local dir="${1%/}"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
        if [[ "$dir" == "$COMPLETED_DIR/Movies/"* || "$dir" == "$COMPLETED_DIR/Series/"* ]]; then
            rmdir -- "$dir" 2>/dev/null || break
            dir="$(dirname "$dir")"
            dir="${dir%/}"
        else
            break
        fi
    done
}

# ------------------------------------------------------------------------------
# Downstream Sync (Radarr & Sonarr Unmonitor + File Record Cleanup)
# ------------------------------------------------------------------------------
read_arr_key_from_xml() {
    local xml_path="$1"
    local placeholder="$2"
    if [ -r "$xml_path" ]; then
        local found
        found="$(sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' "$xml_path" 2>/dev/null | head -n 1 | tr -d '[:space:]')"
        if [ -n "$found" ] && [ "$found" != "$placeholder" ]; then
            printf '%s' "$found"
        fi
    fi
}

[ -z "$RADARR_API_KEY" ] && RADARR_API_KEY="$(read_arr_key_from_xml "$SCRIPT_DIR/radarr/config.xml" "YOUR_RADARR_API_KEY")"
[ -z "$SONARR_API_KEY" ] && SONARR_API_KEY="$(read_arr_key_from_xml "$SCRIPT_DIR/sonarr/config.xml" "YOUR_SONARR_API_KEY")"

RADARR_BASE=""
RADARR_INIT_DONE=false
RADARR_MOVIES_FILE="$TMP_DIR/radarr_movies.json"

init_radarr() {
    [ "$RADARR_INIT_DONE" = true ] && return
    RADARR_INIT_DONE=true
    if [ -z "$RADARR_API_KEY" ]; then
        log "INFO" "Radarr unmonitor skipped: RADARR_API_KEY not configured."
        return
    fi

    while IFS= read -r candidate; do
        [ -z "$candidate" ] && continue
        http_request "GET" "${candidate}/api/v3/movie" "$RADARR_MOVIES_FILE" 8 "" \
            -H "Accept: application/json" \
            -H "X-Api-Key: ${RADARR_API_KEY}"
        if [ "$CURL_LAST_CODE" = "200" ] && jq -e 'type == "array"' "$RADARR_MOVIES_FILE" >/dev/null 2>&1; then
            RADARR_BASE="$candidate"
            return
        fi
    done < <(dedup_urls \
        "$RADARR_URL" \
        "http://alpha-prod-gluetun:7878" \
        "http://alpha-prod-radarr:7878" \
        "http://127.0.0.1:7878")

    log "WARN" "Radarr unreachable or rejected API key (HTTP ${CURL_LAST_CODE}); continuing without Radarr unmonitor."
}

unmonitor_radarr_movie() {
    local media_file="$1"
    local rel_path="$2"
    local clean_title="$3"
    local year_num="$4"

    init_radarr
    [ -z "$RADARR_BASE" ] && return 0

    local parent_lower
    parent_lower="$(printf '%s' "$(basename "$(dirname "$media_file")")/$(basename "$media_file")" | tr '[:upper:]' '[:lower:]')"
    if [[ "$parent_lower" == "movies/"* ]]; then
        parent_lower=""
    fi

    local match_json
    match_json="$(jq -c "$JQ_COMMON_DEFS"'
        ($media | norm_path | ascii_downcase) as $ml
        | ($rel | norm_path | ascii_downcase) as $rl
        | ($pfile | ascii_downcase) as $pfl
        | ($clean | norm_str) as $nc
        | [ .[]
            | (.movieFile.path // "" | norm_path | ascii_downcase) as $fpl
            | (.path // "" | norm_path | ascii_downcase) as $mpl
            | (.title | norm_str) as $nt
            | (
                if ($fpl != "" and $fpl == $ml) then 1
                elif ($fpl != "" and $rl != "" and ($rl | contains("/")) and ($fpl | endswith("/" + $rl))) then 2
                elif ($fpl != "" and $pfl != "" and ($fpl | endswith("/" + $pfl))) then 3
                elif ($mpl != "" and ($ml | startswith($mpl + "/"))) then 4
                elif ($nc != "" and $nt == $nc and ($year == null or .year == null or .year == $year)) then 5
                else 0
                end
              ) as $tier
            | select($tier > 0)
            | {tier: $tier, movie: .}
          ]
        | sort_by(.tier)
        | .[0].movie // empty
    ' --arg media "$media_file" --arg rel "$rel_path" --arg pfile "$parent_lower" --arg clean "$clean_title" --argjson year "$year_num" "$RADARR_MOVIES_FILE")"

    if [ -z "$match_json" ]; then
        log "INFO" "Radarr: no matching movie found for '$rel_path'."
        return 0
    fi

    local movie_id movie_title movie_file_id
    movie_id="$(printf '%s' "$match_json" | jq -r '.id')"
    movie_title="$(printf '%s' "$match_json" | jq -r '.title // "unknown"')"
    movie_file_id="$(printf '%s' "$match_json" | jq -r '.movieFile.id // 0')"

    local payload_file="$TMP_DIR/radarr_put.json"
    printf '%s' "$match_json" | jq '.monitored = false' > "$payload_file"
    http_request "PUT" "${RADARR_BASE}/api/v3/movie/${movie_id}" "$TMP_DIR/radarr_put_resp.json" 10 "$(cat "$payload_file")" \
        -H "Content-Type: application/json" \
        -H "X-Api-Key: ${RADARR_API_KEY}"

    if [ "$CURL_LAST_CODE" = "200" ] || [ "$CURL_LAST_CODE" = "202" ] || [ "$CURL_LAST_CODE" = "204" ]; then
        log "INFO" "Radarr: set monitored=false for movie id=${movie_id} ('${movie_title}')."
    else
        log "WARN" "Radarr: failed to unmonitor movie id=${movie_id} (HTTP ${CURL_LAST_CODE})."
    fi

    if [ "$movie_file_id" != "0" ] && [ -n "$movie_file_id" ] && [ "$movie_file_id" != "null" ]; then
        http_request "DELETE" "${RADARR_BASE}/api/v3/moviefile/${movie_file_id}" "$TMP_DIR/radarr_del_resp.json" 10 "" \
            -H "X-Api-Key: ${RADARR_API_KEY}"
        if [ "$CURL_LAST_CODE" = "200" ] || [ "$CURL_LAST_CODE" = "204" ]; then
            log "INFO" "Radarr: deleted movieFile record id=${movie_file_id} for '${movie_title}'."
        else
            log "WARN" "Radarr: failed to delete movieFile id=${movie_file_id} (HTTP ${CURL_LAST_CODE})."
        fi
    fi
}

SONARR_BASE=""
SONARR_INIT_DONE=false
SONARR_SERIES_FILE="$TMP_DIR/sonarr_series.json"

init_sonarr() {
    [ "$SONARR_INIT_DONE" = true ] && return
    SONARR_INIT_DONE=true
    if [ -z "$SONARR_API_KEY" ]; then
        log "INFO" "Sonarr unmonitor skipped: SONARR_API_KEY not configured."
        return
    fi

    while IFS= read -r candidate; do
        [ -z "$candidate" ] && continue
        http_request "GET" "${candidate}/api/v3/series" "$SONARR_SERIES_FILE" 8 "" \
            -H "Accept: application/json" \
            -H "X-Api-Key: ${SONARR_API_KEY}"
        if [ "$CURL_LAST_CODE" = "200" ] && jq -e 'type == "array"' "$SONARR_SERIES_FILE" >/dev/null 2>&1; then
            SONARR_BASE="$candidate"
            return
        fi
        # Minimal fallback if /api/v3/series is unavailable but /api/v3/episode responds
        http_request "GET" "${candidate}/api/v3/episode" "$TMP_DIR/sonarr_ep_probe.json" 8 "" \
            -H "Accept: application/json" \
            -H "X-Api-Key: ${SONARR_API_KEY}"
        if [ "$CURL_LAST_CODE" = "200" ] && jq -e 'type == "array"' "$TMP_DIR/sonarr_ep_probe.json" >/dev/null 2>&1; then
            echo "[]" > "$SONARR_SERIES_FILE"
            SONARR_BASE="$candidate"
            return
        fi
    done < <(dedup_urls \
        "$SONARR_URL" \
        "http://alpha-prod-gluetun:8989" \
        "http://alpha-prod-sonarr:8989" \
        "http://127.0.0.1:8989")

    log "WARN" "Sonarr unreachable or rejected API key (HTTP ${CURL_LAST_CODE}); continuing without Sonarr unmonitor."
}

unmonitor_sonarr_episode() {
    local media_file="$1"
    local rel_path="$2"
    local clean_title="$3"
    local season_num="$4"
    local episode_num="$5"

    init_sonarr
    [ -z "$SONARR_BASE" ] && return 0

    local series_id
    series_id="$(jq -r "$JQ_COMMON_DEFS"'
        ($media | norm_path | ascii_downcase) as $ml
        | ($clean | norm_str) as $nc
        | [ .[]
            | (.path // "" | norm_path | ascii_downcase) as $sp
            | ((.title | norm_str) == $nc or any(.alternateTitles[]?.title?; (. | norm_str) == $nc)) as $title_ok
            | (
                if ($sp != "" and ($ml | startswith($sp + "/"))) then 1
                elif ($nc != "" and $title_ok) then 2
                else 0
                end
              ) as $tier
            | select($tier > 0)
            | {tier: $tier, id: .id}
          ]
        | sort_by(.tier)
        | .[0].id // empty
    ' --arg media "$media_file" --arg clean "$clean_title" "$SONARR_SERIES_FILE")"

    local ep_file epfile_file ep_url epfile_url
    if [ -n "$series_id" ]; then
        ep_file="$TMP_DIR/sonarr_ep_${series_id}.json"
        epfile_file="$TMP_DIR/sonarr_epfile_${series_id}.json"
        ep_url="${SONARR_BASE}/api/v3/episode?seriesId=${series_id}"
        epfile_url="${SONARR_BASE}/api/v3/episodefile?seriesId=${series_id}"
    else
        ep_file="$TMP_DIR/sonarr_ep_all.json"
        epfile_file="$TMP_DIR/sonarr_epfile_all.json"
        ep_url="${SONARR_BASE}/api/v3/episode"
        epfile_url="${SONARR_BASE}/api/v3/episodefile"
    fi

    if [ ! -f "$ep_file" ]; then
        http_request "GET" "$ep_url" "$ep_file" 10 "" -H "Accept: application/json" -H "X-Api-Key: ${SONARR_API_KEY}"
        if [ "$CURL_LAST_CODE" != "200" ] || ! jq -e 'type == "array"' "$ep_file" >/dev/null 2>&1; then
            echo "[]" > "$ep_file"
        fi
    fi
    if [ ! -f "$epfile_file" ]; then
        http_request "GET" "$epfile_url" "$epfile_file" 10 "" -H "Accept: application/json" -H "X-Api-Key: ${SONARR_API_KEY}"
        if [ "$CURL_LAST_CODE" != "200" ] || ! jq -e 'type == "array"' "$epfile_file" >/dev/null 2>&1; then
            echo "[]" > "$epfile_file"
        fi
    fi

    local parent_lower
    parent_lower="$(printf '%s' "$(basename "$(dirname "$media_file")")/$(basename "$media_file")" | tr '[:upper:]' '[:lower:]')"
    if [[ "$parent_lower" == "series/"* ]]; then
        parent_lower=""
    fi

    local matched_ep_file_id
    matched_ep_file_id="$(jq -r "$JQ_COMMON_DEFS"'
        ($media | norm_path | ascii_downcase) as $ml
        | ($rel | norm_path | ascii_downcase) as $rl
        | ($pfile | ascii_downcase) as $pfl
        | ($media | path_base_lower) as $bl
        | [ .[]
            | (.path // "" | norm_path | ascii_downcase) as $fpl
            | (.path // "" | path_base_lower) as $fbl
            | (
                if ($fpl != "" and $fpl == $ml) then 1
                elif ($fpl != "" and $rl != "" and ($rl | contains("/")) and ($fpl | endswith("/" + $rl))) then 2
                elif ($fpl != "" and $pfl != "" and ($fpl | endswith("/" + $pfl))) then 3
                elif ($fbl != "" and $fbl == $bl and (($bl | is_generic_ep_filename) | not)) then 4
                else 0
                end
              ) as $tier
            | select($tier > 0)
            | {tier: $tier, id: .id}
          ]
        | sort_by(.tier)
        | .[0].id // 0
    ' --arg media "$media_file" --arg rel "$rel_path" --arg pfile "$parent_lower" "$epfile_file")"

    local ep_ids_json
    ep_ids_json="$(jq -c '
        [ .[]
          | select(
              ($efid > 0 and (.episodeFileId // 0) == $efid)
              or ($has_sid and $season != null and $episode != null and .seasonNumber == $season and .episodeNumber == $episode)
            )
          | .id
        ] | unique
    ' --argjson has_sid "$([ -n "$series_id" ] && echo true || echo false)" --argjson efid "${matched_ep_file_id:-0}" --argjson season "$season_num" --argjson episode "$episode_num" "$ep_file")"

    if [ "$(printf '%s' "$ep_ids_json" | jq 'length')" -gt 0 ]; then
        local mon_body
        mon_body="$(jq -nc --argjson ids "$ep_ids_json" '{episodeIds: $ids, monitored: false}')"
        http_request "PUT" "${SONARR_BASE}/api/v3/episode/monitor" "$TMP_DIR/sonarr_mon_resp.json" 10 "$mon_body" \
            -H "Content-Type: application/json" \
            -H "X-Api-Key: ${SONARR_API_KEY}"

        if [ "$CURL_LAST_CODE" = "200" ] || [ "$CURL_LAST_CODE" = "202" ] || [ "$CURL_LAST_CODE" = "204" ]; then
            log "INFO" "Sonarr: set monitored=false for episodeIds=${ep_ids_json}."
        else
            # Fallback to single-episode PUT for older/mocked Sonarr APIs
            local eid ep_put_body
            while IFS= read -r eid; do
                [ -z "$eid" ] && continue
                ep_put_body="$(jq -c --argjson eid "$eid" '.[] | select(.id == $eid) | .monitored = false' "$ep_file")"
                http_request "PUT" "${SONARR_BASE}/api/v3/episode/${eid}" "$TMP_DIR/sonarr_ep_put.json" 10 "$ep_put_body" \
                    -H "Content-Type: application/json" \
                    -H "X-Api-Key: ${SONARR_API_KEY}"
            done < <(printf '%s' "$ep_ids_json" | jq -r '.[]')
            log "INFO" "Sonarr: fallback unmonitor executed for episodeIds=${ep_ids_json} (last HTTP ${CURL_LAST_CODE})."
        fi
    else
        log "INFO" "Sonarr: no matching episode record found for '$rel_path'."
    fi

    if [ "${matched_ep_file_id:-0}" != "0" ] && [ -n "$matched_ep_file_id" ] && [ "$matched_ep_file_id" != "null" ]; then
        http_request "DELETE" "${SONARR_BASE}/api/v3/episodefile/${matched_ep_file_id}" "$TMP_DIR/sonarr_del_resp.json" 10 "" \
            -H "X-Api-Key: ${SONARR_API_KEY}"
        if [ "$CURL_LAST_CODE" = "200" ] || [ "$CURL_LAST_CODE" = "204" ]; then
            log "INFO" "Sonarr: deleted episodeFile record id=${matched_ep_file_id} for '$rel_path'."
        else
            log "WARN" "Sonarr: failed to delete episodeFile id=${matched_ep_file_id} (HTTP ${CURL_LAST_CODE})."
        fi
    fi
}

unmonitor_downstream() {
    local media_file="$1"
    local rel_path="$2"
    local clean_title="$3"
    local season_num="$4"
    local episode_num="$5"
    local year_num="$6"
    local matched_type="$7"

    if [ "$matched_type" = "Episode" ] || [ "$season_num" != "null" ] || [[ "$rel_path" == Series/* ]]; then
        unmonitor_sonarr_episode "$media_file" "$rel_path" "$clean_title" "$season_num" "$episode_num"
    elif [ "$matched_type" = "Movie" ] || [[ "$rel_path" == Movies/* ]]; then
        unmonitor_radarr_movie "$media_file" "$rel_path" "$clean_title" "$year_num"
    fi
}

# ------------------------------------------------------------------------------
# Audit Loop
# ------------------------------------------------------------------------------
log "INFO" "Starting retention audit (dry_run=${DRY_RUN}, inactive_max=${INACTIVE_MAX_AGE_DAYS}d, unwatched_max=${UNWATCHED_MAX_AGE_DAYS}d, unmonitor=${UNMONITOR_ON_DELETE}, users=${#USER_IDS[@]}, inventory=${INVENTORY_COUNT}, active_sessions=${ACTIVE_COUNT})."

PURGED=0
SURVIVED=0
FREED_BYTES=0
PURGED_NAMES=()

read -r -d '' JQ_EVAL_FILTER <<'JQEOF' || true
  ($media | norm_path | ascii_downcase) as $ml
  | ($rel | norm_path | ascii_downcase) as $rl
  | ($pfile | ascii_downcase) as $pfl
  | ($media | path_base_lower) as $bl
  | ($clean | norm_str) as $nc
  | ($inv[0] // []) as $items
  | ($act[0] // []) as $sessions

  # 1. Match inventory across ALL Jellyfin users by tier
  | [ $items[]
      | item_match_tier($ml; $rl; $pfl; $bl; $nc; $season; $episode; $year) as $tier
      | select($tier > 0)
      | {tier: $tier, item: .}
    ] as $inv_hits
  | (if ($inv_hits | length) > 0 then
       ($inv_hits | min_by(.tier) | .tier) as $best_tier
       | ($inv_hits | map(select(.tier == $best_tier) | .item)) as $best_items
       | ($best_items | max_by(.max_last_played_epoch)) as $rep
       | {
           tier: (["none","exact_path","rel_suffix","parent_file","basename","series_sxe","title"][$best_tier]),
           id: $rep.id,
           type: $rep.type,
           name: $rep.name,
           series_name: $rep.series_name,
           path: $rep.path,
           all_ids: ($best_items | map(.id) | unique),
           last_played_epoch: ($best_items | map(.max_last_played_epoch) | max // 0),
           last_played_date: ($rep.max_last_played_date // ""),
           total_plays: ($best_items | map(.total_plays) | max // 0),
           any_played: any($best_items[]; .any_played),
           max_ticks: ($best_items | map(.max_playback_ticks) | max // 0)
         }
     else null end) as $match

  # 2. Check active /Sessions playback guard by item Id OR direct path/title match
  | (any($sessions[];
       (($match != null) and (.id != "") and ((.id as $sid | any($match.all_ids[]; . == $sid))))
       or (item_match_tier($ml; $rl; $pfl; $bl; $nc; $season; $episode; $year) > 0)
     )) as $is_active

  # 3. Compute inactivity / unplayed age in whole days (clamped >= 0)
  | (if ($now > $mtime) then (($now - $mtime) / 86400 | floor) else 0 end) as $file_age_days
  | (if ($match != null and $match.last_played_epoch > 0) then
       (if ($now > $match.last_played_epoch) then (($now - $match.last_played_epoch) / 86400 | floor) else 0 end)
     else null end) as $inactive_days

  # 4. Final retention decision
  | (if $is_active then "RETAIN_ACTIVE"
     elif ($inactive_days != null) then
       (if $inactive_days >= $inactive_max then "PURGE_INACTIVE" else "RETAIN_INACTIVE" end)
     else
       (if $file_age_days >= $unwatched_max then "PURGE_UNPLAYED" else "RETAIN_UNPLAYED" end)
     end) as $decision

  | {
      decision: $decision,
      match_tier: ($match.tier // "none"),
      matched_id: ($match.id // ""),
      matched_type: ($match.type // ""),
      matched_name: ($match.name // ""),
      last_played_epoch: ($match.last_played_epoch // 0),
      last_played_date: ($match.last_played_date // ""),
      inactive_days: ($inactive_days // -1),
      file_age_days: $file_age_days,
      total_plays: ($match.total_plays // 0),
      max_ticks: ($match.max_ticks // 0)
    }
JQEOF

NOW_EPOCH="$(date +%s)"

while IFS= read -r media_file; do
    [ -z "$media_file" ] && continue
    [ ! -f "$media_file" ] && continue

    FILENAME="$(basename "$media_file")"
    REL_PATH="${media_file#"$COMPLETED_DIR"/}"
    PARENT_BASE="$(basename "$(dirname "$media_file")")"
    PARENT_BASE_LOWER="$(printf '%s' "$PARENT_BASE" | tr '[:upper:]' '[:lower:]')"
    PARENT_FILE=""
    if [[ "$PARENT_BASE_LOWER" != "movies" && "$PARENT_BASE_LOWER" != "series" && "$PARENT_BASE_LOWER" != "podcasts" && "$PARENT_BASE_LOWER" != "music" && "$PARENT_BASE_LOWER" != "completed" ]]; then
        PARENT_FILE="${PARENT_BASE}/${FILENAME}"
    fi

    CLEAN_TITLE="$(extract_clean_title "$media_file")"
    read -r SEASON_NUM EPISODE_NUM <<< "$(parse_season_episode "$FILENAME")"
    YEAR_NUM="$(parse_year "$FILENAME")"
    [ "$YEAR_NUM" = "null" ] && YEAR_NUM="$(parse_year "$PARENT_BASE")"

    FILE_MTIME="$(stat -c%Y "$media_file" 2>/dev/null || echo "$NOW_EPOCH")"
    FILE_SIZE="$(stat -c%s "$media_file" 2>/dev/null || echo 0)"

    EVAL_JSON="$(jq -nc \
        --slurpfile inv "$MERGED_INVENTORY_FILE" \
        --slurpfile act "$ACTIVE_SESSIONS_FILE" \
        --arg media "$media_file" \
        --arg rel "$REL_PATH" \
        --arg pfile "$PARENT_FILE" \
        --arg clean "$CLEAN_TITLE" \
        --argjson season "$SEASON_NUM" \
        --argjson episode "$EPISODE_NUM" \
        --argjson year "$YEAR_NUM" \
        --argjson now "$NOW_EPOCH" \
        --argjson mtime "$FILE_MTIME" \
        --argjson inactive_max "$INACTIVE_MAX_AGE_DAYS" \
        --argjson unwatched_max "$UNWATCHED_MAX_AGE_DAYS" \
        "$JQ_COMMON_DEFS $JQ_EVAL_FILTER")"

    mapfile -t EVAL_FIELDS < <(
        printf '%s' "$EVAL_JSON" | jq -r '
            .decision,
            .match_tier,
            (if .matched_id == "" then "-" else .matched_id end),
            (if .matched_type == "" then "-" else .matched_type end),
            (if .last_played_date == "" then "never" else .last_played_date end),
            (.inactive_days | tostring),
            (.file_age_days | tostring),
            (.total_plays | tostring)
        '
    )
    DECISION="${EVAL_FIELDS[0]:-RETAIN_UNPLAYED}"
    MATCH_TIER="${EVAL_FIELDS[1]:-none}"
    MATCHED_ID="${EVAL_FIELDS[2]:--}"
    MATCHED_TYPE="${EVAL_FIELDS[3]:--}"
    LAST_PLAYED_DATE="${EVAL_FIELDS[4]:-never}"
    INACTIVE_DAYS="${EVAL_FIELDS[5]:--1}"
    FILE_AGE_DAYS="${EVAL_FIELDS[6]:-0}"
    TOTAL_PLAYS="${EVAL_FIELDS[7]:-0}"

    case "$DECISION" in
        RETAIN_ACTIVE)
            log "RETAIN" "Retaining actively playing/paused item (title: '$CLEAN_TITLE', id: $MATCHED_ID, match: $MATCH_TIER): $REL_PATH"
            SURVIVED=$(( SURVIVED + 1 ))
            ;;
        PURGE_INACTIVE|PURGE_UNPLAYED)
            if [ "$DECISION" = "PURGE_INACTIVE" ]; then
                REASON="inactive ${INACTIVE_DAYS}d >= ${INACTIVE_MAX_AGE_DAYS}d since last play (last_played: ${LAST_PLAYED_DATE}, plays: ${TOTAL_PLAYS}, file_age: ${FILE_AGE_DAYS}d, match: ${MATCH_TIER})"
            else
                REASON="unplayed ${FILE_AGE_DAYS}d >= ${UNWATCHED_MAX_AGE_DAYS}d from file mtime (plays: 0, match: ${MATCH_TIER})"
            fi

            if [ "$DRY_RUN" = true ]; then
                log "DRY-RUN" "[DRY-RUN] WOULD PURGE ($REASON): $REL_PATH"
                PURGED=$(( PURGED + 1 ))
                FREED_BYTES=$(( FREED_BYTES + FILE_SIZE ))
            else
                log "PURGE" "PURGED ($REASON): $REL_PATH"
                rm -f -- "$media_file"
                cleanup_subtitle_sidecars "$media_file"
                cleanup_empty_parents "$(dirname "$media_file")"

                if [ "$UNMONITOR_ON_DELETE" = true ]; then
                    unmonitor_downstream "$media_file" "$REL_PATH" "$CLEAN_TITLE" "$SEASON_NUM" "$EPISODE_NUM" "$YEAR_NUM" "$MATCHED_TYPE" || true
                fi

                PURGED=$(( PURGED + 1 ))
                FREED_BYTES=$(( FREED_BYTES + FILE_SIZE ))
                PURGED_NAMES+=("$FILENAME")
            fi
            ;;
        RETAIN_INACTIVE)
            log "RETAIN" "Retaining recently used item (title: '$CLEAN_TITLE', inactive: ${INACTIVE_DAYS}d < ${INACTIVE_MAX_AGE_DAYS}d, last_played: ${LAST_PLAYED_DATE}, plays: ${TOTAL_PLAYS}, file_age: ${FILE_AGE_DAYS}d, match: ${MATCH_TIER}): $REL_PATH"
            SURVIVED=$(( SURVIVED + 1 ))
            ;;
        *)
            log "RETAIN" "Retaining unplayed item within window (title: '$CLEAN_TITLE', file_age: ${FILE_AGE_DAYS}d < ${UNWATCHED_MAX_AGE_DAYS}d, match: ${MATCH_TIER}): $REL_PATH"
            SURVIVED=$(( SURVIVED + 1 ))
            ;;
    esac
done < <(find "$COMPLETED_DIR" -type f \( \
    -iname "*.mkv" -o -iname "*.mp4" -o -iname "*.avi" -o -iname "*.mov" \
    -o -iname "*.m4v" -o -iname "*.webm" -o -iname "*.ts" \
    -o -iname "*.mp3" -o -iname "*.m4a" -o -iname "*.m4b" \
    -o -iname "*.ogg" -o -iname "*.opus" -o -iname "*.flac" \
    \) 2>/dev/null | sort)

# ------------------------------------------------------------------------------
# Post-Purge Jellyfin Library Refresh & Batch Notification
# ------------------------------------------------------------------------------
FREED_MB=$(( FREED_BYTES / 1048576 ))

if [ "$DRY_RUN" = false ] && [ "$PURGED" -gt 0 ]; then
    http_request "POST" "${JELLYFIN_BASE}/Library/Refresh" "$TMP_DIR/jf_refresh.txt" 15 "" \
        -H "$(jf_auth_header)"
    if [ "$CURL_LAST_CODE" = "200" ] || [ "$CURL_LAST_CODE" = "204" ]; then
        log "INFO" "Triggered Jellyfin library refresh at ${JELLYFIN_BASE}/Library/Refresh (HTTP ${CURL_LAST_CODE})."
    else
        log "WARN" "Jellyfin library refresh returned HTTP ${CURL_LAST_CODE}."
    fi

    if [ -n "$NTFY_TOPIC" ]; then
        SAMPLE_LIST=""
        COUNT_LIMIT=0
        for pname in "${PURGED_NAMES[@]}"; do
            COUNT_LIMIT=$(( COUNT_LIMIT + 1 ))
            if [ "$COUNT_LIMIT" -le 5 ]; then
                SAMPLE_LIST="${SAMPLE_LIST}"$'\n'"• ${pname}"
            fi
        done
        if [ "$PURGED" -gt 5 ]; then
            SAMPLE_LIST="${SAMPLE_LIST}"$'\n'"…and $(( PURGED - 5 )) more"
        fi
        NTFY_MSG="Purged ${PURGED} inactive media item(s) (~${FREED_MB} MB freed). Retained ${SURVIVED}.${SAMPLE_LIST}"

        while IFS= read -r ntfy_base; do
            [ -z "$ntfy_base" ] && continue
            NTFY_AUTH_ARGS=()
            [ -n "$NTFY_TOKEN" ] && NTFY_AUTH_ARGS+=(-H "Authorization: Bearer ${NTFY_TOKEN}")
            http_request "POST" "${ntfy_base}/${NTFY_TOPIC}" "$TMP_DIR/ntfy_resp.txt" 8 "$NTFY_MSG" \
                -H "Title: Orbit Retention Cleanup" \
                -H "Tags: recycle,wastebasket" \
                "${NTFY_AUTH_ARGS[@]}"
            if [ "$CURL_LAST_CODE" = "200" ] || [ "$CURL_LAST_CODE" = "204" ]; then
                log "INFO" "Dispatched batch summary notification to ntfy (${ntfy_base}/${NTFY_TOPIC})."
                break
            fi
        done < <(dedup_urls "$NTFY_URL" "http://alpha-prod-ntfy:80" "http://127.0.0.1:8003")
    fi
fi

if [ "$DRY_RUN" = true ]; then
    log "INFO" "Retention dry-run complete. Would purge: $PURGED (~${FREED_MB} MB) | Retained: $SURVIVED"
else
    log "INFO" "Retention audit complete. Purged: $PURGED (~${FREED_MB} MB) | Retained: $SURVIVED"
fi
