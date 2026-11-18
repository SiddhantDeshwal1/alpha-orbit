#!/usr/bin/env python3
"""
Orbit Server: Stall Detector & Auto-Requeue v2.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Autonomous dead-swarm detection and automated requeue pipeline for both
Radarr (movies) and Sonarr (series/episodes).

Monitors qBittorrent for torrents stuck in:
  · `stalledDL` - 0 seeders and availability <= progress for >= STALL_SECS
  · `metaDL`    - 0 seeders stuck fetching metadata for >= STALL_SECS
  · `queuedDL`  - 0 seeders held in queue with dead swarm for >= STALL_SECS

When a dead-swarm torrent is detected:
  1. Identifies parent download in Radarr or Sonarr active queues.
  2. Permanently removes it from queue WITH blocklist=true (never grabbed again).
  3. Ensures qBittorrent purges any partial downloaded payload/files.
  4. Dispatches an automated re-search:
     - Radarr: MoviesSearch command for the target movie ID.
     - Sonarr: EpisodeSearch (or SeriesSearch) command for target episode/series.
  5. Sends desktop notifications via notify-send and push alerts via ntfy.
  6. Emits structured telemetry to serverData/sandbox/logs/stall_detector.log.

Invoked periodically by sandbox_supervisor.sh while STATE=ACTIVE.
Can also be run manually: python3 -u stall_detector.py
"""

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
QBIT_PASS = os.environ.get("QBIT_PASS", "adminadmin")

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

# Push notification setup
NTFY_URL   = os.environ.get("NTFY_URL",   "https://ntfy.sh")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")


# ── qBittorrent Helpers ───────────────────────────────────────────────────────
def _qbit_opener() -> urllib.request.OpenerDirector:
    """Authenticate with qBittorrent and return a cookie-bearing opener."""
    cj     = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    data   = urllib.parse.urlencode({"username": QBIT_USER, "password": QBIT_PASS}).encode("utf-8")
    try:
        opener.open(f"{QBIT_URL}/api/v2/auth/login", data=data, timeout=5)
    except Exception as e:
        log.warning(f"qBittorrent login failed: {e}")
    return opener


def get_stalled_torrents(opener) -> list:
    """
    Return all torrents meeting dead-swarm criteria:
      1. stalledDL: 0 seeds, idle >= STALL_SECS, availability <= progress + 0.01
      2. metaDL:    0 seeds, stuck fetching metadata for >= STALL_SECS
      3. queuedDL:  0 seeds, held in queue with dead swarm for >= STALL_SECS
    """
    try:
        # Fetch all active/downloading torrents
        resp = opener.open(f"{QBIT_URL}/api/v2/torrents/info", timeout=10)
        torrents = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log.warning(f"Failed to fetch torrent list from qBittorrent: {e}")
        return []

    now = int(time.time())
    results = []
    for t in torrents:
        state    = t.get("state", "")
        seeds    = t.get("num_seeds", 0)
        last_act = t.get("last_activity", 0)
        added_on = t.get("added_on", 0)
        avail    = float(t.get("availability", 0.0))
        progress = float(t.get("progress", 0.0))

        # Calculate effective idle time
        effective_act = last_act if (last_act and last_act > 0) else added_on
        idle = max(0, now - effective_act) if effective_act else 0

        is_stalled = False
        stall_reason = ""

        if state == "stalledDL":
            # Swarm has 0 seeds and no remaining pieces anywhere in swarm
            if seeds == 0 and idle >= STALL_SECS and avail <= (progress + 0.01):
                is_stalled = True
                stall_reason = f"stalledDL (0 seeds, avail={avail:.3f} <= prog={progress:.3f})"

        elif state == "metaDL":
            # Magnet unable to retrieve metadata due to 0 seeds for >= STALL_SECS
            if seeds == 0 and idle >= STALL_SECS:
                is_stalled = True
                stall_reason = "metaDL (stuck retrieving metadata, 0 seeds)"

        elif state == "queuedDL":
            # Queued download with 0 seeds and no swarm availability
            if seeds == 0 and idle >= STALL_SECS and avail <= (progress + 0.01):
                is_stalled = True
                stall_reason = f"queuedDL (held in queue with 0 seeds, avail={avail:.3f})"

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


# ── Radarr Integration ────────────────────────────────────────────────────────
def get_radarr_queue() -> dict:
    """Return {hash_upper: queue_record} mapping for currently tracked Radarr downloads."""
    data = _radarr("GET", "/api/v3/queue?pageSize=200&includeUnknownMovieItems=true")
    if not data:
        return {}
    return {
        r["downloadId"].upper(): r
        for r in data.get("records", [])
        if r.get("downloadId")
    }


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
    data = _sonarr("GET", "/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true")
    if not data:
        return {}
    return {
        r["downloadId"].upper(): r
        for r in data.get("records", [])
        if r.get("downloadId")
    }


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


# ── Main Execution ────────────────────────────────────────────────────────────
def run():
    log.info(f"Starting stall detection scan (threshold: {STALL_MINUTES}m / {STALL_SECS}s)")

    opener  = _qbit_opener()
    stalled = get_stalled_torrents(opener)

    if not stalled:
        log.info("✓ No dead-swarm torrents found. All downloads healthy.")
        return

    # Trigger Servarr queue sync so Radarr and Sonarr have up-to-date mappings
    refresh_servarr_queues()

    radarr_queue = get_radarr_queue()
    sonarr_queue = get_sonarr_queue()

    processed_count = 0
    searched_series_ids = set()
    searched_movie_ids  = set()

    for t in stalled:
        h         = t["hash"].upper()
        name      = t.get("name", "unknown")[:80]
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

            # 1. Blacklist dead release in Sonarr and remove from queue
            blacklist_sonarr_release(queue_id, title)
            time.sleep(2)

            # 2. Direct qBittorrent deletion fallback
            purge_qbit_torrent(opener, t["hash"])

            # 3. Trigger fresh search in Sonarr
            # If no episode IDs, avoid spamming duplicate SeriesSearch within same run
            if episode_ids or (series_id and series_id not in searched_series_ids):
                trigger_sonarr_search(series_id, episode_ids, title)
                if series_id:
                    searched_series_ids.add(series_id)

            # 4. Notify user
            notify(
                "🔄 Dead Swarm (Series) — Auto Requeue",
                f"'{title[:60]}' stalled ({reason}, idle {idle_desc}, 0 seeds).\n"
                f"Release blacklisted. Searching Sonarr for alternative release."
            )
            processed_count += 1

        # ── Check Radarr Queue ────────────────────────────────────────────────
        elif h in radarr_queue:
            rec      = radarr_queue[h]
            matched  = True
            queue_id = rec["id"]
            movie_id = rec.get("movieId")
            title    = rec.get("title", name)

            log.info(f"  Matched Radarr item: queueId={queue_id}, movieId={movie_id}")

            # 1. Blacklist dead release in Radarr and remove from queue
            blacklist_radarr_release(queue_id, title)
            time.sleep(2)

            # 2. Direct qBittorrent deletion fallback
            purge_qbit_torrent(opener, t["hash"])

            # 3. Trigger fresh search in Radarr
            if movie_id and movie_id not in searched_movie_ids:
                trigger_radarr_search(movie_id, title)
                searched_movie_ids.add(movie_id)

            # 4. Notify user
            notify(
                "🔄 Dead Swarm (Movie) — Auto Requeue",
                f"'{title[:60]}' stalled ({reason}, idle {idle_desc}, 0 seeds).\n"
                f"Release blacklisted. Searching Radarr for alternative release."
            )
            processed_count += 1

        if not matched:
            log.warning(
                f"  Hash {h} ('{name}') not found in active Radarr or Sonarr queue — manual review needed."
            )

    log.info(f"Stall detection scan complete ({processed_count}/{len(stalled)} stalled torrents requeued).")


if __name__ == "__main__":
    run()
