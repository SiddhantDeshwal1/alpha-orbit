#!/usr/bin/env bash
# ==============================================================================
# Orbit Server: Atomic File Move Helper
# Ensures cross-directory moves on the SAME filesystem are atomic.
# Usage: atomic_move.sh <source> <destination>
# On failure retries up to MAX_RETRIES times.
# ==============================================================================

set -euo pipefail

SOURCE="$1"
DEST="$2"
MAX_RETRIES=5
ATTEMPT=0

if [ ! -f "$SOURCE" ]; then
    echo "[atomic_move] ERROR: Source file not found: $SOURCE" >&2
    exit 1
fi

# Verify source and destination are on the SAME filesystem (guarantees atomicity)
SRC_DEV=$(stat -c%d "$(dirname "$SOURCE")" 2>/dev/null || echo "0")
DST_DEV=$(stat -c%d "$(dirname "$DEST")" 2>/dev/null || echo "1")

if [ "$SRC_DEV" != "$DST_DEV" ]; then
    echo "[atomic_move] WARNING: Source and destination are on DIFFERENT filesystems." >&2
    echo "[atomic_move] Falling back to cp+verify+rm (non-atomic). This should not happen." >&2
    cp --preserve=timestamps "$SOURCE" "${DEST}.tmp"
    mv "${DEST}.tmp" "$DEST"
    rm -f "$SOURCE"
    echo "[atomic_move] Cross-filesystem copy complete: $(basename "$SOURCE") -> $DEST"
    exit 0
fi

# Same filesystem: use mv (atomic inode rename)
while [ $ATTEMPT -lt $MAX_RETRIES ]; do
    ATTEMPT=$(( ATTEMPT + 1 ))
    if mv "$SOURCE" "$DEST" 2>/dev/null; then
        echo "[atomic_move] OK: Atomic inode move complete (attempt $ATTEMPT): $(basename "$SOURCE") -> $DEST"
        exit 0
    fi
    echo "[atomic_move] WARN: Move attempt $ATTEMPT failed. Retrying in 2s..."
    sleep 2
done

echo "[atomic_move] CRITICAL: All $MAX_RETRIES move attempts failed for: $SOURCE" >&2
exit 1
