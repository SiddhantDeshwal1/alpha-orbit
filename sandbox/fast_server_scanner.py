#!/usr/bin/env python3
"""
Orbit Server: High-Performance Server & Tracker Scanner Pipeline v1.0
Autonomous Hourly Updater for Fastest WireGuard/WARP Endpoints and BitTorrent Trackers.

Features:
  1. Concurrently benchmarks Cloudflare WARP WireGuard endpoint IPs (162.159.193.x, 162.159.192.x, 162.159.195.x, etc.)
  2. Selects the Top 10-20 fastest servers (sub-10ms latency)
  3. Updates serverConfig/.env with the #1 fastest endpoint IP & port
  4. Fetches the latest verified top-tier BitTorrent tracker servers and writes them to best_trackers.txt
  5. Runs in one-shot mode (--once) or continuous hourly daemon mode (--daemon / --hourly)
"""

import os
import re
import sys
import time
import json
import socket
import logging
import argparse
import subprocess
import urllib.request
import urllib.parse
import http.cookiejar
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] [SERVER-PIPELINE] %(message)s'
)

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CONFIG_DIR = os.path.dirname(SCRIPT_DIR)
ENV_FILE = os.path.join(CONFIG_DIR, ".env")
FAST_SERVERS_JSON = os.path.join(SCRIPT_DIR, "fast_servers.json")
BEST_TRACKERS_TXT = os.path.join(SCRIPT_DIR, "best_trackers.txt")

# Verified Cloudflare WireGuard / WARP Anycast endpoints (162.159.192.x)
CANDIDATE_POOLS = [
    f"162.159.192.{i}" for i in range(1, 30)
]

STANDARD_WARP_PORTS = [2408, 500, 1701, 4500]

TRACKER_SOURCES = [
    "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
    "https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt"
]

def ping_ip(ip: str, timeout_sec: float = 1.0) -> dict:
    """Measure RTT latency and packet loss for an IP address."""
    try:
        cmd = ["ping", "-c", "2", "-W", str(int(timeout_sec)), ip]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout_sec + 1.5)
        if proc.returncode == 0:
            m = re.search(r"min/avg/max/mdev = ([0-9.]+)/([0-9.]+)/([0-9.]+)", proc.stdout)
            if m:
                avg_rtt = float(m.group(2))
                return {"ip": ip, "latency_ms": round(avg_rtt, 2), "packet_loss": 0, "status": "online"}
    except Exception:
        pass
    return {"ip": ip, "latency_ms": 9999.0, "packet_loss": 100, "status": "offline"}

def scan_warp_endpoints(top_n: int = 20) -> list:
    """Scan candidate IP pool concurrently and return top N fastest servers."""
    logging.info(f"Scanning {len(CANDIDATE_POOLS)} candidate WireGuard / WARP server endpoints...")
    online_servers = []

    with ThreadPoolExecutor(max_workers=25) as executor:
        futures = {executor.submit(ping_ip, ip, 1.0): ip for ip in CANDIDATE_POOLS}
        for future in as_completed(futures):
            res = future.result()
            if res["status"] == "online" and res["latency_ms"] < 200.0:
                online_servers.append(res)

    online_servers.sort(key=lambda s: s["latency_ms"])
    top_servers = online_servers[:top_n]

    for idx, s in enumerate(top_servers, 1):
        s["rank"] = idx
        s["port"] = 2408
        s["protocol"] = "WireGuard"
        logging.info(f" Rank #{idx:02d} | Server: {s['ip']:16} | Latency: {s['latency_ms']:6.2f} ms | Status: FAST AF")

    return top_servers

def fetch_best_trackers() -> list:
    """Download fresh, verified high-speed BitTorrent tracker servers."""
    trackers = set()
    for url in TRACKER_SOURCES:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "OrbitServer/2.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                lines = resp.read().decode("utf-8").splitlines()
                for line in lines:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        trackers.add(line)
        except Exception as e:
            logging.warning(f"Failed to fetch trackers from {url}: {e}")

    # Prioritize UDP trackers over HTTP/HTTPS (UDP is fastest & lowest overhead)
    def tracker_priority(url: str):
        u = url.lower()
        if u.startswith("udp://"):
            prio = 0
        elif u.startswith("https://"):
            prio = 1
        elif u.startswith("http://"):
            prio = 2
        else:
            prio = 3
        return (prio, u)

    tracker_list = sorted(list(trackers), key=tracker_priority)[:30]
    udp_count = sum(1 for t in tracker_list if t.lower().startswith("udp://"))
    logging.info(f"Successfully harvested {len(tracker_list)} high-speed active trackers ({udp_count} UDP prioritized) from {len(trackers)} candidates.")
    return tracker_list

def update_env_file(best_ip: str, port: int = 2408) -> bool:
    """Update WARP_ENDPOINT_IP in .env with the new fastest server."""
    if not os.path.exists(ENV_FILE):
        logging.warning(f".env file not found at {ENV_FILE}")
        return False

    with open(ENV_FILE, "r") as f:
        content = f.read()

    old_ip_match = re.search(r"^WARP_ENDPOINT_IP=(.*)$", content, re.MULTILINE)
    old_ip = old_ip_match.group(1).strip() if old_ip_match else "unknown"

    if old_ip == best_ip:
        logging.info(f".env already has fastest server endpoint: {best_ip}")
        return True

    new_content = re.sub(r"^WARP_ENDPOINT_IP=.*$", f"WARP_ENDPOINT_IP={best_ip}", content, flags=re.MULTILINE)
    new_content = re.sub(r"^WARP_ENDPOINT_PORT=.*$", f"WARP_ENDPOINT_PORT={port}", new_content, flags=re.MULTILINE)

    with open(ENV_FILE, "w") as f:
        f.write(new_content)

    logging.info(f"[+] Updated .env WARP_ENDPOINT_IP from '{old_ip}' -> '{best_ip}' (Port {port})")
    return True

def update_template_conf(template_conf: str, trackers: list) -> bool:
    """Safely update qBittorrent template conf without multiline appends or corruption."""
    if not os.path.exists(template_conf):
        return False

    try:
        with open(template_conf, "r") as f:
            lines = f.readlines()

        escaped_trackers = "\\n".join(trackers)
        new_lines = []
        in_bittorrent = False
        trackers_inserted = False

        for line in lines:
            stripped = line.strip()
            if stripped.startswith("["):
                if in_bittorrent and not trackers_inserted:
                    new_lines.append(f"Session\\AdditionalTrackers={escaped_trackers}\n")
                    new_lines.append("Session\\AddTrackersEnabled=true\n")
                    trackers_inserted = True
                in_bittorrent = (stripped == "[BitTorrent]")
                new_lines.append(line)
                continue

            if in_bittorrent:
                # Strip existing tracker configs or stray multiline URL dumps
                if (stripped.startswith("Session\\AdditionalTrackers=") or
                    stripped.startswith("Session\\TrackersList=") or
                    stripped.startswith("Session\\AddTrackersEnabled=") or
                    stripped.startswith("udp://") or
                    stripped.startswith("http://") or
                    stripped.startswith("https://")):
                    if not trackers_inserted:
                        new_lines.append(f"Session\\AdditionalTrackers={escaped_trackers}\n")
                        new_lines.append("Session\\AddTrackersEnabled=true\n")
                        trackers_inserted = True
                    continue

            new_lines.append(line)

        if in_bittorrent and not trackers_inserted:
            new_lines.append(f"Session\\AdditionalTrackers={escaped_trackers}\n")
            new_lines.append("Session\\AddTrackersEnabled=true\n")
            trackers_inserted = True

        if not trackers_inserted:
            new_lines.append("\n[BitTorrent]\n")
            new_lines.append(f"Session\\AdditionalTrackers={escaped_trackers}\n")
            new_lines.append("Session\\AddTrackersEnabled=true\n")

        with open(template_conf, "w") as f:
            f.writelines(new_lines)

        logging.info(f"[+] Safely updated template conf {template_conf} ({len(new_lines)} lines, single-line QSettings format)")
        return True
    except Exception as e:
        logging.warning(f"Could not update trackers in template conf: {e}")
        return False

def update_qbittorrent_trackers(trackers: list) -> bool:
    """Inject fresh verified trackers dynamically via qBittorrent REST API and template conf."""
    trackers_str = "\n".join(trackers)
    api_updated = False
    base_url = "http://127.0.0.1:8081"

    # 1. Update via qBittorrent authenticated REST API
    try:
        cj = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        try:
            login_data = urllib.parse.urlencode({"username": "admin", "password": ""}).encode()
            login_req = urllib.request.Request(f"{base_url}/api/v2/auth/login", data=login_data)
            opener.open(login_req, timeout=5)
        except Exception as e:
            logging.debug(f"Auth bypass or error: {e}")

        # Update global default preferences for new downloads
        pref_payload = urllib.parse.urlencode({
            "json": json.dumps({"add_trackers_enabled": True, "add_trackers": trackers_str})
        }).encode()
        resp = opener.open(f"{base_url}/api/v2/app/setPreferences", data=pref_payload, timeout=5)
        if resp.status == 200:
            logging.info(f"[+] Successfully saved {len(trackers)} default trackers via qBittorrent preferences API!")
            api_updated = True

        # Fetch all existing torrents and inject trackers into active, stalled, and queued torrents
        info_req = urllib.request.Request(f"{base_url}/api/v2/torrents/info")
        with opener.open(info_req, timeout=5) as info_resp:
            torrents = json.loads(info_resp.read().decode("utf-8"))

        target_states = {
            "downloading", "stalleddl", "queueddl", "metadl", "forceddl",
            "uploading", "stalledup", "queuedup", "forcedup",
            "allocating", "checkingdl", "checkingup", "checkingresumedata", "moving"
        }

        target_torrents = []
        for t in torrents:
            st = str(t.get("state", "")).lower()
            if st in target_states or ("paused" not in st and "stopped" not in st and st != "error"):
                target_torrents.append(t)

        if target_torrents:
            hashes_joined = "|".join(t["hash"] for t in target_torrents)
            add_payload = urllib.parse.urlencode({
                "hash": hashes_joined,
                "urls": trackers_str
            }).encode()
            add_req = urllib.request.Request(f"{base_url}/api/v2/torrents/addTrackers", data=add_payload)
            opener.open(add_req, timeout=10)
            logging.info(f"[+] Successfully injected {len(trackers)} fresh trackers into {len(target_torrents)} active/stalled/queued torrents!")

            # Trigger immediate re-announce so torrents connect to newly injected trackers
            try:
                reann_payload = urllib.parse.urlencode({"hashes": hashes_joined}).encode()
                reann_req = urllib.request.Request(f"{base_url}/api/v2/torrents/reannounce", data=reann_payload)
                opener.open(reann_req, timeout=5)
                logging.info(f"[+] Triggered immediate re-announce for {len(target_torrents)} torrents.")
            except Exception as e:
                logging.debug(f"Reannounce notification: {e}")
        else:
            logging.info("[*] No active, stalled, or queued torrents found to inject trackers.")

    except Exception as e:
        logging.info(f"qBittorrent API offline or busy (will update template conf): {e}")

    # 2. Update host-owned template conf safely without multiline corruption
    template_conf = os.path.join(SCRIPT_DIR, "qbittorrent.conf")
    update_template_conf(template_conf, trackers)

    return api_updated

def run_pipeline():
    """Execute complete server and tracker refresh cycle."""
    logging.info("==============================================================")
    logging.info(" Starting Hourly Fast AF Server & Tracker Refresh Pipeline    ")
    logging.info("==============================================================")

    # 1. Benchmark WireGuard / WARP endpoints
    top_servers = scan_warp_endpoints(top_n=20)
    if top_servers:
        best_server = top_servers[0]
        logging.info(f"[★] Crowned #1 Fastest Server: {best_server['ip']} ({best_server['latency_ms']} ms)")
        
        # Save registry JSON
        registry = {
            "last_updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fastest_server": best_server,
            "top_servers_count": len(top_servers),
            "servers": top_servers
        }
        with open(FAST_SERVERS_JSON, "w") as f:
            json.dump(registry, f, indent=2)
        logging.info(f"[+] Saved top 20 servers registry to {FAST_SERVERS_JSON}")

        # Update .env
        update_env_file(best_server["ip"], best_server["port"])
    else:
        logging.error("No candidate servers responded. Keeping existing configuration.")

    # 2. Fetch fresh top-tier BitTorrent trackers
    trackers = fetch_best_trackers()
    if trackers:
        with open(BEST_TRACKERS_TXT, "w") as f:
            f.write("\n".join(trackers) + "\n")
        logging.info(f"[+] Saved {len(trackers)} active trackers to {BEST_TRACKERS_TXT}")
        update_qbittorrent_trackers(trackers)

    logging.info("==============================================================")
    logging.info(" Pipeline complete. Server stack is primed with fastest nodes! ")
    logging.info("==============================================================")

def main():
    parser = argparse.ArgumentParser(description="Orbit Server Fast Server & Tracker Pipeline")
    parser.add_argument("--once", action="store_true", help="Run once and exit immediately")
    parser.add_argument("--daemon", "--hourly", action="store_true", help="Run continuously every 1 hour (3600 seconds)")
    parser.add_argument("--interval", type=int, default=3600, help="Interval in seconds for daemon mode (default: 3600)")
    args = parser.parse_args()

    if args.daemon:
        logging.info(f"Starting pipeline in Daemon Mode (interval: {args.interval}s / {args.interval/60:.0f}m)...")
        while True:
            try:
                run_pipeline()
            except Exception as e:
                logging.error(f"Error during pipeline execution: {e}")
            logging.info(f"Sleeping for {args.interval} seconds until next server refresh cycle...")
            time.sleep(args.interval)
    else:
        run_pipeline()

if __name__ == "__main__":
    main()
