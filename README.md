# Orbit

A self-hosted, private media streaming server with automated request handling, download processing, and secure remote streaming over a private encrypted mesh network.

---

## Overview

Orbit is a personal media server system designed to manage your media library end-to-end. It integrates media playback, discovery, automated downloading, and secure remote access into a unified platform running in lightweight, rootless containers.

### Core Capabilities

* **Media Streaming**: Centralized media library streaming video and music to phones, tablets, desktop browsers, and smart TVs.
* **Automated Requests**: Web-based discovery interface where users can search for movies or series and submit requests with one click.
* **Automated Retrieval & Ingestion**: Matches requests against configured release indexers, downloads files through an isolated VPN tunnel, validates file containers, and automatically moves media into the streaming library.
* **On-Demand Resource Management**: Ingestion and download containers run only when active downloads or requests are present. When work finishes, the sandbox stack spins down to conserve host CPU and memory.
* **Private Remote Access**: Connects to your server securely from anywhere through a private WireGuard (Tailscale) mesh with zero open ports on your home or cloud firewall.

---

## Tech Stack & Architecture

### Core Services

| Service | Technology | Role |
| :--- | :--- | :--- |
| **Media Server** | Jellyfin | Media library indexing, metadata resolution, multi-client streaming, and hardware transcoding. |
| **Discovery & Requests** | Seerr (Jellyseerr) | Web portal for exploring titles, browsing trailers, and requesting media. |
| **Mission Control** | Node.js (Vanilla) | Zero-dependency dashboard for system telemetry, container status, and service controls. |
| **Remote Mesh Access** | Tailscale (WireGuard) | Zero-trust private mesh networking; exposes services privately without port forwarding. |
| **Orchestration** | Podman Quadlets & systemd | Declarative rootless container units managed natively via systemd user services. |

### Ingestion & Sandbox Services

All download activities are isolated within a dedicated network namespace routing through a secure VPN gateway:

| Service | Technology | Role |
| :--- | :--- | :--- |
| **VPN Gateway** | Gluetun | WireGuard / OpenVPN client routing all download traffic through an encrypted tunnel. |
| **Download Client** | qBittorrent | BitTorrent client network-bound strictly to the Gluetun VPN container interface. |
| **Media Automation** | Radarr & Sonarr | Automated release monitoring, quality profile selection, and season/movie tracking. |
| **Indexer Proxy** | Prowlarr | Centralized indexer management and proxying for Radarr and Sonarr. |
| **File Sanitization** | Gatekeeper & ClamAV | Inspects media files, normalizes audio streams, extracts subtitles, and scans for threats before library ingestion. |
| **Lifecycle Daemon** | Sandbox Supervisor | Background state machine monitoring request queues to start/stop the download sandbox on demand. |

---

## Repository Structure

```text
alpha-orbit/
├── .env.example                    # Template for environment configuration variables
├── .gitignore                      # Git ignore rules (protects credentials and data)
├── compose.yaml                    # Standalone Compose definition for core services
├── compose.sandbox.yaml            # Standalone Compose definition for download sandbox
├── docs/                           # Architecture specifications and deployment runbooks
│   ├── ARCHITECTURE.md             # Detailed system architecture, data flow, and specifications
│   ├── OCI_DEPLOYMENT.md           # Production deployment guide for Oracle Cloud (ARM64)
│   └── assets/                     # Documentation diagrams and visual references
├── scripts/                        # Operational lifecycle and system tuning scripts
│   ├── start.sh                    # Core service startup and prerequisite validation
│   ├── stop.sh                     # Graceful teardown and storage synchronization
│   ├── restart.sh                  # Graceful bounce with optional sandbox wake flag
│   └── 99-orbit-network.conf       # Linux kernel network and socket buffer tuning profile
├── quadlets/                       # Production Rootless Podman Quadlet definitions
│   ├── core/                       # Core service Quadlets (Tailscale, Dashboard, Jellyfin, Seerr)
│   ├── sandbox/                    # Ingestion pipeline Quadlets (Gluetun, qBit, *Arrs, Gatekeeper)
│   ├── networks/                   # Netavark container network definitions
│   ├── systemd/                    # Supervisor daemon service and automated Git-sync timer
│   ├── install-quadlets.sh         # Quadlet generator and compiler
│   └── sync-host.sh                # Automated upstream synchronization script
├── dashboard/                      # Mission Control web dashboard source code and Dockerfile
├── jellyfin/                       # Client web modifications, plugins, and custom UI scripts
├── sandbox/                        # Ingestion daemon scripts, rules, and supervisor logic
└── seerr/                          # Seerr service configuration and initialization files
```

---

## Quickstart

### 1. Prerequisites

* Linux system (x86_64 or ARM64) with systemd
* Podman 4.4+ and `podman-compose`
* Active Tailscale account (for remote access)

### 2. Configuration

```bash
# Clone the repository
git clone https://github.com/<your-username>/alpha-orbit.git
cd alpha-orbit

# Create environment file from template
cp .env.example .env
chmod 600 .env

# Edit .env with your credentials and storage paths
nano .env
```

### 3. Apply Kernel Tuning (Recommended)

```bash
sudo cp scripts/99-orbit-network.conf /etc/sysctl.d/99-orbit-network.conf
echo "tcp_bbr" | sudo tee /etc/modules-load.d/bbr.conf
sudo modprobe tcp_bbr
sudo sysctl --system
```

### 4. Deploy Services

#### Option A: Rootless Podman Quadlets (Recommended for Production)

```bash
# Compile and install Quadlets to ~/.config/containers/systemd
./quadlets/install-quadlets.sh --sync
```

#### Option B: Standalone Lifecycle Scripts

```bash
# Start core services and supervisor
./scripts/start.sh

# Stop all services cleanly
./scripts/stop.sh

# Graceful restart
./scripts/restart.sh
```

---

## Service Endpoints

Once running, services bind to localhost and your private Tailscale mesh IP:

| Interface | Port | Local Endpoint | Remote (Tailscale) |
| :--- | :--- | :--- | :--- |
| **Mission Control Dashboard** | 3000 | `http://localhost:3000` | `http://<tailscale-ip>:3000` |
| **Jellyfin Streaming** | 8096 | `http://localhost:8096` | `http://<tailscale-ip>:8096` |
| **Seerr Request Portal** | 5055 | `http://localhost:5055` | `http://<tailscale-ip>:5055` |

---

## Operations & Lifecycle Management

| Operation | Command |
| :--- | :--- |
| **Start Core Stack** | `./scripts/start.sh` |
| **Stop All Services** | `./scripts/stop.sh` |
| **Restart Core Stack** | `./scripts/restart.sh` |
| **Restart Stack + Wake Sandbox** | `./scripts/restart.sh --with-sandbox` |
| **Sync Host Quadlets** | `./quadlets/install-quadlets.sh --sync` |
| **Trigger Upstream Git Sync** | `systemctl --user start alpha-orbit-git-sync.service` |
| **Check Active Containers** | `podman ps` |
| **View Supervisor Logs** | `journalctl --user -u alpha-orbit-supervisor.service -f` |

---

## Security

* **Rootless Containers**: All containers run inside unprivileged user namespaces.
* **No Open Firewall Ports**: Services communicate exclusively through localhost and the encrypted Tailscale WireGuard mesh.
* **Isolated Ingestion**: Download tools run inside an isolated network namespace attached to Gluetun VPN with no access to local LAN subnets.
* **Ingestion Sanitization**: Incoming files are validated and scanned for anomalies before being made available in the streaming library.
* **Secret Protection**: `.env` and application databases are excluded from version control.

---

## Documentation

* [System Architecture Specification](docs/ARCHITECTURE.md): Network diagrams, state machine design, storage caching tiers, and security controls.
* [Oracle Cloud Deployment Runbook](docs/OCI_DEPLOYMENT.md): Step-by-step instructions for deploying Orbit on Oracle Cloud Infrastructure (ARM64).

---

## License

Released under the [MIT License](LICENSE).
