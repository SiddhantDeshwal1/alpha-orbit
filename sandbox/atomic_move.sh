#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Atomic File Move Helper
# Ensures cross-directory moves are atomic on same-mount renames and safe via
# hidden .tmp staging + atomic rename when spanning different mounts/filesystems.
#
# Usage:
#   atomic_move.sh <source> <destination_path>
#   atomic_move.sh <source> <category> [relative_subdir]
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "[atomic_move] ERROR: Usage: atomic_move.sh <source> <destination|category> [relative_subdir]" >&2
    exit 1
fi

SOURCE="$1"
TARGET_ARG="$2"
REL_SUBDIR="${3:-}"
COMPLETED_DIR="${COMPLETED_DIR:-/data/media/completed}"
MAX_RETRIES=5

if [ ! -f "$SOURCE" ]; then
    echo "[atomic_move] ERROR: Source file not found: $SOURCE" >&2
    exit 1
fi

sanitize_rel_subdir() {
    local raw="$1"
    local cleaned=""
    local -a parts=()
    local part
    IFS='/' read -r -a parts <<< "$raw"
    for part in "${parts[@]}"; do
        [ -z "$part" ] && continue
        [ "$part" = "." ] && continue
        if [ "$part" = ".." ]; then
            continue
        fi
        if [ -z "$cleaned" ]; then
            cleaned="$part"
        else
            cleaned="$cleaned/$part"
        fi
    done
    printf '%s' "$cleaned"
}

resolve_dest_path() {
    local src="$1"
    local target="$2"
    local subdir="$3"
    local src_base
    src_base=$(basename "$src")

    subdir=$(sanitize_rel_subdir "$subdir")

    if [ -n "$subdir" ]; then
        if [[ "$target" == /* ]]; then
            printf '%s/%s/%s' "${target%/}" "$subdir" "$src_base"
        else
            printf '%s/%s/%s/%s' "${COMPLETED_DIR%/}" "${target%/}" "$subdir" "$src_base"
        fi
        return 0
    fi

    if [[ "$target" == /* ]]; then
        if [ -d "$target" ] || [[ "$target" == */ ]]; then
            printf '%s/%s' "${target%/}" "$src_base"
        else
            printf '%s' "$target"
        fi
        return 0
    fi

    # 2-arg <src> <category> call (e.g., Movies, Series, Podcasts)
    if [[ "$target" != */* ]]; then
        printf '%s/%s/%s' "${COMPLETED_DIR%/}" "$target" "$src_base"
    else
        printf '%s/%s' "${COMPLETED_DIR%/}" "${target#/}"
    fi
}

get_mountpoint() {
    local dir="$1"
    local mnt
    mnt=$(stat -c%m "$dir" 2>/dev/null || true)
    if [ -z "$mnt" ]; then
        mnt=$(df -P "$dir" 2>/dev/null | awk 'NR==2 {print $NF}' || true)
    fi
    printf '%s' "$mnt"
}

atomic_transfer_one() {
    local src="$1"
    local dst="$2"
    local src_dir dst_dir dst_base tmp_dst
    src_dir=$(dirname "$src")
    dst_dir=$(dirname "$dst")
    dst_base=$(basename "$dst")
    tmp_dst="${dst_dir}/.${dst_base}.tmp.$$"

    mkdir -p "$dst_dir"

    local src_dev dst_dev src_mnt dst_mnt attempt=0
    src_dev=$(stat -c%d "$src_dir" 2>/dev/null || echo "0")
    dst_dev=$(stat -c%d "$dst_dir" 2>/dev/null || echo "1")
    src_mnt=$(get_mountpoint "$src_dir")
    dst_mnt=$(get_mountpoint "$dst_dir")

    # True atomic kernel rename(2) is only possible when device AND mountpoint match
    if [ "$src_dev" = "$dst_dev" ] && [ -n "$src_mnt" ] && [ "$src_mnt" = "$dst_mnt" ]; then
        while [ "$attempt" -lt "$MAX_RETRIES" ]; do
            attempt=$(( attempt + 1 ))
            if mv -f "$src" "$dst" 2>/dev/null; then
                echo "[atomic_move] OK: Atomic inode move complete (attempt $attempt): $(basename "$src") -> $dst"
                return 0
            fi
            echo "[atomic_move] WARN: Move attempt $attempt failed for $(basename "$src"). Retrying in 2s..."
            sleep 2
        done
        echo "[atomic_move] CRITICAL: All $MAX_RETRIES move attempts failed for: $src" >&2
        return 1
    fi

    # Cross-filesystem or separate bind-mount fallback: stage to hidden .tmp, verify size, then atomic mv
    echo "[atomic_move] INFO: Cross-mount move detected (${src_mnt:-dev:$src_dev} -> ${dst_mnt:-dev:$dst_dev}); staging via .tmp + mv." >&2
    local src_size dst_size
    src_size=$(stat -c%s "$src" 2>/dev/null || echo "-1")

    while [ "$attempt" -lt "$MAX_RETRIES" ]; do
        attempt=$(( attempt + 1 ))
        rm -f "$tmp_dst"
        if cp --preserve=timestamps "$src" "$tmp_dst" 2>/dev/null; then
            dst_size=$(stat -c%s "$tmp_dst" 2>/dev/null || echo "-2")
            if [ "$src_size" = "$dst_size" ] && mv -f "$tmp_dst" "$dst" 2>/dev/null; then
                rm -f "$src"
                echo "[atomic_move] OK: Staged atomic move complete (attempt $attempt): $(basename "$src") -> $dst"
                return 0
            fi
        fi
        rm -f "$tmp_dst"
        echo "[atomic_move] WARN: Staged move attempt $attempt failed for $(basename "$src"). Retrying in 2s..."
        sleep 2
    done

    echo "[atomic_move] CRITICAL: All $MAX_RETRIES staged move attempts failed for: $src" >&2
    return 1
}

DEST=$(resolve_dest_path "$SOURCE" "$TARGET_ARG" "$REL_SUBDIR")
DEST_DIR=$(dirname "$DEST")

atomic_transfer_one "$SOURCE" "$DEST"

# Sidecar .srt handling when moving a non-subtitle primary media file
src_ext_lower=$(echo "${SOURCE##*.}" | tr '[:upper:]' '[:lower:]')
if [[ ! "$src_ext_lower" =~ ^(srt|vtt|ass|sub|idx)$ ]]; then
    src_no_ext="${SOURCE%.*}"
    shopt -s nullglob
    for sidecar in "${src_no_ext}.srt" "${src_no_ext}".*.srt; do
        [ -f "$sidecar" ] || continue
        sidecar_dest="${DEST_DIR}/$(basename "$sidecar")"
        if ! atomic_transfer_one "$sidecar" "$sidecar_dest"; then
            echo "[atomic_move] WARN: Failed to move subtitle sidecar: $sidecar" >&2
        fi
    done
    shopt -u nullglob
fi
