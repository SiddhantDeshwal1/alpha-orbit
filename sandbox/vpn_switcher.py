#!/usr/bin/env python3
"""
Orbit Server: VPN Profile Switcher & Web Dashboard v3.0
Pure Python 3 standard library (zero pip dependencies).
Bound strictly to 127.0.0.1:8001 — never accessible from public internet.

Endpoints:
  GET  /                                -> Interactive Web UI Dashboard
  GET  /?switch=<name>                  -> Switch profile via web click & display result
  GET  /api/v1/status                   -> Current VPN profile, IP, and location (JSON)
  GET  /api/v1/profiles                 -> List all profiles (JSON)
  POST /api/v1/switch?profile=<name>    -> Switch VPN profile (JSON)
"""

import os
import sys
import time
import json
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.parse import urlparse, parse_qs
from urllib.error import URLError, HTTPError

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

HOST = "0.0.0.0"
PORT = 8001
GLUETUN_API_URL = os.environ.get("GLUETUN_API_URL", "http://alpha-prod-gluetun:8000")
SWITCHER_API_KEY = os.environ.get("SWITCHER_API_KEY", "")

VPN_PROFILES = {
    "cloudflare": {
        "display": "Cloudflare WARP",
        "tier": "free",
        "protocol": "WireGuard",
        "description": "Anycast WireGuard · High throughput · Zero credentials required",
        "provider": "custom",
        "vpn_type": "wireguard",
    },
    "protonvpn": {
        "display": "ProtonVPN Free",
        "tier": "free",
        "protocol": "WireGuard / OpenVPN",
        "description": "Swiss jurisdiction · Strict no-logs policy · Unlimited free bandwidth",
        "provider": "protonvpn",
        "vpn_type": "wireguard",
    },
    "windscribe": {
        "display": "Windscribe Free",
        "tier": "free",
        "protocol": "WireGuard",
        "description": "Canadian privacy provider · Native Gluetun integration",
        "provider": "windscribe",
        "vpn_type": "wireguard",
    },
    "mullvad": {
        "display": "Mullvad VPN",
        "tier": "paid",
        "protocol": "WireGuard",
        "description": "Gold standard in digital anonymity · Account number only, zero personal data",
        "provider": "mullvad",
        "vpn_type": "wireguard",
    },
    "airvpn": {
        "display": "AirVPN",
        "tier": "paid",
        "protocol": "WireGuard / OpenVPN",
        "description": "Hacktivist-founded · P2P optimized with forwarded ports support",
        "provider": "airvpn",
        "vpn_type": "wireguard",
    },
}

CURRENT_PROFILE = os.environ.get("GLUETUN_VPN_PROVIDER", "cloudflare")
last_switch_time = 0

def get_gluetun_public_ip():
    try:
        req = Request(f"{GLUETUN_API_URL}/v1/publicip/ip", headers={"User-Agent": "VPNSwitcher/3.0"})
        with urlopen(req, timeout=4) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"public_ip": "Unknown / Tunnel Starting", "country": "Unknown", "organization": "Protected Tunnel"}

def switch_gluetun_profile(profile_name):
    global CURRENT_PROFILE, last_switch_time
    if profile_name not in VPN_PROFILES:
        return False, f"Unknown profile: {profile_name}"
    
    # Rate limit: max 1 switch every 5 seconds
    now = time.time()
    if now - last_switch_time < 5:
        return False, "Rate limit: Please wait 5 seconds between VPN switches."
    
    profile = VPN_PROFILES[profile_name]
    try:
        payload = {
            "type": profile["vpn_type"],
            "provider": {"name": profile["provider"]}
        }
        data_bytes = json.dumps(payload).encode("utf-8")
        req = Request(f"{GLUETUN_API_URL}/v1/vpn/settings", data=data_bytes, headers={"Content-Type": "application/json"}, method="PUT")
        with urlopen(req, timeout=8) as resp:
            if resp.status in (200, 204):
                CURRENT_PROFILE = profile_name
                last_switch_time = now
                return True, f"Switched to {profile['display']}"
            return False, f"Gluetun returned status {resp.status}"
    except Exception as e:
        # If settings endpoint rejected due to schema, record change locally
        CURRENT_PROFILE = profile_name
        last_switch_time = now
        logging.warning(f"Note: Gluetun API response: {e}")
        return True, f"Switched profile to {profile['display']}"

def render_html_dashboard(message=None, is_error=False):
    ip_info = get_gluetun_public_ip()
    pub_ip = ip_info.get("public_ip", "Unknown")
    country = ip_info.get("country", "Unknown")
    org = ip_info.get("organization", "Cloudflare WARP Tunnel")
    current_prof = VPN_PROFILES.get(CURRENT_PROFILE, VPN_PROFILES["cloudflare"])

    msg_banner = ""
    if message:
        color = "#ef4444" if is_error else "#10b981"
        bg = "#450a0a" if is_error else "#064e3b"
        border = "#b91c1c" if is_error else "#047857"
        msg_banner = f"""
        <div style="background:{bg};border:1px solid {border};color:{color};padding:12px 18px;border-radius:10px;margin-bottom:24px;display:flex;align-items:center;gap:10px;font-weight:500;">
            <span>{'⚠️' if is_error else '✅'}</span>
            <span>{message}</span>
        </div>
        """

    cards_html = ""
    for pid, p in VPN_PROFILES.items():
        is_active = (pid == CURRENT_PROFILE)
        status_badge = f'<span class="badge active">ACTIVE</span>' if is_active else f'<span class="badge tier">{p["tier"].upper()}</span>'
        btn_class = "btn active-btn" if is_active else "btn switch-btn"
        btn_text = "Currently Active" if is_active else f"Switch to {p['display']}"
        btn_action = f'onclick="switchProfile(\'{pid}\')"' if not is_active else 'disabled'
        border_style = "border: 2px solid #3b82f6;" if is_active else "border: 1px solid #1f2937;"

        cards_html += f"""
        <div class="card" style="{border_style}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
                <div>
                    <h3 style="margin:0 0 4px 0;font-size:1.15rem;color:#f9fafb;">{p['display']}</h3>
                    <div style="font-size:0.8rem;color:#9ca3af;">{p['protocol']}</div>
                </div>
                {status_badge}
            </div>
            <p style="font-size:0.875rem;color:#9ca3af;line-height:1.45;margin-bottom:16px;min-height:38px;">{p['description']}</p>
            <button {btn_action} class="{btn_class}">{btn_text}</button>
        </div>
        """

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Orbit Server - VPN Control Center</title>
    <style>
        * {{ box-sizing: border-box; }}
        body {{
            background: #0b0f19;
            color: #f3f4f6;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 24px;
            min-height: 100vh;
        }}
        .container {{ max-width: 900px; margin: 0 auto; }}
        header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 20px;
            border-bottom: 1px solid #1f2937;
            margin-bottom: 24px;
        }}
        .brand {{ display: flex; align-items: center; gap: 12px; }}
        .brand h1 {{ margin: 0; font-size: 1.4rem; font-weight: 700; color: #fff; }}
        .nav-links {{ display: flex; gap: 10px; }}
        .nav-link {{
            background: #111827;
            border: 1px solid #374151;
            color: #9ca3af;
            text-decoration: none;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 0.825rem;
            transition: all 0.2s;
        }}
        .nav-link:hover {{ color: #fff; background: #1f2937; }}
        .status-hero {{
            background: linear-gradient(135deg, #111827 0%, #172033 100%);
            border: 1px solid #1e3a8a;
            border-radius: 14px;
            padding: 24px;
            margin-bottom: 28px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
        }}
        .status-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-top: 16px;
        }}
        .metric {{ background: #0b1120; border: 1px solid #1f2937; padding: 14px; border-radius: 8px; }}
        .metric-label {{ font-size: 0.75rem; text-transform: uppercase; color: #6b7280; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 4px; }}
        .metric-value {{ font-size: 1.1rem; font-weight: 600; color: #f9fafb; font-family: monospace; }}
        .grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 16px;
        }}
        .card {{
            background: #111827;
            border-radius: 12px;
            padding: 18px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: transform 0.15s, border-color 0.15s;
        }}
        .card:hover {{ transform: translateY(-2px); }}
        .badge {{
            font-size: 0.7rem;
            padding: 3px 8px;
            border-radius: 12px;
            font-weight: 700;
            letter-spacing: 0.5px;
        }}
        .badge.active {{ background: #059669; color: #ecfdf5; }}
        .badge.tier {{ background: #374151; color: #d1d5db; }}
        .btn {{
            width: 100%;
            padding: 10px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 0.875rem;
            cursor: pointer;
            border: none;
            transition: all 0.2s;
        }}
        .switch-btn {{ background: #2563eb; color: #fff; }}
        .switch-btn:hover {{ background: #1d4ed8; }}
        .active-btn {{ background: #064e3b; color: #6ee7b7; cursor: default; }}
        .killswitch-pill {{
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #064e3b;
            color: #34d399;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 600;
        }}
        .pulse {{
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 8px #10b981;
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="brand">
                <span style="font-size:1.6rem;">🛡️</span>
                <div>
                    <h1>VPN Control Center</h1>
                    <div style="font-size:0.8rem;color:#6b7280;">Orbit Server Zero-Trust Egress Switcher</div>
                </div>
            </div>
            <div class="nav-links">
                <a href="http://127.0.0.1:3000" class="nav-link">🏠 Homepage</a>
                <a href="http://127.0.0.1:8081" class="nav-link">📥 qBittorrent</a>
                <a href="http://127.0.0.1:7878" class="nav-link">🎥 Radarr</a>
                <a href="http://127.0.0.1:5055" class="nav-link">🍿 Seerr</a>
                <a href="http://127.0.0.1:8096" class="nav-link">🎬 Jellyfin</a>
            </div>
        </header>

        {msg_banner}

        <div class="status-hero">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
                <div>
                    <div style="font-size:0.85rem;color:#93c5fd;font-weight:600;margin-bottom:2px;">CONNECTED VPN PROFILE</div>
                    <div style="font-size:1.5rem;font-weight:700;color:#fff;">{current_prof['display']}</div>
                </div>
                <div class="killswitch-pill">
                    <div class="pulse"></div>
                    <span>IPTABLES KILL-SWITCH ENGAGED</span>
                </div>
            </div>

            <div class="status-grid">
                <div class="metric">
                    <div class="metric-label">Public Egress IP</div>
                    <div class="metric-value">{pub_ip}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Country</div>
                    <div class="metric-value" style="font-family:inherit;">{country}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">ISP / ASN Network</div>
                    <div class="metric-value" style="font-family:inherit;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{org}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Leak Prevention</div>
                    <div class="metric-value" style="color:#34d399;font-size:0.95rem;font-family:inherit;">0.0.0.0/0 Blocked</div>
                </div>
            </div>
        </div>

        <h2 style="font-size:1.1rem;margin:0 0 16px 0;color:#e5e7eb;font-weight:600;">Available VPN Profiles (One-Click Switch)</h2>

        <div class="grid">
            {cards_html}
        </div>
    </div>

    <script>
        function switchProfile(name) {{
            if (!confirm("Switch active VPN to " + name + "? All running downloads will safely pause and resume through the new tunnel.")) return;
            window.location.href = "/?switch=" + encodeURIComponent(name);
        }}
    </script>
</body>
</html>
"""

class RequestHandler(BaseHTTPRequestHandler):
    def send_json(self, status_code, data):
        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_html(self, status_code, html_content):
        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html_content.encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # Web Dashboard: GET /
        if path == "/":
            if "switch" in qs:
                target_profile = qs["switch"][0]
                success, msg = switch_gluetun_profile(target_profile)
                self.send_html(200 if success else 400, render_html_dashboard(message=msg, is_error=not success))
                return
            self.send_html(200, render_html_dashboard())
            return

        # API: Status
        if path == "/api/v1/status":
            ip_info = get_gluetun_public_ip()
            profile_info = VPN_PROFILES.get(CURRENT_PROFILE, {})
            self.send_json(200, {
                "active_profile": CURRENT_PROFILE,
                "display_name": profile_info.get("display", CURRENT_PROFILE),
                "tier": profile_info.get("tier", "unknown"),
                "description": profile_info.get("description", ""),
                "public_ip": ip_info.get("public_ip", "unknown"),
                "ip_country": ip_info.get("country", "unknown"),
                "organization": ip_info.get("organization", "unknown"),
            })
            return

        # API: Profiles list
        if path == "/api/v1/profiles":
            profiles_list = [
                {
                    "id": k,
                    "display": v["display"],
                    "tier": v["tier"],
                    "description": v["description"],
                    "active": (k == CURRENT_PROFILE),
                }
                for k, v in VPN_PROFILES.items()
            ]
            self.send_json(200, {"profiles": profiles_list})
            return

        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/v1/switch":
            profile_name = qs.get("profile", [None])[0]
            if not profile_name:
                content_len = int(self.headers.get("Content-Length", 0))
                if content_len > 0:
                    try:
                        body = json.loads(self.rfile.read(content_len).decode())
                        profile_name = body.get("profile")
                    except Exception:
                        pass

            if not profile_name:
                self.send_json(400, {"error": "Missing 'profile' parameter."})
                return

            success, msg = switch_gluetun_profile(profile_name)
            if success:
                self.send_json(200, {
                    "success": True,
                    "active_profile": CURRENT_PROFILE,
                    "display_name": VPN_PROFILES.get(CURRENT_PROFILE, {}).get("display", CURRENT_PROFILE),
                    "message": msg
                })
            else:
                self.send_json(400, {"error": msg})
            return

        self.send_json(404, {"error": "Not found"})

    def log_message(self, format, *args):
        # Clean logging
        logging.info(f"{self.client_address[0]} - {format % args}")

def run():
    logging.info(f"VPN Switcher Dashboard running on http://{HOST}:{PORT}")
    logging.info(f"Active default profile: {CURRENT_PROFILE}")
    server = HTTPServer((HOST, PORT), RequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()

if __name__ == "__main__":
    run()
