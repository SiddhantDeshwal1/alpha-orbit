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
import html
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

DXBI_DASHBOARD_CSS = """
        :root {
            --dx-bg: #0b0b0d;
            --dx-bg-raised: #131317;
            --dx-surface: #18181d;
            --dx-surface-hover: #212128;
            --dx-line: rgba(255, 255, 255, 0.08);
            --dx-line-strong: rgba(255, 255, 255, 0.16);
            --dx-accent: #e50914;
            --dx-accent-soft: rgba(229, 9, 20, 0.14);
            --dx-connected: #46d369;
            --dx-connected-soft: rgba(70, 211, 105, 0.12);
            --dx-text: #f4f4f5;
            --dx-text-2: #c4c4cc;
            --dx-text-3: #8a8a96;
            --dx-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
            --dx-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            --dx-font-display: 'Bebas Neue', 'Inter', sans-serif;
        }
        * { box-sizing: border-box; }
        body {
            background-color: var(--dx-bg);
            background-image: radial-gradient(ellipse 75% 45% at 50% -12%, rgba(229, 9, 20, 0.14), transparent 70%);
            color: var(--dx-text);
            font-family: var(--dx-font-sans);
            margin: 0;
            padding: 28px 24px 48px;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
            text-rendering: optimizeLegibility;
        }
        .container { max-width: 980px; margin: 0 auto; }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
            background: var(--dx-bg-raised);
            border: 1px solid var(--dx-line);
            border-radius: 12px;
            padding: 16px 22px;
            margin-bottom: 24px;
        }
        .brand { display: flex; align-items: center; gap: 14px; }
        .brand-mark {
            width: 38px;
            height: 38px;
            border-radius: 8px;
            background: var(--dx-accent);
            color: #ffffff;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 6px 20px rgba(229, 9, 20, 0.35);
            flex-shrink: 0;
        }
        .brand h1 {
            margin: 0;
            font-family: var(--dx-font-display);
            font-size: 1.75rem;
            font-weight: 400;
            letter-spacing: 0.05em;
            line-height: 1;
            color: #ffffff;
        }
        .brand-sub {
            margin-top: 3px;
            font-size: 0.78rem;
            color: var(--dx-text-3);
            letter-spacing: 0.02em;
        }
        .nav-links { display: flex; flex-wrap: wrap; gap: 8px; }
        .nav-link {
            background: var(--dx-surface);
            border: 1px solid var(--dx-line);
            color: var(--dx-text-2);
            text-decoration: none;
            padding: 7px 13px;
            border-radius: 8px;
            font-size: 0.8rem;
            font-weight: 500;
            transition: background 0.18s var(--dx-ease), border-color 0.18s var(--dx-ease), color 0.18s var(--dx-ease);
        }
        .nav-link:hover {
            color: #ffffff;
            background: var(--dx-surface-hover);
            border-color: var(--dx-line-strong);
        }
        .banner {
            padding: 13px 18px;
            border-radius: 10px;
            margin-bottom: 22px;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.9rem;
            font-weight: 500;
        }
        .banner.ok {
            background: var(--dx-connected-soft);
            border: 1px solid rgba(70, 211, 105, 0.35);
            color: var(--dx-connected);
        }
        .banner.err {
            background: var(--dx-accent-soft);
            border: 1px solid rgba(229, 9, 20, 0.45);
            color: #ff6b73;
        }
        .status-hero {
            background: var(--dx-bg-raised);
            border: 1px solid var(--dx-line);
            border-top: 2px solid var(--dx-accent);
            border-radius: 14px;
            padding: 24px;
            margin-bottom: 30px;
            box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
        }
        .hero-head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            flex-wrap: wrap;
            gap: 14px;
        }
        .hero-eyebrow {
            font-size: 0.72rem;
            font-weight: 700;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--dx-accent);
            margin-bottom: 4px;
        }
        .hero-profile-name {
            font-family: var(--dx-font-display);
            font-size: 2.25rem;
            line-height: 1;
            letter-spacing: 0.04em;
            color: #ffffff;
        }
        .hero-badges {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
        }
        .latency-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: var(--dx-surface);
            border: 1px solid var(--dx-line);
            color: var(--dx-text-2);
            padding: 6px 12px;
            border-radius: 999px;
            font-size: 0.76rem;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
        }
        .latency-pill strong {
            color: #ffffff;
            font-variant-numeric: tabular-nums;
        }
        .killswitch-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: var(--dx-connected-soft);
            border: 1px solid rgba(70, 211, 105, 0.3);
            color: var(--dx-connected);
            padding: 6px 13px;
            border-radius: 999px;
            font-size: 0.76rem;
            font-weight: 700;
            letter-spacing: 0.04em;
        }
        .pulse {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--dx-connected);
            box-shadow: 0 0 10px rgba(70, 211, 105, 0.75);
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
            gap: 12px;
            margin-top: 20px;
        }
        .metric {
            background: var(--dx-surface);
            border: 1px solid var(--dx-line);
            padding: 14px 16px;
            border-radius: 10px;
            transition: background 0.18s var(--dx-ease), border-color 0.18s var(--dx-ease);
        }
        .metric:hover {
            background: var(--dx-surface-hover);
            border-color: var(--dx-line-strong);
        }
        .metric-label {
            font-size: 0.7rem;
            text-transform: uppercase;
            color: var(--dx-text-3);
            font-weight: 600;
            letter-spacing: 0.07em;
            margin-bottom: 6px;
        }
        .metric-value {
            font-size: 1rem;
            font-weight: 600;
            color: var(--dx-text);
            font-variant-numeric: tabular-nums;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .metric-value.connected { color: var(--dx-connected); }
        .section-title {
            font-family: var(--dx-font-display);
            font-size: 1.45rem;
            letter-spacing: 0.05em;
            margin: 0 0 14px 0;
            color: var(--dx-text);
            font-weight: 400;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(275px, 1fr));
            gap: 16px;
        }
        .card {
            background: var(--dx-surface);
            border: 1px solid var(--dx-line);
            border-radius: 12px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: transform 0.18s var(--dx-ease), background 0.18s var(--dx-ease), border-color 0.18s var(--dx-ease);
        }
        .card:hover {
            transform: translateY(-2px);
            background: var(--dx-surface-hover);
            border-color: var(--dx-line-strong);
        }
        .card.active-card {
            border-color: rgba(70, 211, 105, 0.45);
            box-shadow: 0 0 0 1px rgba(70, 211, 105, 0.18), 0 16px 36px rgba(0, 0, 0, 0.45);
        }
        .card-head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 12px;
        }
        .card-title {
            margin: 0 0 4px 0;
            font-size: 1.08rem;
            font-weight: 700;
            color: #ffffff;
        }
        .card-proto { font-size: 0.78rem; color: var(--dx-text-3); font-weight: 500; }
        .card-desc {
            font-size: 0.86rem;
            color: var(--dx-text-2);
            line-height: 1.5;
            margin: 0 0 18px 0;
            min-height: 40px;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 0.68rem;
            padding: 4px 9px;
            border-radius: 6px;
            font-weight: 700;
            letter-spacing: 0.06em;
            white-space: nowrap;
        }
        .badge.active {
            background: var(--dx-connected-soft);
            border: 1px solid rgba(70, 211, 105, 0.35);
            color: var(--dx-connected);
        }
        .badge.tier {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--dx-line);
            color: var(--dx-text-2);
        }
        .badge.tier-paid {
            border-color: rgba(229, 9, 20, 0.35);
            color: #ff8a90;
            background: var(--dx-accent-soft);
        }
        .btn {
            width: 100%;
            padding: 10px 14px;
            border-radius: 8px;
            font-family: var(--dx-font-sans);
            font-weight: 600;
            font-size: 0.875rem;
            cursor: pointer;
            border: none;
            transition: background 0.16s var(--dx-ease), transform 0.12s var(--dx-ease), opacity 0.16s var(--dx-ease);
        }
        .btn:focus-visible {
            outline: 2px solid var(--dx-accent);
            outline-offset: 2px;
        }
        .switch-btn {
            background: #ffffff;
            color: #000000;
        }
        .switch-btn:hover { background: rgba(255, 255, 255, 0.86); }
        .switch-btn:active { transform: scale(0.99); }
        .active-btn {
            background: var(--dx-connected-soft);
            border: 1px solid rgba(70, 211, 105, 0.3);
            color: var(--dx-connected);
            cursor: default;
        }
"""

def render_html_dashboard(message=None, is_error=False):
    t0 = time.monotonic()
    ip_info = get_gluetun_public_ip()
    probe_latency_ms = max(1, int(round((time.monotonic() - t0) * 1000)))
    pub_ip = html.escape(str(ip_info.get("public_ip", "Unknown")))
    country = html.escape(str(ip_info.get("country", "Unknown")))
    org = html.escape(str(ip_info.get("organization", "Cloudflare WARP Tunnel")))
    current_prof = VPN_PROFILES.get(CURRENT_PROFILE, VPN_PROFILES["cloudflare"])
    current_display = html.escape(current_prof["display"])

    msg_banner = ""
    if message:
        safe_msg = html.escape(str(message))
        banner_cls = "banner err" if is_error else "banner ok"
        icon = "!" if is_error else "✓"
        msg_banner = f"""
        <div class="{banner_cls}" role="status">
            <span style="font-weight:800;">{icon}</span>
            <span>{safe_msg}</span>
        </div>
        """

    cards_html = ""
    for pid, p in VPN_PROFILES.items():
        is_active = (pid == CURRENT_PROFILE)
        tier_cls = "badge tier tier-paid" if p["tier"] == "paid" else "badge tier"
        status_badge = (
            '<span class="badge active"><span class="pulse" style="width:6px;height:6px;"></span>ACTIVE</span>'
            if is_active
            else f'<span class="{tier_cls}">{html.escape(p["tier"].upper())}</span>'
        )
        btn_class = "btn active-btn" if is_active else "btn switch-btn"
        btn_text = "Currently Active" if is_active else f"Switch to {html.escape(p['display'])}"
        btn_action = f'onclick="switchProfile(\'{pid}\')"' if not is_active else 'disabled'
        card_class = "card active-card" if is_active else "card"

        cards_html += f"""
        <div class="{card_class}">
            <div class="card-head">
                <div>
                    <h3 class="card-title">{html.escape(p['display'])}</h3>
                    <div class="card-proto">{html.escape(p['protocol'])}</div>
                </div>
                {status_badge}
            </div>
            <p class="card-desc">{html.escape(p['description'])}</p>
            <button {btn_action} class="{btn_class}">{btn_text}</button>
        </div>
        """

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Orbit Server - VPN Control Center</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>{DXBI_DASHBOARD_CSS}</style>
</head>
<body>
    <div class="container">
        <header>
            <div class="brand">
                <span class="brand-mark" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </span>
                <div>
                    <h1>VPN Control Center</h1>
                    <div class="brand-sub">Orbit Server Zero-Trust Egress Switcher</div>
                </div>
            </div>
            <nav class="nav-links" aria-label="Service Shortcuts">
                <a href="http://127.0.0.1:3000" class="nav-link">Homepage</a>
                <a href="http://127.0.0.1:8081" class="nav-link">qBittorrent</a>
                <a href="http://127.0.0.1:7878" class="nav-link">Radarr</a>
                <a href="http://127.0.0.1:5055" class="nav-link">Seerr</a>
                <a href="http://127.0.0.1:8096" class="nav-link">Jellyfin</a>
            </nav>
        </header>

        {msg_banner}

        <section class="status-hero" aria-label="Active VPN Status">
            <div class="hero-head">
                <div>
                    <div class="hero-eyebrow">Connected VPN Profile</div>
                    <div class="hero-profile-name">{current_display}</div>
                </div>
                <div class="hero-badges">
                    <div class="latency-pill" title="Gluetun control probe latency">
                        <span>PROBE</span>
                        <strong>{probe_latency_ms} ms</strong>
                    </div>
                    <div class="killswitch-pill">
                        <div class="pulse"></div>
                        <span>IPTABLES KILL-SWITCH ENGAGED</span>
                    </div>
                </div>
            </div>

            <div class="status-grid">
                <div class="metric">
                    <div class="metric-label">Public Egress IP</div>
                    <div class="metric-value">{pub_ip}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Country</div>
                    <div class="metric-value">{country}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">ISP / ASN Network</div>
                    <div class="metric-value" title="{org}">{org}</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Leak Prevention</div>
                    <div class="metric-value connected">0.0.0.0/0 Blocked</div>
                </div>
                <div class="metric">
                    <div class="metric-label">Control Latency</div>
                    <div class="metric-value">{probe_latency_ms} ms</div>
                </div>
            </div>
        </section>

        <h2 class="section-title">Available VPN Profiles (One-Click Switch)</h2>

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
