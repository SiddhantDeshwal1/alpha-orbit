#!/usr/bin/env python3
"""
Orbit Server: Stall Detector & Auto-Requeue v2.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Autonomous dead-swarm detection and automated requeue pipeline for both
Radarr (movies) and Sonarr (series/episodes).

Monitors qBittorrent for torrents stuck in:
  · `stalledDL`    - 0 seeders, 0 B/s, availability <= progress for >= STALL_SECS
  · `metaDL`       - 0 seeders, 0 B/s, stuck fetching metadata for >= STALL_SECS
  · `queuedDL`     - 0 seeders, 0 B/s, held in queue with dead swarm for >= STALL_SECS
  · `forcedDL`     - 0 seeders, 0 B/s, forced download with dead swarm for >= STALL_SECS
  · `forcedMetaDL` - 0 seeders, 0 B/s, forced metadata fetch with 0 seeds for >= STALL_SECS

When a dead-swarm torrent is detected:
  1. Identifies parent download in Radarr or Sonarr active queues.
  2. Permanently removes it from queue WITH blocklist=true (never grabbed again).
  3. Ensures qBittorrent purges any partial downloaded payload/files.
  4. Dispatches an automated re-search:
     - Radarr: MoviesSearch command for the target movie ID.
     - Sonarr: EpisodeSearch (or SeriesSearch) command for target episode/series.
  5. Tracks and purges orphan dead torrents absent from Radarr/Sonarr after
     STALL_ORPHAN_THRESHOLD_SECS (default max(STALL_SECS * 4, 3600)).
  6. Sends desktop notifications via notify-send and push alerts via ntfy.
  7. Emits structured telemetry to serverData/sandbox/logs/stall_detector.log.

Invoked periodically by sandbox_supervisor.sh while STATE=ACTIVE.
Can also be run manually: python3 -u stall_detector.py [--dry-run]
"""

import argparse
import http.cookiejar
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

# ── Paths & Environment ───────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CONFIG_DIR = os.path.dirname(SCRIPT_DIR)
SERVER_DIR = os.path.dirname(CONFIG_DIR)
ENV_FILE   = os.path.join(CONFIG_DIR, ".env")


def _load_env():
    """Load configuration variables from serverConfig/.env if present."""
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())


_load_env()

# Data & Log directories
raw_data_dir = os.environ.get("SERVER_DATA_DIR", "../serverData")
if os.path.isabs(raw_data_dir):
    DATA_DIR = raw_data_dir
else:
    DATA_DIR = os.path.abspath(os.path.join(CONFIG_DIR, raw_data_dir))

LOG_DIR  = os.path.join(DATA_DIR, "sandbox", "logs")
LOG_FILE = os.path.join(LOG_DIR, "stall_detector.log")
os.makedirs(LOG_DIR, exist_ok=True)

# ── Logging Setup ─────────────────────────────────────────────────────────────
logger = logging.getLogger("stall_detector")
logger.setLevel(logging.INFO)
logger.propagate = False
logger.handlers.clear()

formatter = logging.Formatter("%(asctime)s [%(levelname)s] [STALL-DETECTOR] %(message)s")

# Console handler
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)

# File handler (only if stdout is not already redirected to LOG_FILE)
should_add_file_handler = True
try:
    stdout_stat = os.fstat(sys.stdout.fileno())
    if os.path.exists(LOG_FILE):
        file_stat = os.stat(LOG_FILE)
        if stdout_stat.st_ino == file_stat.st_ino and stdout_stat.st_dev == file_stat.st_dev:
            should_add_file_handler = False
except Exception:
    pass

if should_add_file_handler:
    file_handler = logging.FileHandler(LOG_FILE, mode="a", encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

log = logger

# ── Credentials & Threshold Configuration ─────────────────────────────────────
QBIT_URL  = os.environ.get("QBIT_URL",  "http://127.0.0.1:8081")
QBIT_USER = os.environ.get("QBIT_USER", "admin")
QBIT_PASS = os.environ.get("QBIT_PASS", "")

RADARR_URL = os.environ.get("RADARR_URL", "http://127.0.0.1:7878")
RADARR_KEY = os.environ.get("RADARR_API_KEY", "")

SONARR_URL = os.environ.get("SONARR_URL", "http://127.0.0.1:8989")
SONARR_KEY = os.environ.get("SONARR_API_KEY", "")

# Fallback: parse API keys from Servarr config.xml files if missing from .env
if not RADARR_KEY:
    radarr_xml = os.path.join(CONFIG_DIR, "sandbox", "radarr", "config.xml")
    if os.path.exists(radarr_xml):
        try:
            tree = ET.parse(radarr_xml)
            key_el = tree.find("ApiKey")
            if key_el is not None and key_el.text:
                RADARR_KEY = key_el.text.strip()
        except Exception as e:
            log.debug(f"Could not read Radarr config.xml: {e}")

if not SONARR_KEY:
    sonarr_xml = os.path.join(CONFIG_DIR, "sandbox", "sonarr", "config.xml")
    if os.path.exists(sonarr_xml):
        try:
            tree = ET.parse(sonarr_xml)
            key_el = tree.find("ApiKey")
            if key_el is not None and key_el.text:
                SONARR_KEY = key_el.text.strip()
        except Exception as e:
            log.debug(f"Could not read Sonarr config.xml: {e}")

# Dead-swarm stall threshold: defaults to 900 seconds (15 minutes)
if "STALL_THRESHOLD_SECONDS" in os.environ:
    STALL_SECS = int(os.environ["STALL_THRESHOLD_SECONDS"])
elif "STALL_THRESHOLD_SECS" in os.environ:
    STALL_SECS = int(os.environ["STALL_THRESHOLD_SECS"])
elif "STALL_THRESHOLD_MINUTES" in os.environ:
    STALL_SECS = int(os.environ["STALL_THRESHOLD_MINUTES"]) * 60
elif "STALL_THRESHOLD_HOURS" in os.environ:
    val = float(os.environ["STALL_THRESHOLD_HOURS"])
    if val == 48:
        # Legacy default from older .env — upgrade to 15m (900s)
        STALL_SECS = 900
    else:
        STALL_SECS = int(val * 3600)
else:
    STALL_SECS = 900

STALL_MINUTES = round(STALL_SECS / 60, 1)
STALL_ORPHAN_THRESHOLD_SECS = int(
    os.environ.get("STALL_ORPHAN_THRESHOLD_SECS", max(STALL_SECS * 4, 3600))
)
ORPHAN_STATE_FILE = os.path.join(LOG_DIR, "stall_orphans.json")

# Push notification setup
NTFY_URL   = os.environ.get("NTFY_URL",   "https://ntfy.sh")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")


# ── qBittorrent Helpers ───────────────────────────────────────────────────────
def _log_qbit_403_diagnostic(context: str):
    """Emit actionable diagnostics when qBittorrent rejects API auth/requests."""
    log.error(
        f"qBittorrent {context} rejected (HTTP 403 / auth failure). "
        "Verify WebUI\\AuthSubnetWhitelist includes client subnet (e.g. 172.31.0.0/24, 127.0.0.1/32), "
        "check whether the IP is in WebUI\\BanDuration IP ban cooldown, or fix .env QBIT_PASS mismatch."
    )


def _qbit_opener() -> urllib.request.OpenerDirector:
    """Connect to qBittorrent, honoring AuthSubnetWhitelist bypass or cookie auth."""
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener._qbit_auth_ok = False
    opener._prefetched_torrents = None

    # Probe torrents/info first so AuthSubnetWhitelist bypass works without risking a login ban
    try:
        with opener.open(f"{QBIT_URL}/api/v2/torrents/info", timeout=10) as resp:
            opener._prefetched_torrents = json.loads(resp.read().decode("utf-8"))
            opener._qbit_auth_ok = True
            log.debug("qBittorrent accessible without cookie (AuthSubnetWhitelist / LocalHostAuth bypass).")
            return opener
    except urllib.error.HTTPError as e:
        if e.code != 403:
            log.warning(f"qBittorrent probe returned HTTP {e.code}: {e}")
            return opener
    except Exception as e:
        log.warning(f"qBittorrent connection failed at {QBIT_URL}: {e}")
        return opener

    if not QBIT_PASS:
        _log_qbit_403_diagnostic("unauthenticated probe (QBIT_PASS is empty)")
        return opener

    data = urllib.parse.urlencode({"username": QBIT_USER, "password": QBIT_PASS}).encode("utf-8")
    try:
        with opener.open(f"{QBIT_URL}/api/v2/auth/login", data=data, timeout=5) as resp:
            body = resp.read().decode("utf-8", errors="replace").strip()
            if "Fails." in body:
                _log_qbit_403_diagnostic("/api/v2/auth/login returned 'Fails.'")
                return opener
            opener._qbit_auth_ok = True
    except urllib.error.HTTPError as e:
        if e.code == 403:
            _log_qbit_403_diagnostic("/api/v2/auth/login HTTP 403")
        else:
            log.warning(f"qBittorrent login returned HTTP {e.code}: {e}")
    except Exception as e:
        log.warning(f"qBittorrent login failed: {e}")

    return opener


def get_stalled_torrents(opener) -> list:
    """
    Return all torrents meeting dead-swarm criteria:
      1. stalledDL:    0 seeds, 0 B/s, idle >= STALL_SECS, availability <= progress + 0.01
      2. metaDL:       0 seeds, 0 B/s, stuck fetching metadata for >= STALL_SECS
      3. queuedDL:     0 seeds, 0 B/s, held in queue with dead swarm for >= STALL_SECS
      4. forcedDL:     0 seeds, 0 B/s, forced download with dead swarm for >= STALL_SECS
      5. forcedMetaDL: 0 seeds, 0 B/s, forced metadata retrieval with 0 seeds for >= STALL_SECS
    """
    torrents = getattr(opener, "_prefetched_torrents", None)
    if torrents is not None:
        opener._prefetched_torrents = None
    else:
        try:
            with opener.open(f"{QBIT_URL}/api/v2/torrents/info", timeout=10) as resp:
                torrents = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 403:
                _log_qbit_403_diagnostic("/api/v2/torrents/info")
            else:
                log.warning(f"Failed to fetch torrent list from qBittorrent (HTTP {e.code}): {e}")
            return []
        except Exception as e:
            log.warning(f"Failed to fetch torrent list from qBittorrent: {e}")
            return []

    now = int(time.time())
    results = []
    for t in torrents:
        state    = t.get("state", "")
        seeds    = int(t.get("num_seeds", 0) or 0)
        dlspeed  = int(t.get("dlspeed", 0) or 0)
        last_act = t.get("last_activity", 0)
        added_on = t.get("added_on", 0)
        avail    = float(t.get("availability", 0.0) or 0.0)
        progress = float(t.get("progress", 0.0) or 0.0)

        # Calculate effective idle time
        effective_act = last_act if (last_act and last_act > 0) else added_on
        idle = max(0, now - effective_act) if effective_act else 0

        is_stalled = False
        stall_reason = ""

        if state in ("stalledDL", "queuedDL", "forcedDL"):
            # Swarm has 0 seeds, 0 active transfer, and no missing pieces available
            if dlspeed == 0 and seeds == 0 and idle >= STALL_SECS and avail <= (progress + 0.01):
                is_stalled = True
                stall_reason = f"{state} (0 B/s, 0 seeds, avail={avail:.3f} <= prog={progress:.3f})"

        elif state in ("metaDL", "forcedMetaDL"):
            # Magnet unable to retrieve metadata due to 0 seeds & 0 transfer for >= STALL_SECS
            if dlspeed == 0 and seeds == 0 and idle >= STALL_SECS:
                is_stalled = True
                stall_reason = f"{state} (0 B/s, stuck retrieving metadata, 0 seeds)"

        if is_stalled:
            t["_idle_secs"] = idle
            t["_idle_desc"] = f"{round(idle / 60, 1)}m" if idle < 7200 else f"{round(idle / 3600, 1)}h"
            t["_stall_reason"] = stall_reason
            results.append(t)

    return results


def purge_qbit_torrent(opener, torrent_hash: str) -> bool:
    """Fallback cleanup: ensure torrent and partial files are removed from qBittorrent."""
    try:
        del_data = urllib.parse.urlencode({"hashes": torrent_hash, "deleteFiles": "true"}).encode("utf-8")
        opener.open(f"{QBIT_URL}/api/v2/torrents/delete", data=del_data, timeout=5)
        return True
    except Exception as e:
        log.debug(f"Direct qBittorrent delete returned: {e}")
        return False


# ── Generic Servarr Helpers ───────────────────────────────────────────────────
def _servarr(base_url: str, api_key: str, app_name: str, method: str, path: str, body: dict = None):
    if not api_key:
        log.warning(f"{app_name} API key not configured, skipping request to {path}.")
        return None
    url = f"{base_url}{path}"
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=payload, method=method,
        headers={"X-Api-Key": api_key, "Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as e:
        log.warning(f"{app_name} HTTP {e.code} on {method} {path}: {e.read()[:200]}")
        return None
    except Exception as e:
        log.warning(f"{app_name} request failed ({method} {path}): {e}")
        return None


def _radarr(method: str, path: str, body: dict = None):
    return _servarr(RADARR_URL, RADARR_KEY, "Radarr", method, path, body)


def _sonarr(method: str, path: str, body: dict = None):
    return _servarr(SONARR_URL, SONARR_KEY, "Sonarr", method, path, body)


def refresh_servarr_queues():
    """Trigger background sync between download client and Servarr queues."""
    try:
        _radarr("POST", "/api/v3/command", {"name": "RefreshMonitoredDownloads"})
    except Exception:
        pass
    try:
        _sonarr("POST", "/api/v3/command", {"name": "RefreshMonitoredDownloads"})
    except Exception:
        pass


def _fetch_servarr_queue(caller, path: str) -> tuple:
    """Fetch Servarr queue and return ({hash_upper: record}, api_ok)."""
    data = caller("GET", path)
    if data is None:
        return {}, False
    queue = {
        r["downloadId"].upper(): r
        for r in data.get("records", [])
        if r.get("downloadId")
    }
    return queue, True


# ── Radarr Integration ────────────────────────────────────────────────────────
def get_radarr_queue() -> dict:
    """Return {hash_upper: queue_record} mapping for currently tracked Radarr downloads."""
    queue, _ = _fetch_servarr_queue(
        _radarr, "/api/v3/queue?pageSize=200&includeUnknownMovieItems=true"
    )
    return queue


def blacklist_radarr_release(queue_id: int, title: str) -> bool:
    """Remove from Radarr queue AND add to blocklist so it is never re-grabbed."""
    path = f"/api/v3/queue/{queue_id}?removeFromClient=true&blocklist=true&skipRedownload=false"
    result = _radarr("DELETE", path)
    if result is not None:
        log.info(f"✓ [Radarr] Blacklisted & removed from queue: '{title}' (queueId={queue_id})")
        return True
    else:
        log.error(f"✗ [Radarr] Failed to blacklist queue item {queue_id}")
        return False


def trigger_radarr_search(movie_id: int, title: str):
    """Ask Radarr to search all indexers for a fresh release of this movie."""
    result = _radarr("POST", "/api/v3/command", {"name": "MoviesSearch", "movieIds": [movie_id]})
    if result and result.get("id"):
        log.info(f"✓ [Radarr] Triggered MoviesSearch for movieId={movie_id} '{title}' (commandId={result['id']})")
        return result
    else:
        log.error(f"✗ [Radarr] Failed to trigger MoviesSearch for movieId={movie_id}")
        return None


# ── Sonarr Integration ────────────────────────────────────────────────────────
def get_sonarr_queue() -> dict:
    """Return {hash_upper: queue_record} mapping for currently tracked Sonarr downloads."""
    queue, _ = _fetch_servarr_queue(
        _sonarr,
        "/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true",
    )
    return queue


def blacklist_sonarr_release(queue_id: int, title: str) -> bool:
    """Remove from Sonarr queue AND add to blocklist so it is never re-grabbed."""
    path = f"/api/v3/queue/{queue_id}?removeFromClient=true&blocklist=true&skipRedownload=false"
    result = _sonarr("DELETE", path)
    if result is not None:
        log.info(f"✓ [Sonarr] Blacklisted & removed from queue: '{title}' (queueId={queue_id})")
        return True
    else:
        log.error(f"✗ [Sonarr] Failed to blacklist queue item {queue_id}")
        return False


def trigger_sonarr_search(series_id: int, episode_ids: list = None, title: str = ""):
    """
    Ask Sonarr to search all configured indexers for an alternative release.
    Prefers EpisodeSearch if episode IDs are available, falling back to SeriesSearch.
    """
    if episode_ids:
        payload = {"name": "EpisodeSearch", "episodeIds": episode_ids}
        result = _sonarr("POST", "/api/v3/command", payload)
        if result and result.get("id"):
            log.info(f"✓ [Sonarr] Triggered EpisodeSearch for episodeIds={episode_ids} '{title}' (commandId={result['id']})")
            return result
        else:
            log.warning(f"[Sonarr] EpisodeSearch failed for episodeIds={episode_ids}, falling back to SeriesSearch...")

    if series_id:
        payload = {"name": "SeriesSearch", "seriesId": series_id}
        result = _sonarr("POST", "/api/v3/command", payload)
        if result and result.get("id"):
            log.info(f"✓ [Sonarr] Triggered SeriesSearch for seriesId={series_id} '{title}' (commandId={result['id']})")
            return result
        else:
            log.error(f"✗ [Sonarr] Failed to trigger SeriesSearch for seriesId={series_id}")
            return None
    return None


# ── Notifications ─────────────────────────────────────────────────────────────
def notify(title: str, body: str, urgency: str = "critical"):
    """Send desktop notification via notify-send and push notification via ntfy."""
    try:
        subprocess.run(
            ["notify-send", "-a", "Orbit Server", "-u", urgency, title, body],
            timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception:
        pass  # Non-fatal: headless or notify-send not available

    if NTFY_TOPIC:
        try:
            url = f"{NTFY_URL.rstrip('/')}/{NTFY_TOPIC}"
            req = urllib.request.Request(
                url,
                data=body.encode("utf-8"),
                headers={
                    "Title": title,
                    "Priority": "urgent" if urgency == "critical" else "default",
                    "Tags": "warning,recycle"
                }
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            log.debug(f"ntfy notification failed: {e}")


# ── Orphan State Persistence ──────────────────────────────────────────────────
def _load_orphan_state() -> dict:
    """Load persisted {HASH_UPPER: first_seen_stalled_epoch} mapping."""
    if not os.path.exists(ORPHAN_STATE_FILE):
        return {}
    try:
        with open(ORPHAN_STATE_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return {str(k).upper(): int(v) for k, v in data.items() if isinstance(v, (int, float))}
    except Exception as e:
        log.debug(f"Could not load orphan state file {ORPHAN_STATE_FILE}: {e}")
    return {}


def _save_orphan_state(state: dict):
    """Atomically persist orphan stall timestamps to disk."""
    tmp_path = f"{ORPHAN_STATE_FILE}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
        os.replace(tmp_path, ORPHAN_STATE_FILE)
    except Exception as e:
        log.warning(f"Failed to persist orphan state file: {e}")
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


def _format_duration(seconds: int) -> str:
    """Format duration cleanly in minutes or hours."""
    return f"{round(seconds / 60, 1)}m" if seconds < 7200 else f"{round(seconds / 3600, 1)}h"


# ── Main Execution ────────────────────────────────────────────────────────────
def run(dry_run: bool = False):
    mode_tag = " [DRY-RUN]" if dry_run else ""
    log.info(
        f"Starting stall detection scan{mode_tag} "
        f"(threshold: {STALL_MINUTES}m / {STALL_SECS}s, orphan_threshold: {STALL_ORPHAN_THRESHOLD_SECS}s)"
    )

    opener = _qbit_opener()
    if not getattr(opener, "_qbit_auth_ok", True):
        log.warning("Aborting stall detection scan due to qBittorrent connectivity/auth error.")
        return

    stalled = get_stalled_torrents(opener)

    if not stalled:
        if not dry_run and _load_orphan_state():
            _save_orphan_state({})
        log.info("✓ No dead-swarm torrents found. All downloads healthy.")
        return

    # Trigger Servarr queue sync so Radarr and Sonarr have up-to-date mappings
    if not dry_run:
        refresh_servarr_queues()

    radarr_queue, radarr_ok = _fetch_servarr_queue(
        _radarr, "/api/v3/queue?pageSize=200&includeUnknownMovieItems=true"
    )
    sonarr_queue, sonarr_ok = _fetch_servarr_queue(
        _sonarr,
        "/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true",
    )

    now = int(time.time())
    prev_orphan_state = _load_orphan_state()
    next_orphan_state = {}

    requeued_count = 0
    orphan_purged_count = 0
    searched_series_ids = set()
    searched_movie_ids  = set()

    for t in stalled:
        h         = t["hash"].upper()
        name      = t.get("name", "unknown")[:80]
        idle_secs = int(t.get("_idle_secs", 0))
        idle_desc = t.get("_idle_desc", "unknown")
        reason    = t.get("_stall_reason", "stalled")
        seeds     = t.get("num_seeds", 0)
        avail     = float(t.get("availability", 0.0))
        prog      = float(t.get("progress", 0.0)) * 100

        log.warning(
            f"⚠ DEAD SWARM [{reason}]: '{name}'\n"
            f"  hash={h} | idle={idle_desc} | seeds={seeds} | avail={avail:.3f} | progress={prog:.1f}%"
        )

        matched = False

        # ── Check Sonarr Queue ────────────────────────────────────────────────
        if h in sonarr_queue:
            rec       = sonarr_queue[h]
            matched   = True
            queue_id  = rec["id"]
            series_id = rec.get("seriesId")
            title     = rec.get("title", name)

            # Extract episode ID(s)
            episode_ids = []
            if rec.get("episodeId"):
                episode_ids.append(rec["episodeId"])
            elif rec.get("episodes"):
                for ep in rec["episodes"]:
                    if isinstance(ep, dict) and "id" in ep:
                        episode_ids.append(ep["id"])

            log.info(f"  Matched Sonarr item: queueId={queue_id}, seriesId={series_id}, episodeIds={episode_ids}")

            if dry_run:
                log.info(f"  [DRY-RUN] Would blacklist Sonarr queueId={queue_id}, purge qBit {h}, and re-search.")
            else:
                blacklist_sonarr_release(queue_id, title)
                time.sleep(2)
                purge_qbit_torrent(opener, t["hash"])
                if episode_ids or (series_id and series_id not in searched_series_ids):
                    trigger_sonarr_search(series_id, episode_ids, title)
                    if series_id:
                        searched_series_ids.add(series_id)
                notify(
                    "🔄 Dead Swarm (Series) — Auto Requeue",
                    f"'{title[:60]}' stalled ({reason}, idle {idle_desc}, 0 seeds).\n"
                    f"Release blacklisted. Searching Sonarr for alternative release."
                )
            requeued_count += 1

        # ── Check Radarr Queue ────────────────────────────────────────────────
        elif h in radarr_queue:
            rec      = radarr_queue[h]
            matched  = True
            queue_id = rec["id"]
            movie_id = rec.get("movieId")
            title    = rec.get("title", name)

            log.info(f"  Matched Radarr item: queueId={queue_id}, movieId={movie_id}")

            if dry_run:
                log.info(f"  [DRY-RUN] Would blacklist Radarr queueId={queue_id}, purge qBit {h}, and re-search.")
            else:
                blacklist_radarr_release(queue_id, title)
                time.sleep(2)
                purge_qbit_torrent(opener, t["hash"])
                if movie_id and movie_id not in searched_movie_ids:
                    trigger_radarr_search(movie_id, title)
                    searched_movie_ids.add(movie_id)
                notify(
                    "🔄 Dead Swarm (Movie) — Auto Requeue",
                    f"'{title[:60]}' stalled ({reason}, idle {idle_desc}, 0 seeds).\n"
                    f"Release blacklisted. Searching Radarr for alternative release."
                )
            requeued_count += 1

        if not matched:
            first_seen = prev_orphan_state.get(h, now)
            orphan_age = max(idle_secs, max(0, now - first_seen))
            orphan_desc = _format_duration(orphan_age)

            servarr_degraded = (bool(RADARR_KEY) and not radarr_ok) or (bool(SONARR_KEY) and not sonarr_ok)
            if servarr_degraded:
                next_orphan_state[h] = first_seen
                log.warning(
                    f"  Hash {h} ('{name}') unmatched while Servarr API unreachable — "
                    f"preserving orphan state ({orphan_desc}) and deferring deletion."
                )
            elif orphan_age >= STALL_ORPHAN_THRESHOLD_SECS:
                if dry_run:
                    log.info(
                        f"  [DRY-RUN] Would delete orphan dead torrent '{name}' "
                        f"(hash={h}, orphan_age={orphan_desc} >= {STALL_ORPHAN_THRESHOLD_SECS}s)."
                    )
                    next_orphan_state[h] = first_seen
                else:
                    if purge_qbit_torrent(opener, t["hash"]):
                        log.info(
                            f"✓ [Orphan] Deleted orphan dead torrent '{name}' "
                            f"(hash={h}, reason={reason}, orphan_age={orphan_desc} >= {STALL_ORPHAN_THRESHOLD_SECS}s)"
                        )
                        notify(
                            "🧹 Orphan Dead Torrent — Purged",
                            f"'{name[:60]}' stalled outside Radarr/Sonarr ({reason}, age {orphan_desc}).\n"
                            f"Orphan torrent and partial files deleted from qBittorrent."
                        )
                        orphan_purged_count += 1
                    else:
                        next_orphan_state[h] = first_seen
                        log.warning(f"  Failed to purge orphan dead torrent {h} ('{name}'); keeping tracked.")
            else:
                next_orphan_state[h] = first_seen
                log.warning(
                    f"  Hash {h} ('{name}') not in Radarr/Sonarr queue — "
                    f"tracking orphan stall ({orphan_desc} / {STALL_ORPHAN_THRESHOLD_SECS}s threshold before purge)."
                )

    if not dry_run:
        _save_orphan_state(next_orphan_state)

    log.info(
        f"Stall detection scan complete{mode_tag} "
        f"({requeued_count} requeued, {orphan_purged_count} orphan purged, "
        f"{len(next_orphan_state)} orphan tracked out of {len(stalled)} stalled)."
    )


def main():
    parser = argparse.ArgumentParser(description="Orbit Server Stall Detector & Orphan Dead-Torrent Cleaner")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect stalled/orphan torrents and log actions without modifying queues or files",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
