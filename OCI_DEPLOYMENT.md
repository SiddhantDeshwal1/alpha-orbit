# Oracle Linux 9 ARM64 Deployment Runbook (`OCI_DEPLOYMENT.md`)

Deploy **Alpha Prod Orbit** on an Oracle Cloud Infrastructure (OCI) Always Free **Ampere A1 (`aarch64` / ARM64)** VM running **Oracle Linux 9** with **6 GB RAM** using **100% rootless Podman Quadlets**, **automated GitOps sync (`alpha-orbit-git-sync`)**, and **automated registry updates (`podman-auto-update`)**.

> **Zero Public Port Exposure:** Only SSH (`22/tcp`) is reachable on the host NIC. All streaming and management endpoints bind strictly to `127.0.0.1` and are accessed exclusively over your private **Tailscale WireGuard mesh**.

---

## 1. Pre-Public Checklist (Before Making Repo & Package Public)

Because `alpha-orbit-git-sync.timer` pulls `origin/main` and `podman-auto-update.timer` pulls from GitHub Container Registry (`ghcr.io`) without storing personal tokens on the server, prepare your GitHub repository first:

1. **Rotate any personal `TMDB_API_KEY` (and scrub history if ever committed):**
   - `dashboard/server.js` reads `process.env.TMDB_API_KEY` from `.env`.
   - If a personal TMDb key, Tailscale key, or VPN secret was ever committed to an older commit, **rotate the key** in the TMDb dashboard and squash/clean git history before flipping repo visibility to Public.
2. **Verify no secrets are tracked in Git:**
   ```bash
   git status
   git ls-files | grep -E '\.env$|supervisor\.pid|config\.xml$' || echo "Clean"
   ```
3. **Make the GitHub Repository Public:**
   - GitHub Repo → **Settings → Danger Zone → Change repository visibility → Make public**.
4. **Trigger CI/CD & Make the GHCR Dashboard Package Public:**
   - Push to `main` (or trigger `.github/workflows/ci-cd.yml` via **Actions → CI/CD Pipeline → Run workflow**) so GitHub Actions builds and pushes the multi-arch (`linux/amd64`, `linux/arm64`) image to `ghcr.io/<your-github-username>/alpha-prod-dashboard:latest` and `:<short-sha>`.
   - Go to **GitHub Profile → Packages → `alpha-prod-dashboard` → Package settings → Danger Zone → Change visibility → Public**.

---

## 2. Oracle Linux 9 ARM64 Host Setup (6 GB RAM)

SSH into your Oracle Linux 9 ARM64 instance as your non-root deployment user (e.g., `opc`) and execute the following steps.

### 2.1 Install Required Host Packages

```bash
sudo dnf install -y podman git jq curl container-selinux
```

Verify Podman and Quadlet generator availability:

```bash
podman --version
/usr/libexec/podman/quadlet --version 2>/dev/null || /usr/lib/podman/quadlet --version
```

### 2.2 Enable User Lingering (Required for Rootless Quadlets at Boot)

Rootless `systemd --user` services terminate on SSH logout unless lingering is enabled:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

### 2.3 Enable Kernel `tun` Module & SELinux Device Access

Both **Tailscale** and **Gluetun** require `/dev/net/tun` inside rootless containers:

```bash
echo "tun" | sudo tee /etc/modules-load.d/tun.conf
sudo modprobe tun
ls -l /dev/net/tun

# Allow rootless Podman containers to access /dev/net/tun under OL9 SELinux Enforcing
sudo setsebool -P container_use_devices=on
```

### 2.4 Create an 8 GB Swap File (6 GB RAM Headroom)

ClamAV (~1.6 GB peak) plus Jellyfin and the download sandbox need swap headroom on a 6 GB RAM VM:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=8192 status=progress
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
swapon --show
```

### 2.5 Keep Host Firewall (`firewalld`) & OCI VCN Ports Closed

Do **not** open ports `3000`, `8096`, `5055`, `8081`, `7878`, `8989`, `9696`, `8000`, `8001`, `8003`, `8191`, or `8888` in either `firewalld` or your OCI VCN Security List / Network Security Group.

Verify `firewalld` only permits SSH (or Cockpit if standard OL9 default — optionally remove unused services):

```bash
sudo firewall-cmd --list-all
# Optional hardening: ensure only ssh is open
# sudo firewall-cmd --permanent --remove-service=cockpit 2>/dev/null || true
# sudo firewall-cmd --reload
```

---

## 3. Clone Repository, Apply Sysctl Profile & Configure `.env`

### 3.1 Clone to `/opt/alpha-orbit`

```bash
sudo mkdir -p /opt/alpha-orbit
sudo chown "$USER:$USER" /opt/alpha-orbit
git clone https://github.com/<your-github-username>/alpha-orbit.git /opt/alpha-orbit
cd /opt/alpha-orbit
```

### 3.2 Apply Network & Virtual Memory Kernel Tuning (`99-orbit-network.conf`)

```bash
sudo cp /opt/alpha-orbit/99-orbit-network.conf /etc/sysctl.d/99-orbit-network.conf
echo "tcp_bbr" | sudo tee /etc/modules-load.d/bbr.conf
sudo modprobe tcp_bbr
sudo sysctl --system
```

### 3.3 Create and Populate `.env`

```bash
cd /opt/alpha-orbit
cp .env.example .env
chmod 600 .env
```

Edit `.env` (`nano /opt/alpha-orbit/.env` or `vi /opt/alpha-orbit/.env`) and set the core OCI values:

```dotenv
# ------------------------------------------------------------------------------
# Storage Paths (OCI Boot Volume on '/' OR Block Volume at '/mnt/alpha')
# ------------------------------------------------------------------------------
# Option A: Storing data on the boot volume root filesystem (/):
SERVER_DATA_DIR=/opt/alpha-orbit/data
ALPHA_MOUNT_POINT=/opt/alpha-orbit

# Option B: If using an attached OCI Block Volume mounted at /mnt/alpha:
# SERVER_DATA_DIR=/mnt/alpha/alpha-orbit/data
# ALPHA_MOUNT_POINT=/mnt/alpha

# ------------------------------------------------------------------------------
# Container Images (lowercase GitHub owner required by GHCR)
# ------------------------------------------------------------------------------
GHCR_DASHBOARD_IMAGE=ghcr.io/<your-github-username>/alpha-prod-dashboard:latest
FLARESOLVERR_IMAGE=ghcr.io/flaresolverr/flaresolverr:latest

# ------------------------------------------------------------------------------
# Tailscale Mesh (Use a reusable/auth key from https://login.tailscale.com/admin/settings/keys)
# ------------------------------------------------------------------------------
TS_HOSTNAME=alpha-prod-orbit
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxxxxxxx
TS_USERSPACE=true

# ------------------------------------------------------------------------------
# Media & Security Keys
# ------------------------------------------------------------------------------
TMDB_API_KEY=<your-tmdb-v3-api-key>
# Generate with: python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
SWITCHER_API_KEY=<generated-48-char-secret>

# Gluetun VPN Profile (custom/WARP, protonvpn, windscribe, mullvad, airvpn)
GLUETUN_VPN_PROVIDER=custom
GLUETUN_VPN_TYPE=wireguard
WARP_PRIVATE_KEY=<your-wireguard-private-key>
```

> **Note on Service API Keys:** After first boot, retrieve and add `SEERR_API_KEY`, `JELLYFIN_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`, and `PROWLARR_API_KEY` to `.env`, then run `./quadlets/install-quadlets.sh --sync` and `./restart.sh`.

---

## 4. One-Command Bootstrap (`install-quadlets.sh`)

Run the Quadlet installer from `/opt/alpha-orbit`:

```bash
cd /opt/alpha-orbit
./quadlets/install-quadlets.sh
```

What this single command executes automatically:

1. Verifies storage paths, initializes runtime directories (`data/`, `/var/tmp/jellyfin-cache`), and harmonizes rootless UID/GID permissions (`podman unshare`).
2. Generates `~/.config/containers/systemd/alpha-orbit-mapped.env` (`0600`) for Gluetun VPN env mapping.
3. Renders all `.container`, `.network`, `.service`, `.timer`, and drop-in templates into `~/.config/containers/systemd/` and `~/.config/systemd/user/`.
4. Enables and starts `podman.socket`, `podman-auto-update.timer` (every 2 min with `podman image prune -f`), `alpha-orbit-git-sync.timer` (every 2 min), and `alpha-orbit-supervisor.service`.
5. Starts all Core Quadlet containers (`alpha-prod-tailscale`, `alpha-prod-gluetun`, `alpha-prod-dashboard`, `alpha-prod-flaresolverr`, `alpha-prod-jellyfin`, `alpha-prod-seerr`).

Verify Tailscale mesh registration and obtain your private Tailnet IP:

```bash
podman exec alpha-prod-tailscale tailscale status
podman exec alpha-prod-tailscale tailscale ip -4
```

Access your stack from any device on your Tailnet (replace `<TAILSCALE_IP>`):

- **Mission Control Cockpit:** `http://<TAILSCALE_IP>:3000`
- **Jellyfin Cinema:** `http://<TAILSCALE_IP>:8096`
- **Seerr Discovery:** `http://<TAILSCALE_IP>:5055`

### Day-2 Lifecycle Scripts (Quadlet-Aware)

Once Quadlets are installed (`~/.config/containers/systemd/alpha-prod-tailscale.container` exists), the repository lifecycle scripts automatically operate in `QUADLET_MODE`:

```bash
./start.sh                 # Reloads user units, starts Core Quadlets + Gluetun/FlareSolverr + Supervisor
./stop.sh                  # Stops Supervisor, Sandbox Quadlets, and Core Quadlets (prevents auto-restart)
./restart.sh               # Graceful stop -> 2s cooldown -> start -> status table
./restart.sh --with-sandbox  # Full bounce + immediately wakes all Sandbox ingestion Quadlets
```

---

## 5. Monitoring Logs, Timers, Rollbacks & ARM64 Notes

### 5.1 Check Service & Timer Status

```bash
# All user services (Core, Sandbox, Supervisor, Git-Sync, Auto-Update)
systemctl --user status \
  alpha-prod-tailscale \
  alpha-prod-dashboard \
  alpha-prod-jellyfin \
  alpha-prod-seerr \
  alpha-prod-gluetun \
  alpha-orbit-supervisor

# Verify timers (alpha-orbit-git-sync.timer & podman-auto-update.timer)
systemctl --user list-timers --all

# Quick container overview
podman ps -a --filter "name=alpha-prod-"
```

### 5.2 Follow Live Logs (`journalctl`)

```bash
# Watch automatic container image updates & pruning
journalctl --user -u podman-auto-update -f

# Watch automatic GitOps pulls & selective service restarts
journalctl --user -u alpha-orbit-git-sync -f

# Watch on-demand sandbox supervisor state machine
journalctl --user -u alpha-orbit-supervisor -f

# Watch dashboard & Jellyfin logs
journalctl --user -u alpha-prod-dashboard -u alpha-prod-jellyfin -f
```

### 5.3 Rollbacks with Immutable `:<sha>` Tags

Every push to `main` publishes both `:latest` and an immutable commit SHA tag `:<short-sha>` (7-character commit SHA) via `.github/workflows/ci-cd.yml`. To roll back the Cockpit Dashboard to a known-good commit:

1. Find the commit SHA (e.g., via `git log -n 10 --oneline` or GitHub Packages tags).
2. Pin the tag in `/opt/alpha-orbit/.env`:
   ```dotenv
   GHCR_DASHBOARD_IMAGE=ghcr.io/<your-github-username>/alpha-prod-dashboard:<short-sha>
   ```
3. Re-render Quadlets without disrupting other services and restart the dashboard:
   ```bash
   cd /opt/alpha-orbit
   ./quadlets/install-quadlets.sh --sync
   systemctl --user restart alpha-prod-dashboard.service
   ```
4. Because `:<short-sha>` is an immutable tag, `podman-auto-update` will keep this pinned build running until you switch `GHCR_DASHBOARD_IMAGE` back to `:latest` and re-run `--sync`.

### 5.4 FlareSolverr ARM64 Fallback Note

The default `FLARESOLVERR_IMAGE=ghcr.io/flaresolverr/flaresolverr:latest` publishes `linux/arm64` images, which Prowlarr uses on `172.31.0.19:8191` only for Cloudflare-gated torrent indexers. If headless Chromium inside the upstream FlareSolverr image fails or stalls on Oracle Linux 9 ARM64:

- **Option A — Switch to the community `nodriver` ARM64 build:**
  Set in `/opt/alpha-orbit/.env`:
  ```dotenv
  FLARESOLVERR_IMAGE=docker.io/21hsmw/flaresolverr:nodriver
  ```
  Then apply:
  ```bash
  cd /opt/alpha-orbit
  ./quadlets/install-quadlets.sh --sync
  systemctl --user restart alpha-prod-flaresolverr.service
  ```
- **Option B — Run without FlareSolverr:**
  If your Prowlarr indexers do not require Cloudflare solving, disable the unit cleanly:
  ```bash
  systemctl --user stop alpha-prod-flaresolverr.service
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/alpha-prod-flaresolverr.container"
  systemctl --user daemon-reload
  ```
  Both `./start.sh` and `./sandbox/start_sandbox.sh` automatically detect when `alpha-prod-flaresolverr.container` is absent and continue startup without error.
