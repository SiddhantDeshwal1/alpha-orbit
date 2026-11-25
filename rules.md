# Developer & AI Agent Engineering Rules

> **Purpose:** This file defines the mandatory engineering standards, CI/CD verification checks, and architectural invariants that every AI agent and developer **MUST** follow before committing or pushing changes to the `alpha-orbit` repository.

---

## 1. Quick Verification Commands (Pre-Commit Checklist)

Before making any commit or push, run the following verification sequence. **All checks must exit with code 0.**

```bash
# 1. Shell Script Validation
shellcheck -S warning scripts/*.sh sandbox/*.sh quadlets/*.sh
bash -n scripts/*.sh sandbox/*.sh quadlets/*.sh

# 2. JavaScript Syntax Validation
for file in \
  dashboard/server.js \
  dashboard/lib/accessManager.js \
  dashboard/public/app.js \
  jellyfin/custom-signup-request.js \
  jellyfin/custom-discover-request.js \
  jellyfin/custom-hover-preview.js \
  jellyfin/custom-details-hero.js \
  jellyfin/test-state-machine.js; do
  node --check "$file"
done

# 3. Prettier Code Style Formatting (MANDATORY for CI)
# Check formatting:
npx --yes prettier --check "dashboard/**/*.{js,css,html,json}"
# Auto-fix formatting:
npx --yes prettier --write "dashboard/**/*.{js,css,html,json}"

# 4. Jellyfin State Machine & Concurrency Suite (192/192 assertions)
node jellyfin/test-state-machine.js

# 5. Python Syntax & Ruff Linting
python3 -m py_compile sandbox/*.py
python3 -m pip install --no-cache-dir ruff  # if not installed
ruff check --select E9,F63,F7,F82 sandbox/*.py

# 6. Compose Manifest Validation
podman compose -f compose.yaml config >/dev/null
podman compose -f compose.sandbox.yaml config >/dev/null

# 7. Quadlet Template Rendering & Placeholder Validation
./quadlets/install-quadlets.sh --render-only --render-dir /tmp/quadlets-test
# Verify zero unreplaced __[A-Z0-9_]+__ tokens and valid INI sections:
python3 - /tmp/quadlets-test <<'PY'
import configparser, pathlib, re, sys
render_dir = pathlib.Path(sys.argv[1])
files = [p for p in render_dir.rglob('*') if p.is_file() and p.suffix in {'.container', '.network', '.volume', '.pod', '.service', '.timer', '.conf'}]
token_re = re.compile(r'__[A-Z0-9_]+__')
for p in files:
    text = p.read_text(encoding='utf-8')
    assert not token_re.findall(text), f"Unreplaced token in {p}"
    cp = configparser.ConfigParser(strict=False, interpolation=None)
    cp.read_string(text, source=str(p))
    assert cp.sections(), f"No INI sections in {p}"
print("All Quadlets rendered and parsed successfully!")
PY
rm -rf /tmp/quadlets-test
```

---

## 2. CI/CD Pipeline Checks (as Defined in `.github/workflows/ci-cd.yml`)

The repository runs a strict automated GitHub Actions workflow on every push to `main` and pull request to `main` / `dev`.

### Step 1: ShellCheck (`shellcheck -S warning`)
- **Target files:** `scripts/*.sh`, `sandbox/*.sh`, `quadlets/*.sh`.
- **Severity threshold:** `-S warning` (errors and warnings fail the build).
- **Rule:** Never disable shellcheck rules globally. If a specific SC warning is intentional (e.g., dynamic variable expansion or intentional eval), use a localized `# shellcheck disable=SCxxxx` comment with an explanation.

### Step 2: JavaScript Syntax Check (`node --check`)
- **Target files:**
  - `dashboard/server.js`
  - `dashboard/lib/accessManager.js`
  - `dashboard/public/app.js`
  - `jellyfin/custom-signup-request.js`
  - `jellyfin/custom-discover-request.js`
  - `jellyfin/custom-hover-preview.js`
  - `jellyfin/custom-details-hero.js`
  - `jellyfin/test-state-machine.js`
- **Rule:** Every modified JavaScript file must pass `node --check`. No syntax errors or unsupported features.

### Step 3: Prettier Code Style Check (`prettier --check`)
- **Target files:** `dashboard/**/*.{js,css,html,json}`
- **Rule:** CI will **FAIL** if any file in `dashboard/` violates Prettier formatting.
- Always run `npx prettier --write "dashboard/**/*.{js,css,html,json}"` (or `npm run format` inside `dashboard/`) before committing.

### Step 4: Jellyfin State Machine & Video Concurrency Suite
- **Command:** `node jellyfin/test-state-machine.js`
- **Rule:** All 192 assertions must pass. Tests verify:
  - Global audio locks (`home-hero`, `hover`, `hero`) are acquired and released cleanly.
  - Video elements are paused/muted when offscreen or when navigating between views.
  - Hardware decoder resources are freed upon route change.
  - No direct calls to `api.themoviedb.org` or hardcoded `TMDB_PUBLIC_API_KEY` in client-side scripts (all queries route through `:3000/api/tmdb/proxy`).
  - No negative margin collisions with video edges.

### Step 5: Python Syntax & Ruff Linting
- **Command:** `python3 -m py_compile sandbox/*.py && ruff check --select E9,F63,F7,F82 sandbox/*.py`
- **Rule:** Zero syntax errors (`E9`), invalid comparisons (`F63`), syntax errors in formatting (`F7`), or undefined variable references (`F82`).

### Step 6: Quadlet Templates Dry-Run & INI Verification
- **Command:** Render Quadlets via `quadlets/install-quadlets.sh` and parse all `.container`, `.network`, `.volume`, `.service`, and `.timer` files.
- **Rule:**
  - Zero unreplaced `__[A-Z0-9_]+__` template tokens.
  - Every rendered file must be parseable as standard INI with valid sections.
  - `SecurityLabelDisable=true` and `/run/podman:/run/podman:ro` directory socket binds (never `:Z` file socket binds) on containers communicating with the Podman daemon socket.

### Step 7: Multi-Arch Container Image Build
- **Target:** `dashboard/Dockerfile`
- **Architectures:** `linux/amd64`, `linux/arm64`
- **Rule:** The Dashboard image must build with zero external npm dependencies (`"dependencies": {}` in `dashboard/package.json`). Only Node.js built-in modules are permitted (`http`, `https`, `crypto`, `fs`, `path`, `url`, `os`, `net`).

---

## 3. Core Architectural & Security Rules

### Zero External Node.js Dependencies in Dashboard
- `dashboard/package.json` must remain `"dependencies": {}`.
- Never run `npm install <package>`. Use Node.js built-in standard library for everything (HTTP servers, crypto, file system, streams).

### Password Encryption & Security
- Applicant passwords collected via `POST /api/auth/signup-request` **MUST NEVER** be written to disk in plaintext.
- Passwords must be encrypted using **AES-256-GCM** with a secure key derived from `DASHBOARD_ENC_SECRET` (or `JELLYFIN_API_KEY:SWITCHER_API_KEY` HMAC or auto-generated `0o600` master key).
- The `encryptedPassword` field **MUST BE PERMANENTLY WIPED** as soon as the request is approved or rejected.
- Store file permissions for `access-requests.json` and `.enc.key` must be strictly `0o600`, and directories `0o700`.

### Container Networking & Service Hostnames
- Inside Podman bridge networks (`alpha_prod_default`, `alpha_prod_sandbox_net`), container-to-container calls **MUST NEVER** use `127.0.0.1` unless running in the same network namespace (e.g., `network_mode: "service:tailscale"`).
- Always use container DNS aliases:
  - Jellyfin: `http://alpha-prod-tailscale:8096` or `http://alpha-prod-jellyfin:8096`
  - Seerr: `http://alpha-prod-tailscale:5055` or `http://alpha-prod-seerr:5055`
  - Radarr: `http://alpha-prod-gluetun:7878`
  - Sonarr: `http://alpha-prod-gluetun:8989`
  - Gluetun / VPN Switcher: `http://alpha-prod-vpn-switcher:8001`
  - ntfy: `http://alpha-prod-ntfy:80`
  - Dashboard: `http://alpha-prod-tailscale:3000`

### Jellyfin 12.2.0 API Authentication Header
- When querying the Jellyfin REST API with an API key, **ALWAYS** use the `Authorization` header:
  ```http
  Authorization: MediaBrowser Client="OrbitAdmin", Device="Dashboard", DeviceId="orbit-dashboard", Version="1.0.0", Token="<JELLYFIN_API_KEY>"
  ```
  *(Do not rely exclusively on `X-Emby-Token` or query parameter `?api_key=`, which return HTTP 401 on recent Jellyfin versions).*

### 7-Day Inactive Retention Policy
- Inactive deletion in `sandbox/retention.sh` is governed by Jellyfin `UserData.LastPlayedDate` across all users, **not** file `mtime`.
- If an item was downloaded 20 days ago but watched 2 days ago, its inactive age is 2 days (`< 7`), so it **MUST NOT** be deleted.
- Active `/Sessions` must always be protected from deletion.
- On deletion, always unmonitor the item in Radarr/Sonarr (`UNMONITOR_ON_DELETE=true`) and trigger Jellyfin `/Library/Refresh` to prevent re-downloads.

### `dx.bi` Visual Design System Fidelity
- All UI surfaces (Dashboard, Jellyfin Web, VPN Switcher) must adhere to the `dx.bi` design tokens:
  - Background canvas: `#0b0b0d`
  - Raised background / cards: `#131317` / `#18181d` / `#212128`
  - Hairline borders: `1px solid rgba(255, 255, 255, 0.08)` (hover: `0.16`)
  - Primary accent: `#e50914` (Cinema Red) with support for the 8 theme swatches (`red`, `crimson`, `blue`, `purple`, `green`, `amber`, `pink`, `white`).
  - Typography: `Inter` (UI) and `Bebas Neue` (Cinema wordmark / titles).
  - Navigation: Underline tabs with `scaleX` bottom accent animation; avoid chunky boxed pill tracks.
  - Left-rail split layouts for settings and admin views (`.dx-split-layout`).

### Git Hygiene & Ignored Files
- The following paths are strictly ignored and must never be committed:
  - `extra/` (reference clones and benchmarks)
  - `dashboard/data/` (runtime access requests and user database)
  - `.env` and `*.env` files containing live credentials
- Always check `git status` to ensure no temporary files or test scratch files are staged.
