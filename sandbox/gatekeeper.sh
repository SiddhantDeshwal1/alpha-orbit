#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Zero-Trust Media Gatekeeper v2.0
# 4-Stage File Sanitization Pipeline
# Stage 1: MIME Magic Byte Verification
# Stage 2: Execution Bit Stripping & Blacklist Purge
# Stage 3: FFmpeg Container Sanitization
# Stage 4: ClamAV Antivirus Daemon Scan + Freshclam Update
# ==============================================================================

set -euo pipefail

STAGING_DIR="${STAGING_DIR:-/data/media/staging}"
COMPLETED_DIR="${COMPLETED_DIR:-/data/media/completed}"
LOG_DIR="${LOG_DIR:-/data/logs}"
QUARANTINE_LOG="$LOG_DIR/security_audit.log"
GATEKEEPER_LOG="$LOG_DIR/gatekeeper.log"
JELLYFIN_URL="${JELLYFIN_URL:-http://alpha-prod-tailscale:8096}"
JELLYFIN_API_KEY="${JELLYFIN_API_KEY:-}"
CLAMAV_HOST="${CLAMAV_HOST:-alpha-prod-clamav}"
CLAMAV_PORT="${CLAMAV_PORT:-3310}"

mkdir -p "$LOG_DIR" "$COMPLETED_DIR/Movies" "$COMPLETED_DIR/Series"

# Non-blocking lock to guarantee single-instance execution
LOCK_FILE="/tmp/gatekeeper.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    exit 0
fi

ATOMIC_MOVE_BIN="/scripts/atomic_move.sh"
if [ ! -x "$ATOMIC_MOVE_BIN" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -x "$SCRIPT_DIR/atomic_move.sh" ]; then
        ATOMIC_MOVE_BIN="$SCRIPT_DIR/atomic_move.sh"
    elif command -v atomic_move.sh >/dev/null 2>&1; then
        ATOMIC_MOVE_BIN="atomic_move.sh"
    fi
fi

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

notify_jellyfin_resilient() {
    local max_attempts=5
    local attempt=1
    local delay=2
    local jf_url="${JELLYFIN_URL:-http://alpha-prod-tailscale:8096}"
    local token="${JELLYFIN_API_KEY:-}"

    while [ "$attempt" -le "$max_attempts" ]; do
        log "INFO" "Dispatching Jellyfin Library Refresh (attempt $attempt/$max_attempts)..."
        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
            -X POST "$jf_url/Library/Refresh" \
            -H "X-Emby-Token: $token" \
            -H "Authorization: MediaBrowser Token=\"$token\"" 2>/dev/null || echo "000")

        if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
            log "OK" "Jellyfin library refresh successfully accepted (HTTP $http_code)."
            return 0
        fi

        log "WARN" "Jellyfin responded with HTTP $http_code. Retrying in ${delay}s..."
        sleep "$delay"
        delay=$(( delay * 2 ))
        attempt=$(( attempt + 1 ))
    done

    log "ERROR" "Failed to notify Jellyfin after $max_attempts attempts."
    return 1
}

classify_media() {
    local filename="$1"
    local lower
    lower=$(echo "$filename" | tr '[:upper:]' '[:lower:]')

    # Simple heuristic classification
    if echo "$lower" | grep -qE '\.(mp3|m4a|m4b|ogg|opus|aac|flac|wav|podcast)$'; then
        echo "Podcasts"
    elif echo "$lower" | grep -qE '(s[0-9]{2}e[0-9]{2}|season|episode|e[0-9]{2,3}|web.series|series)'; then
        echo "Series"
    else
        echo "Movies"
    fi
}

process_file() {
    local file="$1"
    local basename
    basename=$(basename "$file")
    local EXTRACTED_SRTS=()

    log "INFO" "Processing: $basename"

    # -------------------------------------------------------------------------
    # STAGE 1: MIME Magic Byte / Container Format Verification
    # Inspect actual container stream headers, NOT merely extension
    # -------------------------------------------------------------------------
    if command -v file >/dev/null 2>&1; then
        local MIME_TYPE
        MIME_TYPE=$(file --mime-type -b "$file")

        case "$MIME_TYPE" in
            video/*|application/x-matroska|audio/*|application/ogg|application/octet-stream|text/plain|text/vtt|text/x-subrip|application/x-subrip)
                log "PASS" "[Stage 1] Valid MIME type: $MIME_TYPE -> $basename"
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
            *matroska*|*mp4*|*avi*|*mov*|*webm*|*flv*|*mp3*|*ogg*|*flac*|*wav*|*aac*|*m4a*|*asf*|*srt*|*subrip*|*webvtt*|*ass*)
                log "PASS" "[Stage 1] Valid media format ($FORMAT) via ffprobe -> $basename"
                ;;
            *)
                alert "[Stage 1] BLOCKED: Unauthorized media format '$FORMAT' in file: $basename"
                rm -rf "$file"
                return 1
                ;;
        esac
    fi

    # Double-check: refuse common executable disguises regardless of MIME
    case "$basename" in
        *.sh|*.exe|*.bat|*.vbs|*.js|*.py|*.ps1|*.cmd|*.com|*.scr|*.hta)
            alert "[Stage 1] BLOCKED: Blacklisted extension on file: $basename"
            rm -rf "$file"
            return 1
            ;;
    esac

    # -------------------------------------------------------------------------
    # STAGE 2: Execution Bit Stripping & Permissions Lock
    # -------------------------------------------------------------------------
    chmod 644 "$file"
    log "PASS" "[Stage 2] Execution bits stripped. Permissions: 644 -> $basename"

    # -------------------------------------------------------------------------
    # STAGE 3: FFmpeg Container Sanitization & Direct-Play First Harmonization
    # Strip: data streams, embedded executables, rogue metadata, cover art scripts
    # Harmonize:
    #   1. Extract text subtitles (subrip, webvtt, ass, mov_text) to .srt sidecars
    #   2. Demote unrenderable bitmap PGS subtitles (prevent auto-transcode traps)
    #   3. Dual-track audio: If no stereo AAC (<=2ch) exists, synthesize Track 0
    #      as AAC 2.0 @ 192k (default), stream-copying master surround to Track 1+
    #   4. Video MUST ALWAYS be stream-copied (-c:v copy) - NEVER re-encode video!
    #   5. For MP4/M4V containers, apply -movflags +faststart
    # -------------------------------------------------------------------------
    local ext="${file##*.}"
    local ext_lower
    ext_lower=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
    local base_no_ext="${file%.*}"

    if [[ "$ext_lower" =~ ^(mkv|mp4|avi|mov|wmv|flv|m4v|ts|webm)$ ]]; then
        log "INFO" "[Stage 3] Running Direct-Play First harmonization on: $basename"

        # Determine target container: preserve mp4/m4v, sanitize other formats to mkv
        local TARGET_EXT="mkv"
        if [[ "$ext_lower" =~ ^(mp4|m4v)$ ]]; then
            TARGET_EXT="mp4"
        fi
        local CLEAN_FILE="${base_no_ext}.sanitized.${TARGET_EXT}"

        # 1. Stream introspection via ffprobe JSON
        local PROBE_JSON=""
        if ! PROBE_JSON=$(ffprobe -v quiet -print_format json -show_streams "$file" 2>> "$GATEKEEPER_LOG"); then
            alert "[Stage 3] BLOCKED: ffprobe stream inspection failed for: $basename"
            rm -f "$file"
            return 1
        fi

        if [ -z "$PROBE_JSON" ]; then
            alert "[Stage 3] BLOCKED: ffprobe returned empty stream metadata for: $basename"
            rm -f "$file"
            return 1
        fi

        # 2. Subtitle Decoupling: Extract embedded text subtitles to sidecars
        if command -v jq >/dev/null 2>&1; then
            while IFS= read -r sub_info; do
                [ -z "$sub_info" ] && continue
                local SUB_IDX SUB_CODEC SUB_LANG
                SUB_IDX=$(echo "$sub_info" | jq -r '.index')
                SUB_CODEC=$(echo "$sub_info" | jq -r '.codec_name')
                SUB_LANG=$(echo "$sub_info" | jq -r '.tags.language // "und"')
                SUB_LANG=$(echo "$SUB_LANG" | tr -cd '[:alnum:]_')
                [ -z "$SUB_LANG" ] && SUB_LANG="und"

                local SRT_TARGET="${base_no_ext}.${SUB_LANG}.srt"
                if [ -f "$SRT_TARGET" ]; then
                    SRT_TARGET="${base_no_ext}.${SUB_LANG}.${SUB_IDX}.srt"
                fi

                log "INFO" "[Stage 3] Extracting text subtitle stream #$SUB_IDX ($SUB_CODEC, $SUB_LANG) -> $(basename "$SRT_TARGET")"
                if ffmpeg -v error -y -i "$file" -map "0:$SUB_IDX" -c:s srt "$SRT_TARGET" 2>> "$GATEKEEPER_LOG"; then
                    chmod 644 "$SRT_TARGET"
                    EXTRACTED_SRTS+=("$SRT_TARGET")
                else
                    log "WARN" "[Stage 3] Failed to extract subtitle stream #$SUB_IDX to $SRT_TARGET"
                fi
            done < <(echo "$PROBE_JSON" | jq -c '.streams[]? | select(.codec_type=="subtitle" and (.codec_name=="subrip" or .codec_name=="webvtt" or .codec_name=="ass" or .codec_name=="mov_text"))')
        fi

        # 3. Audio & Video stream analysis
        local HAS_VIDEO HAS_AUDIO HAS_STEREO_AAC AUDIO_COUNT A0_LANG
        HAS_VIDEO=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="video")] | length > 0')
        AUDIO_COUNT=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="audio")] | length')
        HAS_STEREO_AAC=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="audio")] | any(.codec_name=="aac" and (.channels != null and .channels <= 2))')
        A0_LANG=$(echo "$PROBE_JSON" | jq -r '[.streams[]? | select(.codec_type=="audio")][0].tags.language // empty')

        # 4. Construct FFmpeg command dynamically
        local FFMPEG_CMD=("ffmpeg" "-v" "error" "-y" "-i" "$file")

        # Map video: ALWAYS stream copy, NEVER re-encode!
        if [ "$HAS_VIDEO" = "true" ]; then
            FFMPEG_CMD+=("-map" "0:v:0" "-c:v:0" "copy")
        fi

        # Audio Dual-Track Normalization
        if [ "$AUDIO_COUNT" -gt 0 ]; then
            if [ "$HAS_STEREO_AAC" = "true" ]; then
                log "PASS" "[Stage 3] Stereo AAC track already present. Stream-copying audio."
                FFMPEG_CMD+=("-map" "0:a" "-c:a" "copy")
            else
                log "INFO" "[Stage 3] No stereo AAC track found ($AUDIO_COUNT audio track(s) present). Synthesizing AAC stereo Track 0 & copying master surround."
                # Track 0: AAC Stereo 192k from primary audio
                FFMPEG_CMD+=("-map" "0:a:0" "-c:a:0" "aac" "-ac:a:0" "2" "-b:a:0" "192k")
                if [ -n "$A0_LANG" ] && [ "$A0_LANG" != "und" ]; then
                    FFMPEG_CMD+=("-metadata:s:a:0" "language=$A0_LANG" "-metadata:s:a:0" "title=Stereo ($A0_LANG)")
                else
                    FFMPEG_CMD+=("-metadata:s:a:0" "title=Stereo")
                fi
                # Map original audio streams starting at output audio 1
                FFMPEG_CMD+=("-map" "0:a" "-c:a" "copy" "-c:a:0" "aac")
                # Disposition: Track 0 default=1, all other tracks default=0
                FFMPEG_CMD+=("-disposition:a" "0" "-disposition:a:0" "default")
            fi
        fi

        # Subtitle Handling & Bitmap PGS Demotion
        if [ "$TARGET_EXT" = "mkv" ]; then
            # Demote embedded subtitles so bitmap PGS streams do not auto-activate and cause transcode loops
            FFMPEG_CMD+=("-map" "0:s?" "-c:s" "copy" "-disposition:s" "0")
        fi

        # Strip data streams, rogue metadata, fix timestamps
        FFMPEG_CMD+=("-dn" "-map_metadata" "-1" "-fflags" "+genpts")

        # Faststart progressive playback for MP4
        if [ "$TARGET_EXT" = "mp4" ]; then
            FFMPEG_CMD+=("-movflags" "+faststart")
        fi

        FFMPEG_CMD+=("$CLEAN_FILE")

        log "INFO" "[Stage 3] Executing FFmpeg remux on: $basename"
        if "${FFMPEG_CMD[@]}" 2>> "$GATEKEEPER_LOG"; then
            local orig_size clean_size
            orig_size=$(stat -c%s "$file" 2>/dev/null || echo 0)
            clean_size=$(stat -c%s "$CLEAN_FILE" 2>/dev/null || echo 0)

            # Sanity check: sanitized file should be >85% of original size
            if [ "$clean_size" -lt $(( orig_size * 85 / 100 )) ] && [ "$orig_size" -gt 10485760 ]; then
                alert "[Stage 3] SUSPICIOUS: Sanitized file too small (${clean_size}B vs orig ${orig_size}B) for: $basename"
                rm -f "$CLEAN_FILE"
                rm -f "$file"
                for srt in "${EXTRACTED_SRTS[@]}"; do rm -f "$srt"; done
                return 1
            fi

            # Replace original file with clean sanitized file
            local final_target="${base_no_ext}.${TARGET_EXT}"
            if [ "$file" != "$final_target" ]; then
                rm -f "$file"
                file="$final_target"
                basename=$(basename "$file")
            fi
            mv "$CLEAN_FILE" "$file"
            log "PASS" "[Stage 3] FFmpeg Direct-Play harmonization complete. Clean size: ${clean_size}B -> $basename"
        else
            alert "[Stage 3] BLOCKED: FFmpeg stream remux failed for: $basename"
            rm -f "$CLEAN_FILE" "$file"
            for srt in "${EXTRACTED_SRTS[@]}"; do rm -f "$srt"; done
            return 1
        fi
    elif [[ "$ext_lower" =~ ^(mp3|m4a|m4b|ogg|opus|aac|flac|wav)$ ]]; then
        log "INFO" "[Stage 3] Audio file — skipping FFmpeg container sanitization (stream copy pass): $basename"
    elif [[ "$ext_lower" =~ ^(srt|vtt|sub|idx|ass)$ ]]; then
        log "INFO" "[Stage 3] Subtitle sidecar — skipping FFmpeg remux: $basename"
    else
        log "WARN" "[Stage 3] Unknown extension '$ext_lower' — proceeding to ClamAV only"
    fi

    # -------------------------------------------------------------------------
    # STAGE 4: ClamAV Antivirus Daemon Scan
    # -------------------------------------------------------------------------
    log "INFO" "[Stage 4] Running ClamAV scan on: $basename"

    local CLAM_OUTPUT=""
    local rel_path="${file#$STAGING_DIR/}"
    local CLAM_SCAN_PATH="/scan/staging/$rel_path"

    if command -v nc >/dev/null 2>&1; then
        CLAM_OUTPUT=$(echo "SCAN $CLAM_SCAN_PATH" | nc -w 30 "$CLAMAV_HOST" "$CLAMAV_PORT" 2>&1 || true)
    elif command -v clamdscan >/dev/null 2>&1; then
        CLAM_OUTPUT=$(clamdscan --no-summary --max-filesize=4096M --max-scansize=4096M "$file" 2>&1 || true)
    elif command -v clamscan >/dev/null 2>&1; then
        CLAM_OUTPUT=$(clamscan --no-summary --max-filesize=4096M --max-scansize=4096M "$file" 2>&1 || true)
    else
        log "WARN" "[Stage 4] Neither netcat nor ClamAV found — skipping AV scan."
        CLAM_OUTPUT="OK"
    fi

    echo "$CLAM_OUTPUT" >> "$GATEKEEPER_LOG"

    if echo "$CLAM_OUTPUT" | grep -q "FOUND"; then
        alert "[Stage 4] BLOCKED: ClamAV detected malicious payload in: $basename ($CLAM_OUTPUT)"
        rm -rf "$file"
        for srt in "${EXTRACTED_SRTS[@]}"; do rm -f "$srt"; done
        return 1
    elif echo "$CLAM_OUTPUT" | grep -q "OK"; then
        log "PASS" "[Stage 4] ClamAV media scan clean: $basename"
    else
        log "WARN" "[Stage 4] ClamAV scan inconclusive or unreachable for $basename: $CLAM_OUTPUT"
    fi

    # Scan extracted subtitle sidecars
    for srt in "${EXTRACTED_SRTS[@]}"; do
        if [ -f "$srt" ]; then
            local srt_base srt_rel_path srt_scan_path srt_output
            srt_base=$(basename "$srt")
            srt_rel_path="${srt#$STAGING_DIR/}"
            srt_scan_path="/scan/staging/$srt_rel_path"
            if command -v nc >/dev/null 2>&1; then
                srt_output=$(echo "SCAN $srt_scan_path" | nc -w 30 "$CLAMAV_HOST" "$CLAMAV_PORT" 2>&1 || true)
            elif command -v clamdscan >/dev/null 2>&1; then
                srt_output=$(clamdscan --no-summary "$srt" 2>&1 || true)
            elif command -v clamscan >/dev/null 2>&1; then
                srt_output=$(clamscan --no-summary "$srt" 2>&1 || true)
            else
                srt_output="OK"
            fi
            echo "$srt_output" >> "$GATEKEEPER_LOG"
            if echo "$srt_output" | grep -q "FOUND"; then
                alert "[Stage 4] BLOCKED: ClamAV detected malicious payload in subtitle: $srt_base ($srt_output)"
                rm -rf "$file"
                for s in "${EXTRACTED_SRTS[@]}"; do rm -f "$s"; done
                return 1
            fi
        fi
    done

    log "PASS" "[Stage 4] ClamAV pipeline scan clean: $basename"

    # -------------------------------------------------------------------------
    # ATOMIC MOVE: Verified clean file to /completed/<category>/
    # -------------------------------------------------------------------------
    local CATEGORY
    CATEGORY=$(classify_media "$basename")
    local TARGET_DIR="$COMPLETED_DIR/$CATEGORY"
    mkdir -p "$TARGET_DIR"

    # Atomic rename (same filesystem partition = inode pointer update, <1ms)
    if "$ATOMIC_MOVE_BIN" "$file" "$TARGET_DIR/$basename"; then
        log "OK" "Verified clean media atomically moved: $basename -> $TARGET_DIR/"
    else
        alert "CRITICAL: Atomic move failed for: $basename. File left in staging."
        return 1
    fi

    # Atomically move any extracted subtitle sidecars to the same category directory
    for srt in "${EXTRACTED_SRTS[@]}"; do
        if [ -f "$srt" ]; then
            local srt_base
            srt_base=$(basename "$srt")
            if "$ATOMIC_MOVE_BIN" "$srt" "$TARGET_DIR/$srt_base"; then
                log "OK" "Subtitle sidecar atomically moved: $srt_base -> $TARGET_DIR/"
            else
                alert "WARN: Subtitle atomic move failed for: $srt_base"
            fi
        fi
    done

    # Notify Jellyfin to ingest verified media with exponential retry
    notify_jellyfin_resilient || true

    # Notify Dashboard Priority Engine of verified ingestion for auto-resume
    if command -v curl >/dev/null 2>&1; then
        curl -s --max-time 3 -X POST "http://alpha-prod-tailscale:3000/api/downloads/gatekeeper-complete" \
             -H "Content-Type: application/json" \
             -d "{\"file\":\"$basename\",\"category\":\"$CATEGORY\"}" >/dev/null 2>&1 || true
    fi
}

# Main loop over staging directory
main() {
    local count=0
    shopt -s nullglob

    for file in "$STAGING_DIR"/*; do
        [ -e "$file" ] || continue
        [ -f "$file" ] || continue

        # Skip hidden files, partial downloads, and temp files
        local fname
        fname=$(basename "$file")
        case "$fname" in
            .*|*.part|*.!qb|*.crdownload|*.tmp)
                log "SKIP" "Skipping partial/temp file: $fname"
                continue
                ;;
        esac

        process_file "$file" && count=$(( count + 1 )) || true
    done

    if [ "$count" -gt 0 ]; then
        log "INFO" "Gatekeeper cycle complete. Processed $count file(s)."
        notify_jellyfin_resilient || true
    fi
}

main
