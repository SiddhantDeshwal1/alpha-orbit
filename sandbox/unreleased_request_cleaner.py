#!/usr/bin/env python3
"""
Orbit Server: Unreleased / Not-Uploaded Request Guard
Automatically detects movies that are not uploaded yet (in theaters / 0 releases found / 0 seeds),
cancels and purges the request from Seerr and Radarr so the queue stays 100% clean,
and dispatches a desktop notification to the user.
"""

import os
import sys
import json
import logging
import subprocess
import urllib.request
import urllib.error
import datetime

# ── Environment & Configuration ──────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CONFIG_DIR = os.path.dirname(SCRIPT_DIR)
ENV_FILE = os.path.join(CONFIG_DIR, ".env")

def _load_env():
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())

_load_env()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] [REQUEST-GUARD] %(message)s'
)

RADARR_URL = os.environ.get("RADARR_URL", "http://127.0.0.1:7878")
RADARR_API_KEY = os.environ.get("RADARR_API_KEY", "")
SEERR_URL = os.environ.get("SEERR_URL", "http://127.0.0.1:5055")
SEERR_API_KEY = os.environ.get("SEERR_API_KEY", "")

def api_get(url: str, headers: dict) -> dict:
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        logging.warning(f"GET {url} failed: {e}")
        return None

def api_delete(url: str, headers: dict) -> bool:
    try:
        req = urllib.request.Request(url, headers=headers, method="DELETE")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        logging.warning(f"DELETE {url} failed: {e}")
        return False

def notify_user(title: str, message: str):
    """Send desktop notification via notify-send on Hyprland/Arch."""
    try:
        subprocess.run(
            ["notify-send", "-a", "Orbit Server", "-u", "normal", title, message],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3
        )
        logging.info(f"[NOTIFIED] {title}: {message}")
    except Exception as e:
        logging.warning(f"Could not send notification: {e}")

def check_and_clean_unreleased():
    radarr_headers = {"X-Api-Key": RADARR_API_KEY, "Accept": "application/json"}
    seerr_headers = {"X-Api-Key": SEERR_API_KEY, "Accept": "application/json"}

    # 1. Fetch all movies from Radarr
    movies = api_get(f"{RADARR_URL}/api/v3/movie", radarr_headers)
    if not movies:
        logging.info("Radarr is offline or has no movies.")
        return

    # 2. Fetch all requests from Seerr
    seerr_requests = api_get(f"{SEERR_URL}/api/v1/request?take=50", seerr_headers)
    request_map = {}
    if seerr_requests and "results" in seerr_requests:
        for req in seerr_requests["results"]:
            tmdb_id = req.get("media", {}).get("tmdbId")
            if tmdb_id:
                request_map[tmdb_id] = req["id"]

    for movie in movies:
        title = movie.get("title", "Unknown")
        movie_id = movie.get("id")
        tmdb_id = movie.get("tmdbId")
        has_file = movie.get("hasFile", False)
        status = movie.get("status", "")

        # If movie already has downloaded file, skip
        if has_file:
            continue

        # Check if movie is unreleased (announced, tba, or still exclusively in theaters)
        digital_date = movie.get("digitalRelease")
        physical_date = movie.get("physicalRelease")
        is_unreleased = status in ("announced", "tba") or (status == "inCinemas" and not digital_date and not physical_date)

        if is_unreleased:
            logging.info(f"[-] Movie '{title}' (TMDb: {tmdb_id}) is not uploaded yet (Status: {status}). Cancelling...")

            # 1. Cancel request in Seerr
            seerr_req_id = request_map.get(tmdb_id)
            if seerr_req_id:
                if api_delete(f"{SEERR_URL}/api/v1/request/{seerr_req_id}", seerr_headers):
                    logging.info(f"[+] Successfully deleted request #{seerr_req_id} from Seerr for '{title}'.")

            # 2. Delete movie from Radarr library
            if api_delete(f"{RADARR_URL}/api/v3/movie/{movie_id}?deleteFiles=true", radarr_headers):
                logging.info(f"[+] Successfully purged '{title}' from Radarr queue.")

            # 3. Notify User
            msg = f"'{title}' is not uploaded yet (still in theaters / unreleased). Request canceled to keep your queue clean."
            notify_user("🎬 Movie Not Uploaded Yet", msg)

    # 3. Check for released movies with no file and no active download
    check_no_release_movies()

def check_no_release_movies():
    """
    Detects movies that are digitally released but have no file and are not
    currently downloading, more than NO_RESULT_HOURS after being added.
    Sends a desktop notification to inform the user — does NOT delete anything.
    """
    NO_RESULT_HOURS = int(os.environ.get("NO_RESULT_HOURS", "6"))

    radarr_headers = {"X-Api-Key": RADARR_API_KEY, "Accept": "application/json"}
    movies = api_get(f"{RADARR_URL}/api/v3/movie", radarr_headers)
    if not movies:
        return

    queue_data = api_get(f"{RADARR_URL}/api/v3/queue?pageSize=100", radarr_headers)
    queued_ids = {r["movieId"] for r in (queue_data or {}).get("records", []) if "movieId" in r}

    for movie in movies:
        if movie.get("hasFile"):
            continue
        if movie.get("status") not in ("released",):
            continue
        if movie["id"] in queued_ids:
            continue

        added_str = movie.get("added", "")
        age_hours = 0.0
        if added_str:
            try:
                added_dt = datetime.datetime.fromisoformat(added_str.replace("Z", "+00:00"))
                if added_dt.tzinfo is None:
                    added_dt = added_dt.replace(tzinfo=datetime.timezone.utc)
                now_dt = datetime.datetime.now(datetime.timezone.utc)
                age_hours = (now_dt - added_dt).total_seconds() / 3600
            except Exception:
                try:
                    added_dt = datetime.datetime.fromisoformat(added_str.rstrip("Z"))
                    age_hours = (datetime.datetime.utcnow() - added_dt).total_seconds() / 3600
                except Exception:
                    pass

        if age_hours < NO_RESULT_HOURS:
            continue

        title = movie.get("title", "Unknown")
        logging.warning(
            f"[NO-RELEASE] '{title}' (id={movie['id']}) has no file and is not downloading "
            f"({age_hours:.1f}h since added). Notifying user."
        )
        notify_user(
            "📭 No Torrent Found",
            f"'{title}' has been in library {int(age_hours)}h with no download.\n"
            f"Indexers found no matching torrent — check coverage or request manually."
        )

if __name__ == "__main__":
    check_and_clean_unreleased()
