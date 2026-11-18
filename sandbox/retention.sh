#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Jellyfin-Aware Retention Auditor v2.0
# Purges media based on Jellyfin playback API state:
#   - Watched items older than WATCHED_MAX_AGE_DAYS days -> deleted
#   - Unplayed items older than UNWATCHED_MAX_AGE_DAYS days -> deleted
# Queries the Jellyfin REST API; never relies on atime (unreliable on noatime mounts)
# ==============================================================================

set -uo pipefail

JELLYFIN_URL="${JELLYFIN_URL:-http://alpha-prod-tailscale:8096}"
JELLYFIN_API_KEY="${JELLYFIN_API_KEY:-}"
COMPLETED_DIR="${COMPLETED_DIR:-/data/media/completed}"
WATCHED_MAX_AGE_DAYS="${WATCHED_MAX_AGE_DAYS:-7}"
UNWATCHED_MAX_AGE_DAYS="${UNWATCHED_MAX_AGE_DAYS:-30}"
LOG_DIR="${LOG_DIR:-/data/logs}"
AUDIT_LOG="$LOG_DIR/retention_audit.log"

mkdir -p "$LOG_DIR"

log() {
    local level="$1"
    shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[$ts] [RETENTION] [$level] $*" | tee -a "$AUDIT_LOG"
}

if [ -z "$JELLYFIN_API_KEY" ]; then
    log "ERROR" "JELLYFIN_API_KEY is not set. Retention engine cannot query Jellyfin API. Skipping."
    exit 0
fi

# Pre-flight check: ensure Jellyfin is reachable before proceeding
if ! curl -sf --max-time 10 "$JELLYFIN_URL/System/Ping" >/dev/null 2>&1 && ! curl -sf --max-time 10 "$JELLYFIN_URL/System/Info/Public" >/dev/null 2>&1; then
    log "WARN" "Pre-flight check failed: Jellyfin is unreachable at $JELLYFIN_URL. Skipping retention audit to prevent accidental deletion."
    exit 0
fi

# Extract clean movie/series title from messy filenames or folder paths
extract_clean_title() {
    local raw="$1"
    local base
    base=$(basename "$raw")
    base="${base%.*}"

    local parent
    parent=$(basename "$(dirname "$raw")")
    if [[ "$parent" =~ ^(S[0-9]+|Season[ ._-]*[0-9]+)$ ]]; then
        parent=$(basename "$(dirname "$(dirname "$raw")")")
    fi
    if [[ "$parent" != "Movies" && "$parent" != "Series" && "$parent" != "Podcasts" && "$parent" != "completed" && "$parent" != "staging" && -n "$parent" && "$parent" != "." ]]; then
        base="$parent"
    fi

    # Replace dots and underscores with spaces
    local clean
    clean=$(echo "$base" | sed -E "s/[._]/ /g")

    # If there is a 4-digit release year (19xx or 20xx), truncate everything from the year onwards
    clean=$(echo "$clean" | sed -E "s/[([ -]?(19[0-9]{2}|20[0-9]{2})[]. ) -].*//")

    # If there is a season/episode indicator, truncate everything from there onwards
    clean=$(echo "$clean" | sed -E "s/\b(s[0-9]{1,2}e[0-9]{1,2}|s[0-9]{1,2}|season[ ]*[0-9]+)\b.*//I")

    # Strip bracketed tags [something]
    clean=$(echo "$clean" | sed -E "s/\[[^]]*\]//g")

    # Strip resolution, source, codec keywords if year was missing
    clean=$(echo "$clean" | sed -E "s/\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|web-dl|webrip|hdtv|bdrip|dvdrip|remux|x264|x265|hevc|h264|h265|aac|dts|truehd|atmos|repack)\b.*//I")

    # Clean up trailing/leading spaces and punctuation
    clean=$(echo "$clean" | sed -E "s/[ -]+$//" | sed -E "s/^[ -]+//")
    clean=$(echo "$clean" | tr -s " " | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")

    if [ -z "$clean" ]; then
        clean="$(basename "$raw")"
        clean="${clean%.*}"
    fi
    echo "$clean"
}

# Fetch all registered user IDs from Jellyfin for multi-user playback aggregation
USER_IDS=$(curl -sf --max-time 10 \
    -H "Authorization: MediaBrowser Client=\"Jellyseerr\", Device=\"Jellyseerr\", DeviceId=\"b0319947-3158-42cf-b94f-db64076e9c84\", Version=\"1.0.0\", Token=\"$JELLYFIN_API_KEY\"" \
    "$JELLYFIN_URL/Users" 2>/dev/null | jq -r '.[].Id // empty' 2>/dev/null || true)

get_jellyfin_item_id() {
    local title="$1"
    local encoded
    encoded=$(jq -rn --arg x "$title" '$x|@uri' 2>/dev/null || echo "$title")

    local response
    response=$(curl -sf --max-time 15 \
        -H "Authorization: MediaBrowser Client=\"Jellyseerr\", Device=\"Jellyseerr\", DeviceId=\"b0319947-3158-42cf-b94f-db64076e9c84\", Version=\"1.0.0\", Token=\"$JELLYFIN_API_KEY\"" \
        "$JELLYFIN_URL/Items?searchTerm=${encoded}&Recursive=true&IncludeItemTypes=Movie,Episode,Audio&limit=1" \
        2>/dev/null || echo "{}")

    echo "$response" | jq -r '.Items[0].Id // empty' 2>/dev/null
}

get_play_count() {
    local item_id="$1"
    local clean_title="${2:-}"

    if [ -z "$item_id" ]; then
        echo 0
        return
    fi

    local total_plays=0
    if [ -n "$USER_IDS" ]; then
        local uid
        for uid in $USER_IDS; do
            local response
            response=$(curl -sf --max-time 10 \
                -H "Authorization: MediaBrowser Client=\"Jellyseerr\", Device=\"Jellyseerr\", DeviceId=\"b0319947-3158-42cf-b94f-db64076e9c84\", Version=\"1.0.0\", Token=\"$JELLYFIN_API_KEY\"" \
                "$JELLYFIN_URL/Users/$uid/Items/$item_id" \
                2>/dev/null || echo "{}")

            local plays
            plays=$(echo "$response" | jq '.UserData.PlayCount // 0' 2>/dev/null || echo 0)
            local played
            played=$(echo "$response" | jq '.UserData.Played // false' 2>/dev/null || echo "false")
            if [ "$played" = "true" ] && [ "$plays" -eq 0 ]; then
                plays=1
            fi
            total_plays=$(( total_plays + plays ))
        done
    else
        local encoded
        encoded=$(jq -rn --arg x "$clean_title" '$x|@uri' 2>/dev/null || echo "$clean_title")
        local response
        response=$(curl -sf --max-time 15 \
            -H "Authorization: MediaBrowser Client=\"Jellyseerr\", Device=\"Jellyseerr\", DeviceId=\"b0319947-3158-42cf-b94f-db64076e9c84\", Version=\"1.0.0\", Token=\"$JELLYFIN_API_KEY\"" \
            "$JELLYFIN_URL/Items?searchTerm=${encoded}&Recursive=true&IncludeItemTypes=Movie,Episode,Audio&fields=UserData&limit=1" \
            2>/dev/null || echo "{}")
        total_plays=$(echo "$response" | jq '.Items[0].UserData.PlayCount // 0' 2>/dev/null || echo 0)
    fi

    echo "$total_plays"
}

get_item_watched_by_any_user() {
    local item_id="$1"
    if [ -z "$item_id" ]; then
        return 1
    fi

    if [ -n "$USER_IDS" ]; then
        local uid
        for uid in $USER_IDS; do
            local response
            response=$(curl -sf --max-time 10 \
                -H "Authorization: MediaBrowser Client=\"Jellyseerr\", Device=\"Jellyseerr\", DeviceId=\"b0319947-3158-42cf-b94f-db64076e9c84\", Version=\"1.0.0\", Token=\"$JELLYFIN_API_KEY\"" \
                "$JELLYFIN_URL/Users/$uid/Items/$item_id" \
                2>/dev/null || echo "{}")

            local played
            played=$(echo "$response" | jq '.UserData.Played // false' 2>/dev/null || echo "false")
            local plays
            plays=$(echo "$response" | jq '.UserData.PlayCount // 0' 2>/dev/null || echo 0)
            if [ "$played" = "true" ] || [ "$plays" -gt 0 ]; then
                return 0
            fi
        done
    fi
    return 1
}

log "INFO" "Starting retention audit run. Watched max: ${WATCHED_MAX_AGE_DAYS}d | Unplayed max: ${UNWATCHED_MAX_AGE_DAYS}d"

PURGED=0
SURVIVED=0

# Use process substitution so variables PURGED and SURVIVED persist across iterations
while IFS= read -r media_file; do
    [ -z "$media_file" ] && continue
    [ ! -f "$media_file" ] && continue

    FILENAME=$(basename "$media_file")
    CLEAN_TITLE=$(extract_clean_title "$media_file")
    FILE_AGE_DAYS=$(( ( $(date +%s) - $(stat -c%Y "$media_file" 2>/dev/null || echo 0) ) / 86400 ))

    ITEM_ID=$(get_jellyfin_item_id "$CLEAN_TITLE")
    PLAY_COUNT=$(get_play_count "$ITEM_ID" "$CLEAN_TITLE")
    IS_WATCHED=false
    if [ "$PLAY_COUNT" -gt 0 ] || get_item_watched_by_any_user "$ITEM_ID"; then
        IS_WATCHED=true
    fi

    if [ "$IS_WATCHED" = true ] && [ "$FILE_AGE_DAYS" -ge "$WATCHED_MAX_AGE_DAYS" ]; then
        log "PURGE" "Removing watched item (title: '$CLEAN_TITLE', age: ${FILE_AGE_DAYS}d, plays: ${PLAY_COUNT}): $FILENAME"
        rm -f "$media_file"
        rm -f "${media_file%.*}."*.srt "${media_file%.*}.srt" 2>/dev/null || true
        PARENT_DIR="$(dirname "$media_file")"
        if [ "$PARENT_DIR" != "$COMPLETED_DIR" ] && [ "$PARENT_DIR" != "$COMPLETED_DIR/Movies" ] && [ "$PARENT_DIR" != "$COMPLETED_DIR/Series" ] && [ "$PARENT_DIR" != "$COMPLETED_DIR/Podcasts" ]; then
            rmdir "$PARENT_DIR" 2>/dev/null || true
        fi
        PURGED=$(( PURGED + 1 ))
    elif [ "$FILE_AGE_DAYS" -ge "$UNWATCHED_MAX_AGE_DAYS" ]; then
        log "PURGE" "Removing unplayed item (title: '$CLEAN_TITLE', age: ${FILE_AGE_DAYS}d, plays: 0): $FILENAME"
        rm -f "$media_file"
        rm -f "${media_file%.*}."*.srt "${media_file%.*}.srt" 2>/dev/null || true
        PARENT_DIR="$(dirname "$media_file")"
        if [ "$PARENT_DIR" != "$COMPLETED_DIR" ] && [ "$PARENT_DIR" != "$COMPLETED_DIR/Movies" ] && [ "$PARENT_DIR" != "$COMPLETED_DIR/Series" ] && [ "$PARENT_DIR" != "$COMPLETED_DIR/Podcasts" ]; then
            rmdir "$PARENT_DIR" 2>/dev/null || true
        fi
        PURGED=$(( PURGED + 1 ))
    else
        log "RETAIN" "Retaining media file (title: '$CLEAN_TITLE', age: ${FILE_AGE_DAYS}d, plays: ${PLAY_COUNT}, watched: ${IS_WATCHED}): $FILENAME"
        SURVIVED=$(( SURVIVED + 1 ))
    fi
done < <(find "$COMPLETED_DIR" -type f \( -name "*.mkv" -o -name "*.mp4" -o -name "*.avi" \
    -o -name "*.mov" -o -name "*.m4v" -o -name "*.mp3" -o -name "*.m4b" \
    -o -name "*.ogg" -o -name "*.opus" -o -name "*.flac" \) \
    -mtime "+${WATCHED_MAX_AGE_DAYS}" 2>/dev/null)

log "INFO" "Retention audit complete. Purged: $PURGED | Retained: $SURVIVED"
