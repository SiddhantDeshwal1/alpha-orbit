// Orbit Server Dashboard: Clean, High-Performance Frontend Engine
// Inspired by Homarr and CasaOS

(function () {
  'use strict';

  // --- Services Architecture & Local Icons ---
  const APP_CATALOG = [
    {
      category: 'Media & Streaming',
      items: [
        {
          id: 'jellyfin',
          name: 'Jellyfin Cinema',
          icon: '/icons/jellyfin.png',
          port: 8096,
          desc: 'Direct-Play cinema, movies, web series & anime.',
          container: 'alpha-prod-jellyfin'
        },
        {
          id: 'seerr',
          name: 'Seerr',
          icon: '/icons/seerr.png',
          port: 5055,
          desc: 'Automated media discovery & requests pipeline.',
          container: 'alpha-prod-seerr'
        }
      ]
    },
    {
      category: 'Download Pipeline (Sandbox)',
      items: [
        {
          id: 'qbittorrent',
          name: 'qBittorrent',
          icon: '/icons/qbittorrent.png',
          port: 8081,
          desc: 'Zero-upload download engine locked behind kill-switch.',
          container: 'alpha-prod-qbittorrent'
        },
        {
          id: 'radarr',
          name: 'Radarr',
          icon: '/icons/radarr.png',
          port: 7878,
          desc: 'Automated movie library tracker & downloader.',
          container: 'alpha-prod-radarr'
        },
        {
          id: 'sonarr',
          name: 'Sonarr',
          icon: '/icons/sonarr.png',
          port: 8989,
          desc: 'Automated TV show & web series tracker.',
          container: 'alpha-prod-sonarr'
        },
        {
          id: 'prowlarr',
          name: 'Prowlarr',
          icon: '/icons/prowlarr.png',
          port: 9696,
          desc: 'Centralized torrent indexer proxy for Radarr & Sonarr.',
          container: 'alpha-prod-prowlarr'
        }
      ]
    },
    {
      category: 'Network Gateway & Security',
      items: [
        {
          id: 'gluetun',
          name: 'Gluetun VPN',
          icon: '/icons/gluetun.png',
          port: 8000,
          desc: 'Encrypted WireGuard gateway with hardware kill-switch.',
          container: 'alpha-prod-gluetun'
        },
        {
          id: 'tailscale',
          name: 'Tailscale Mesh',
          icon: '/icons/tailscale.png',
          port: 3000,
          desc: 'Private WireGuard mesh network connecting laptop & phone.',
          container: 'alpha-prod-tailscale'
        }
      ]
    }
  ];

  // VPN Provider metadata with official brand logos
  const VPN_CATALOG = [
    {
      id: 'cloudflare',
      name: 'Cloudflare WARP',
      icon: '/icons/cloudflare.png',
      tier: 'FREE',
      desc: 'Anycast WireGuard · High throughput · Zero credentials required'
    },
    {
      id: 'protonvpn',
      name: 'ProtonVPN Free',
      icon: '/icons/protonvpn.png',
      tier: 'FREE',
      desc: 'Swiss jurisdiction · Strict no-logs policy · Unlimited free bandwidth'
    },
    {
      id: 'windscribe',
      name: 'Windscribe Free',
      icon: '/icons/windscribe.png',
      tier: 'FREE',
      desc: 'Canadian privacy provider · Native WireGuard tunnel'
    },
    {
      id: 'mullvad',
      name: 'Mullvad VPN',
      icon: '/icons/mullvad.png',
      tier: 'PAID',
      desc: 'Gold standard anonymity · Account number only, zero personal data'
    },
    {
      id: 'airvpn',
      name: 'AirVPN',
      icon: '/icons/airvpn.png',
      tier: 'PAID',
      desc: 'Hacktivist-founded · P2P optimized with forwarded ports support'
    }
  ];

  const VALID_TABS = ['apps', 'downloads', 'logs', 'vpn', 'metrics', 'requests'];
  const savedTab = localStorage.getItem('alpha_tab');
  const initialTab = VALID_TABS.includes(savedTab) ? savedTab : 'apps';

  // State
  const state = {
    activeTab: initialTab,
    pings: {},
    downloads: null,
    vpn: null,
    system: null,
    logSource: localStorage.getItem('alpha_log_source') || 'alpha-prod-seerr',
    logFilter: 'all',
    logSearch: '',
    logTail: 150,
    autoScroll: true,
    tailscaleIp:
      window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
        ? window.location.hostname
        : '127.0.0.1',
    metricsRange: localStorage.getItem('alpha_metrics_range') || '24h',
    metricsData: null,
    timerId: null,
    // Requests state
    requests: [],
    reqFilterStatus: 'all',
    reqFilterUser: 'all',
    reqFilterSearch: '',
    expandedDiagnoses: new Set(),
    expandedEpisodes: new Set(),
    requestSearchQuery: '',
    requestSearchResults: [],
    requestSelectedMedia: null,
    requestQualityTier: 'max',
    requestDiscoveredQualities: [],
    requestDiscoveryInProgress: false,
    orchestratorRequests: [],
    discoveryHistory: []
  };

  // Toast Notification
  function showToast(message, type = 'info') {
    const shelf = document.getElementById('toast-shelf');
    if (!shelf) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;
    if (type === 'error') toast.style.borderColor = 'var(--accent-rose)';
    if (type === 'success') toast.style.borderColor = 'var(--accent-emerald)';
    shelf.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // Format bytes helper
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Format speed helper
  function formatSpeed(bytesPerSec) {
    return formatBytes(bytesPerSec) + '/s';
  }

  // Copy URL with visual toast
  window.copyLink = function (e, url) {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard
      .writeText(url)
      .then(() => {
        showToast(`Copied to clipboard: ${url}`, 'success');
      })
      .catch(() => {
        showToast('Failed to copy', 'error');
      });
  };

  // Jump to Logs with container preselected
  window.openLogsFor = function (e, containerName) {
    e.stopPropagation();
    e.preventDefault();
    state.logSource = containerName;
    localStorage.setItem('alpha_log_source', containerName);
    const select = document.getElementById('select-log-target');
    if (select) select.value = containerName;
    switchView('logs');
    fetchLogs();
  };

  // 1-Click Container Restart via Podman socket
  window.restartService = async function (e, containerName) {
    e.stopPropagation();
    e.preventDefault();
    if (!confirm(`Restart container "${containerName}"?`)) return;
    showToast(`Restarting ${containerName}...`, 'info');
    try {
      const res = await fetch('/api/containers/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: containerName })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`${containerName} restarted successfully!`, 'success');
        setTimeout(fetchPings, 1500);
      } else {
        showToast(data.error || 'Failed to restart container', 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  // VPN Hot-Swap Profile Switch
  window.switchVpnTunnel = async function (profileId) {
    if (
      !confirm(
        `Switch active VPN tunnel to "${profileId}"? Running downloads will pause momentarily and resume via the new gateway.`
      )
    )
      return;
    showToast(`Switching VPN tunnel to ${profileId}...`, 'info');
    try {
      const res = await fetch('/api/vpn/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileId })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Switched to ${profileId}!`, 'success');
        setTimeout(fetchVpnStatus, 2000);
      } else {
        showToast(data.error || 'Failed to switch profile', 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  // Pause / Resume Torrent
  window.toggleTorrentState = async function (hash, action) {
    try {
      const res = await fetch('/api/downloads/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, hash })
      });
      if (res.ok) {
        showToast(`Torrent ${action}d!`, 'success');
        fetchDownloads();
      }
    } catch (_) {}
  };

  // ==============================================================================
  // 60FPS SPRING SEGMENTED NAV CONTROLLER
  // ==============================================================================
  function updateNavPill(tabId) {
    const nav = document.getElementById('main-nav');
    const indicator = document.getElementById('nav-pill-indicator');
    const targetBtn = nav?.querySelector(`.nav-tab-btn[data-tab="${tabId}"]`);
    if (!indicator || !targetBtn || !nav) return;

    const navRect = nav.getBoundingClientRect();
    const btnRect = targetBtn.getBoundingClientRect();
    const offsetLeft = btnRect.left - navRect.left;

    indicator.style.transform = `translateX(${offsetLeft}px)`;
    indicator.style.width = `${btnRect.width}px`;
  }

  window.switchView = function (tabId) {
    if (!VALID_TABS.includes(tabId)) tabId = 'apps';
    state.activeTab = tabId;
    localStorage.setItem('alpha_tab', tabId);

    document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    document.querySelectorAll('.tab-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === `tab-${tabId}`);
    });

    updateNavPill(tabId);

    if (tabId === 'logs') {
      fetchLogs();
    } else if (tabId === 'downloads') {
      fetchDownloads();
    } else if (tabId === 'vpn') {
      fetchVpnStatus();
    } else if (tabId === 'metrics' || tabId === 'apps') {
      fetchMetrics(true);
    } else if (tabId === 'requests') {
      fetchRequests(true);
    }
  };

  // ==============================================================================
  // API DATA SYNC
  // ==============================================================================

  // 1. System Telemetry & Storage
  async function fetchSystem() {
    try {
      const res = await fetch('/api/system');
      if (!res.ok) return;
      const data = await res.json();
      state.system = data;

      if (data.disk && data.disk.totalBytes > 0) {
        const freeGB = Math.round(data.disk.freeBytes / 1024 ** 3);
        const totalGB = Math.round(data.disk.totalBytes / 1024 ** 3);
        const freeEl = document.getElementById('val-storage-free');
        const fillEl = document.getElementById('val-storage-fill');
        if (freeEl) freeEl.textContent = `${freeGB} GB Free / ${totalGB} GB`;
        if (fillEl) fillEl.style.width = `${data.disk.percentUsed}%`;
      }
    } catch (_) {}
  }

  // 2. Latency Pings
  async function fetchPings() {
    try {
      const res = await fetch('/api/pings');
      if (!res.ok) return;
      const data = await res.json();
      const pingsMap = {};
      (data.services || []).forEach((s) => {
        pingsMap[s.id] = s;
      });
      state.pings = pingsMap;
      updatePingsUI();
    } catch (_) {}
  }

  // 3. Downloads & Speed
  async function fetchDownloads() {
    try {
      const res = await fetch('/api/downloads');
      if (!res.ok) return;
      const data = await res.json();
      state.downloads = data;

      // Bandwidth row
      const dlRate = document.getElementById('dl-rate-val');
      const upRate = document.getElementById('up-rate-val');
      const dlSession = document.getElementById('dl-session-val');
      const guard = document.getElementById('tunnel-guard-val');
      const badgeDl = document.getElementById('badge-dl');

      if (data.transfer) {
        if (dlRate) dlRate.textContent = formatSpeed(data.transfer.downloadSpeed);
        if (upRate) upRate.textContent = formatSpeed(data.transfer.uploadSpeed);
        if (dlSession)
          dlSession.textContent = `Session: ${formatBytes(data.transfer.totalDownloaded)}`;
        if (guard)
          guard.textContent =
            data.transfer.connectionStatus === 'connected' ? 'Protected' : 'Firewalled';
      }

      const torrentsCount = (data.torrents || []).length;
      if (badgeDl) {
        badgeDl.textContent = torrentsCount;
        badgeDl.style.display = torrentsCount > 0 ? 'inline-block' : 'none';
      }

      renderTorrents(data.torrents || []);
      renderSeerrQueue(data.seerrRequests || []);
    } catch (_) {}
  }

  // 4. VPN Egress Status
  async function fetchVpnStatus() {
    try {
      const res = await fetch('/api/vpn/status');
      if (!res.ok) return;
      const data = await res.json();
      state.vpn = data;

      const vpnActive = document.getElementById('val-vpn-active');
      if (vpnActive) vpnActive.textContent = data.display_name || data.active_profile;

      const actTitle = document.getElementById('active-vpn-title');
      const actDesc = document.getElementById('active-vpn-desc');
      const actIp = document.getElementById('active-vpn-ip');
      const actCountry = document.getElementById('active-vpn-country');
      const tunnelSub = document.getElementById('tunnel-ip-sub');

      if (actTitle) actTitle.textContent = data.display_name || data.active_profile;
      if (actDesc)
        actDesc.textContent = `${data.description} · ${data.organization || 'VPN Gateway'}`;
      if (actIp) actIp.textContent = data.public_ip;
      if (actCountry)
        actCountry.textContent = `${data.ip_country} (${data.tier?.toUpperCase() || 'FREE'})`;
      if (tunnelSub)
        tunnelSub.textContent = `Egress: ${data.public_ip} (${data.display_name || data.active_profile})`;

      renderVpnCards(data.active_profile);
    } catch (_) {}
  }

  // 5. Container Error Logs Stream
  async function fetchLogs() {
    const source = state.logSource;
    const isFile = source.startsWith('file:');
    const container = isFile ? source.replace(/^file:/, '') : source;
    const tail = state.logTail;
    const filter = state.logFilter;

    const screen = document.getElementById('terminal-screen');
    if (!screen) return;

    try {
      const url = `/api/logs/stream?container=${encodeURIComponent(container)}&tail=${tail}&filter=${filter}&type=${isFile ? 'file' : 'container'}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      let lines = data.lines || [];
      if (state.logSearch) {
        const query = state.logSearch.toLowerCase();
        lines = lines.filter((l) => l.text.toLowerCase().includes(query));
      }

      const errBadge = document.getElementById('badge-err');
      const errCount = lines.filter((l) => l.level === 'error').length;
      if (errBadge) {
        errBadge.textContent = errCount;
        errBadge.style.display = errCount > 0 ? 'inline-block' : 'none';
      }

      if (lines.length === 0) {
        screen.innerHTML = `
          <div style="color: var(--text-muted); text-align: center; padding: 48px;">
            No log entries found for filter [${filter.toUpperCase()}].
          </div>
        `;
        return;
      }

      let html = '';
      lines.forEach((l) => {
        const isErr = l.level === 'error';
        const isWrn = l.level === 'warn';
        const rowClass = isErr ? 'row-error' : '';
        const badgeClass = isErr ? 'badge-err' : isWrn ? 'badge-wrn' : 'badge-inf';

        html += `
          <div class="terminal-row ${rowClass}">
            <span class="terminal-badge ${badgeClass}">${l.level}</span>
            <span style="color: ${isErr ? '#fda4af' : '#d4d4d8'}; word-break: break-all; white-space: pre-wrap;">${escapeHtml(l.text)}</span>
          </div>
        `;
      });

      // Skip DOM update if content hasn't changed
      const lastLine = lines.length > 0 ? lines[lines.length - 1].text : '';
      const logsFingerprint = `${container}_${tail}_${filter}_${lines.length}_${lastLine}_${state.logSearch}`;
      if (logsFingerprint === state.lastLogsFingerprint) {
        return;
      }
      state.lastLogsFingerprint = logsFingerprint;

      screen.innerHTML = html;
      if (state.autoScroll) {
        screen.scrollTop = screen.scrollHeight;
      }
    } catch (err) {
      screen.innerHTML = `
        <div style="color: var(--accent-rose); text-align: center; padding: 32px;">
          Failed to stream logs: ${err.message}
        </div>
      `;
    }
  }

  // Populate Log Sources Dropdown
  async function loadLogSources() {
    try {
      const res = await fetch('/api/logs/sources');
      if (!res.ok) return;
      const data = await res.json();
      const select = document.getElementById('select-log-target');
      if (!select) return;

      let html = '';
      if (data.containers && data.containers.length > 0) {
        html += '<optgroup label="Server Containers">';
        data.containers.forEach((c) => {
          html += `<option value="${c}">${c}</option>`;
        });
        html += '</optgroup>';
      }

      if (data.fileLogs && data.fileLogs.length > 0) {
        html += '<optgroup label="System Daemon Logs">';
        data.fileLogs.forEach((f) => {
          html += `<option value="file:${f}">${f}</option>`;
        });
        html += '</optgroup>';
      }

      select.innerHTML = html;
      if (state.logSource && select.querySelector(`option[value="${state.logSource}"]`)) {
        select.value = state.logSource;
      } else {
        state.logSource = select.value || 'alpha-prod-seerr';
      }
    } catch (_) {}
  }

  // ==============================================================================
  // RENDERING COMPONENTS
  // ==============================================================================

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // In-place latency updates without destroying or re-animating cards
  function updatePingsUI() {
    APP_CATALOG.forEach((cat) => {
      cat.items.forEach((item) => {
        const ping = state.pings[item.id];
        if (!ping) return;
        const pingEl = document.getElementById(`ping-${item.id}`);
        if (pingEl) {
          const isOnline = ping.status === 'healthy';
          const latencyText = ping.latencyMs !== null ? `${ping.latencyMs}ms` : 'Offline';
          const newText = isOnline ? `Online · ${latencyText}` : 'Unreachable';
          if (pingEl.textContent !== newText) {
            pingEl.textContent = newText;
          }
          const dot = pingEl.previousElementSibling;
          if (dot) {
            const targetClass = isOnline ? 'dot-status-healthy' : 'dot-status-down';
            if (dot.className !== targetClass) {
              dot.className = targetClass;
            }
          }
        }
      });
    });
  }

  // Render the Clean App Grid (Homarr / CasaOS style)
  function renderAppGrid() {
    const container = document.getElementById('apps-container');
    if (!container) return;

    // If pre-rendered HTML cards exist, do NOT wipe out DOM! Just update pings in place!
    if (container.children.length > 0) {
      updatePingsUI();
      return;
    }

    let html = '';
    APP_CATALOG.forEach((cat) => {
      html += `
        <div class="section-category">
          <div class="section-category-title">${cat.category}</div>
          <div class="app-grid">
      `;

      cat.items.forEach((item) => {
        const ping = state.pings[item.id];
        const isOnline = ping && ping.status === 'healthy';
        const latencyText = ping && ping.latencyMs !== null ? `${ping.latencyMs}ms` : 'Checking';
        const dotClass = isOnline ? 'dot-status-healthy' : 'dot-status-down';

        const openUrl = item.path
          ? `http://localhost:${item.port}${item.path}`
          : `http://localhost:${item.port}`;
        const tsUrl = item.path
          ? `http://${state.tailscaleIp}:${item.port}${item.path}`
          : `http://${state.tailscaleIp}:${item.port}`;

        html += `
          <div class="app-card" onclick="window.open('${openUrl}', '_blank')">
            <div class="app-card-top">
              <div class="app-icon-wrap">
                <img class="app-icon-img" src="${item.icon}" alt="${item.name}" loading="lazy" onerror="this.style.display='none'">
              </div>
              <div class="app-details">
                <div class="app-name">${item.name}</div>
                <div class="app-desc">${item.desc}</div>
              </div>
            </div>

            <div class="app-card-bottom">
              <div class="latency-indicator">
                <span class="${dotClass}"></span>
                <span id="ping-${item.id}">${isOnline ? `Online · ${latencyText}` : 'Checking'}</span>
              </div>

              <div class="app-actions">
                <button class="btn-card-action" onclick="copyLink(event, '${tsUrl}')" title="Copy Mobile Tailscale Link (${tsUrl})">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><path d="M12 18h.01"/></svg>
                </button>
                <button class="btn-card-action" onclick="openLogsFor(event, '${item.container}')" title="Inspect Container Logs">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                </button>
                <button class="btn-card-action" onclick="restartService(event, '${item.container}')" title="1-Click Restart Container">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
              </div>
            </div>
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // Render Downloads
  function renderTorrents(torrents) {
    const json = JSON.stringify(torrents);
    if (json === state.lastTorrentsJson) return;
    state.lastTorrentsJson = json;

    const container = document.getElementById('torrent-items-container');
    if (!container) return;

    if (torrents.length === 0) {
      container.innerHTML = `
        <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 36px; text-align: center; color: var(--text-muted);">
          <div style="font-size: 0.95rem; font-weight: 600; color: #fff;">Download Engine Idle</div>
          <div style="font-size: 0.8rem; margin-top: 4px;">Zero active downloads. Autonomous sandbox pipeline is sleeping to conserve resources.</div>
        </div>
      `;
      return;
    }

    let html = '';
    torrents.forEach((t) => {
      const isPaused = t.state.includes('paused');
      html += `
        <div class="torrent-item">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div style="font-size: 0.92rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${escapeHtml(t.name)}
            </div>
            <span style="font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: var(--accent-sky); font-weight: 700; text-transform: uppercase;">
              ${t.category}
            </span>
          </div>

          <div class="torrent-bar-track">
            <div class="torrent-bar-fill" style="width: ${t.progress}%;"></div>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.78rem; font-family: var(--font-mono); color: var(--text-muted); flex-wrap: wrap; gap: 8px;">
            <div>${t.progress}% · ${formatBytes((t.size * t.progress) / 100)} / ${formatBytes(t.size)}</div>
            <div>↓ ${formatSpeed(t.dlspeed)} · Seeds: ${t.num_seeds} (${t.num_leechs})</div>
            <div>ETA: ${t.eta > 0 && t.eta < 864000 ? Math.round(t.eta / 60) + 'm' : '—'}</div>
            <div>
              <button class="btn-card-action" style="width: auto; padding: 2px 8px; font-size: 0.75rem;" onclick="toggleTorrentState('${t.hash}', '${isPaused ? 'resume' : 'pause'}')">
                ${isPaused ? 'Resume' : 'Pause'}
              </button>
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // Render Seerr Requests
  function renderSeerrQueue(requests) {
    const json = JSON.stringify(requests);
    if (json === state.lastSeerrJson) return;
    state.lastSeerrJson = json;

    const container = document.getElementById('seerr-items-container');
    if (!container) return;

    if (requests.length === 0) {
      container.innerHTML =
        '<div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">No pending media requests in queue.</div>';
      return;
    }

    let html = '';
    requests.forEach((r) => {
      const isDone = r.status === 5;
      const statusLabel = isDone ? 'Available' : r.status === 4 ? 'Downloading' : 'Processing';
      const statusColor = isDone ? 'var(--accent-emerald)' : 'var(--accent-sky)';

      html += `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 10px; margin-bottom: 8px; font-size: 0.85rem;">
          <div>
            <strong style="color: #fff;">Request #${r.id} (${r.type})</strong>
            <span style="font-size: 0.75rem; color: var(--text-muted); margin-left: 8px;">by ${escapeHtml(r.requestedBy)}</span>
          </div>
          <div style="font-size: 0.78rem; font-weight: 700; color: ${statusColor};">
            ${statusLabel}
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // Render VPN Profile Cards with Official Brand Logos
  function renderVpnCards(activeProfile) {
    const grid = document.getElementById('vpn-cards-grid');
    if (!grid) return;
    if (grid.children.length > 0 && state.lastVpnProfile === activeProfile) {
      return; // Already rendered and active tunnel hasn't changed
    }
    state.lastVpnProfile = activeProfile;

    let html = '';
    VPN_CATALOG.forEach((p) => {
      const isCurrent = p.id === activeProfile;
      html += `
        <div class="vpn-profile-card ${isCurrent ? 'active-tunnel' : ''}">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <img src="${p.icon}" style="width: 28px; height: 28px; object-fit: contain; border-radius: 6px;" alt="${p.name}">
                <div style="font-size: 1.05rem; font-weight: 600; color: #fff;">${p.name}</div>
              </div>
              <span style="font-size: 0.68rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.08);">
                ${p.tier}
              </span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
              ${p.desc}
            </div>
          </div>

          <div>
            <button class="btn-vpn-action ${isCurrent ? 'current' : ''}" onclick="${isCurrent ? '' : `switchVpnTunnel('${p.id}')`}">
              ${isCurrent ? '✓ Active Gateway' : 'Switch Tunnel →'}
            </button>
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;
  }

  // ==============================================================================
  // EVENT LISTENERS & INITIALIZATION
  // ==============================================================================
  function setupEventListeners() {
    // Nav tabs
    document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.tab));
    });

    // Window resize updates segmented pill position
    window.addEventListener('resize', () => updateNavPill(state.activeTab));

    // Manual refresh button
    const refreshBtn = document.getElementById('btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('animate-spin');
        Promise.all([fetchSystem(), fetchPings(), fetchDownloads(), fetchVpnStatus()]).then(() => {
          setTimeout(() => refreshBtn.classList.remove('animate-spin'), 600);
        });
      });
    }

    // Log target selector
    const logSelect = document.getElementById('select-log-target');
    if (logSelect) {
      logSelect.addEventListener('change', (e) => {
        state.logSource = e.target.value;
        localStorage.setItem('alpha_log_source', state.logSource);
        fetchLogs();
      });
    }

    // Log filter buttons
    document.querySelectorAll('.filter-btn[data-log-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('.filter-btn[data-log-filter]')
          .forEach((b) => b.classList.remove('active', 'active-error'));
        state.logFilter = btn.dataset.logFilter;
        if (state.logFilter === 'error') {
          btn.classList.add('active-error');
        } else {
          btn.classList.add('active');
        }
        fetchLogs();
      });
    });

    // Log tail count
    const tailSelect = document.getElementById('select-log-count');
    if (tailSelect) {
      tailSelect.addEventListener('change', (e) => {
        state.logTail = parseInt(e.target.value, 10);
        fetchLogs();
      });
    }

    // Log search filter
    const searchBox = document.getElementById('log-search-box');
    if (searchBox) {
      searchBox.addEventListener('input', (e) => {
        state.logSearch = e.target.value;
        fetchLogs();
      });
    }

    // Auto-scroll toggle
    const scrollBtn = document.getElementById('btn-autoscroll');
    if (scrollBtn) {
      scrollBtn.addEventListener('click', () => {
        state.autoScroll = !state.autoScroll;
        scrollBtn.textContent = `Scroll: ${state.autoScroll ? 'ON' : 'OFF'}`;
        scrollBtn.style.color = state.autoScroll ? '#fff' : 'var(--text-muted)';
      });
    }

    // Copy logs button
    const copyLogBtn = document.getElementById('btn-copy-log');
    if (copyLogBtn) {
      copyLogBtn.addEventListener('click', () => {
        const text = document.getElementById('terminal-screen')?.innerText || '';
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            showToast('Logs copied to clipboard', 'success');
          });
        }
      });
    }

    // Reload log button
    const reloadLogBtn = document.getElementById('btn-reload-log');
    if (reloadLogBtn) {
      reloadLogBtn.addEventListener('click', fetchLogs);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === '1') switchView('apps');
      else if (e.key === '2') switchView('downloads');
      else if (e.key === '3') switchView('logs');
      else if (e.key === '4') switchView('vpn');
      else if (e.key === 'r' || e.key === 'R') {
        fetchSystem();
        fetchPings();
        fetchDownloads();
        fetchVpnStatus();
      } else if (e.key === '/') {
        e.preventDefault();
        switchView('logs');
        document.getElementById('log-search-box')?.focus();
      }
    });

    setupRequestsToolbar();
  }

  // ==============================================================================
  // METRICS & OBSERVABILITY ENGINE (ZERO CPU/GPU OVERLOAD, OLED BLACK)
  // ==============================================================================
  window.setMetricsRange = function (range) {
    state.metricsRange = range;
    localStorage.setItem('alpha_metrics_range', range);
    document.querySelectorAll('.metrics-range-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === range);
    });
    fetchMetrics(true);
  };

  async function fetchMetrics(force = false) {
    // Zero CPU/GPU Dormancy: Suspend polling if browser tab is hidden or user is viewing another tab
    if (
      document.hidden ||
      (!force && state.activeTab !== 'metrics' && state.activeTab !== 'apps')
    ) {
      return;
    }

    try {
      const res = await fetch(
        `/api/metrics/history?range=${encodeURIComponent(state.metricsRange)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      state.metricsData = data;

      function setElText(id, text, color) {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = text;
          if (color) el.style.color = color;
        }
      }

      const peakDlStr = formatSpeed(data.summary?.peakDlSpeed || 0);
      const curDlStr = formatSpeed(data.summary?.current?.dl || 0);
      const peakStreamsStr = `${data.summary?.peakStreams || 0} Streams`;
      const curStreamsStr = `${data.summary?.current?.streams || 0} Active`;
      const avgLatStr = `${data.summary?.avgLatency || 12} ms`;
      const uptimeStr = `${data.summary?.uptimePercent || 100}%`;
      const freeStorageStr = `${data.summary?.current?.freeGB || 461} GB Free`;

      // Update Toolbar Summary Strip (both Home and Metrics views)
      setElText('stat-peak-dl', peakDlStr);
      setElText('home-stat-peak-dl', peakDlStr);

      setElText('stat-peak-streams', peakStreamsStr);
      setElText('home-stat-peak-streams', peakStreamsStr);

      setElText('stat-avg-latency', avgLatStr);
      setElText('home-stat-avg-latency', avgLatStr);

      setElText('stat-uptime', uptimeStr);
      setElText('home-stat-uptime', uptimeStr);

      setElText('stat-alpha-storage', freeStorageStr);

      // Update Individual Graph Badges (both views)
      setElText('badge-peak-dl', `PEAK: ${peakDlStr}`);
      setElText('home-badge-peak-dl', `PEAK: ${peakDlStr}`);
      setElText('badge-cur-dl', `LIVE: ${curDlStr}`);
      setElText('home-badge-cur-dl', `LIVE: ${curDlStr}`);

      setElText('badge-peak-streams', `PEAK: ${data.summary?.peakStreams || 0} STREAMS`);
      setElText('home-badge-peak-streams', `PEAK: ${data.summary?.peakStreams || 0} STREAMS`);
      setElText('badge-cur-streams', `NOW: ${data.summary?.current?.streams || 0} ACTIVE`);
      setElText('home-badge-cur-streams', `NOW: ${data.summary?.current?.streams || 0} ACTIVE`);

      const outageCount = data.summary?.downtimeCount || 0;
      const outageText = outageCount === 0 ? '0 INCIDENTS' : `${outageCount} OUTAGES`;
      const outageColor = outageCount === 0 ? '#10b981' : '#ef4444';
      setElText('badge-outages', outageText, outageColor);
      setElText('home-badge-outages', outageText, outageColor);
      setElText('badge-cur-latency', `AVG: ${avgLatStr}`);
      setElText('home-badge-cur-lat', `AVG: ${avgLatStr}`);

      setElText('badge-active-torrents', `${data.summary?.current?.torrents || 0} ACTIVE`);
      setElText('home-badge-active-torrents', `${data.summary?.current?.torrents || 0} ACTIVE`);
      setElText('badge-cur-velocity', `RATE: ${curDlStr}`);
      setElText('home-badge-cur-vel', `RATE: ${curDlStr}`);

      setElText('badge-vpn-status', 'WIREGUARD UP');
      setElText('home-badge-vpn-status', 'WIREGUARD UP');
      setElText('badge-cur-vpn-ms', `EGRESS: ${data.summary?.current?.vpnLatency || 15} ms`);
      setElText('home-badge-cur-vpn', `EGRESS: ${data.summary?.current?.vpnLatency || 15} ms`);

      setElText('badge-storage-free', `${data.summary?.current?.freeGB || 461} GB FREE`);
      setElText('home-badge-storage-free', `${data.summary?.current?.freeGB || 461} GB FREE`);

      renderAllCharts(data);
    } catch (_) {}
  }

  function renderAllCharts(data) {
    if (!data || !data.points || data.points.length === 0) return;
    const pts = data.points;

    // Zero CPU Helper: Only draw onto canvases that are currently visible in the DOM
    function renderChartTo(ids, config) {
      ids.forEach((id) => {
        const canvas = document.getElementById(id);
        if (canvas && canvas.offsetParent !== null) {
          drawChart(canvas, config);
        }
      });
    }

    // 1. Bandwidth Throughput & Peak Speeds (Download Cyan, Upload Amber)
    renderChartTo(['canvas-bandwidth', 'canvas-home-bandwidth'], {
      points: pts,
      formatY: (v) => formatSpeed(v),
      defaultSpan: 1000000,
      series: [
        {
          label: 'Download Speed',
          color: '#06b6d4',
          fillColor: 'rgba(6, 182, 212, 0.22)',
          fill: true,
          showPeak: true,
          formatVal: (v) => formatSpeed(v),
          data: pts.map((p) => p.dl)
        },
        {
          label: 'Upload Speed',
          color: '#f59e0b',
          fill: false,
          showPeak: false,
          formatVal: (v) => formatSpeed(v),
          data: pts.map((p) => p.ul)
        }
      ]
    });

    // 2. Active Users & Concurrent Streams (Jellyfin Cinema)
    renderChartTo(['canvas-streams', 'canvas-home-streams'], {
      points: pts,
      minY: 0,
      defaultSpan: 3,
      formatY: (v) => `${Math.round(v)}`,
      series: [
        {
          label: 'Active Streams',
          color: '#8b5cf6',
          fillColor: 'rgba(139, 92, 246, 0.24)',
          fill: true,
          showPeak: true,
          formatVal: (v) => `${v} Streams`,
          data: pts.map((p) => p.streams)
        },
        {
          label: 'Active Users',
          color: '#c084fc',
          fill: false,
          showPeak: false,
          formatVal: (v) => `${v} Users`,
          data: pts.map((p) => p.users)
        }
      ]
    });

    // 3. Service Latency & Downtime Radar
    renderChartTo(['canvas-latency', 'canvas-home-latency'], {
      points: pts,
      minY: 0,
      defaultSpan: 30,
      formatY: (v) => `${Math.round(v)} ms`,
      outages: data.downtimeEvents || [],
      series: [
        {
          label: 'Avg Latency',
          color: '#10b981',
          fillColor: 'rgba(16, 185, 129, 0.2)',
          fill: true,
          showPeak: false,
          formatVal: (v) => `${v} ms`,
          data: pts.map((p) => p.latency)
        }
      ]
    });

    // 4. Download Pipeline Velocity & Queue
    renderChartTo(['canvas-pipeline', 'canvas-home-pipeline'], {
      points: pts,
      minY: 0,
      defaultSpan: 4,
      formatY: (v) => `${Math.round(v)}`,
      series: [
        {
          label: 'Active Torrents',
          color: '#3b82f6',
          fillColor: 'rgba(59, 130, 246, 0.22)',
          fill: true,
          showPeak: true,
          formatVal: (v) => `${v} Torrents`,
          data: pts.map((p) => p.torrents)
        }
      ]
    });

    // 5. VPN Gateway Latency & Stability
    renderChartTo(['canvas-vpn', 'canvas-home-vpn'], {
      points: pts,
      minY: 0,
      defaultSpan: 30,
      formatY: (v) => `${Math.round(v)} ms`,
      series: [
        {
          label: 'WireGuard Egress Latency',
          color: '#14b8a6',
          fillColor: 'rgba(20, 184, 166, 0.2)',
          fill: true,
          showPeak: false,
          formatVal: (v) => `${v} ms`,
          data: pts.map((p) => p.vpnLatency)
        }
      ]
    });

    // 6. Alpha Storage Trajectory & Growth
    const minFree = Math.min(...pts.map((p) => p.freeGB || 461));
    renderChartTo(['canvas-storage', 'canvas-home-storage'], {
      points: pts,
      minY: Math.max(0, Math.floor(minFree - 5)),
      defaultSpan: 15,
      formatY: (v) => `${Math.round(v)} GB`,
      series: [
        {
          label: 'Free Drive Space',
          color: '#6366f1',
          fillColor: 'rgba(99, 102, 241, 0.22)',
          fill: true,
          showPeak: false,
          formatVal: (v) => `${v} GB`,
          data: pts.map((p) => p.freeGB)
        }
      ]
    });
  }

  // Generic High-DPI 2D Canvas Chart Renderer (Dormant when static, 0.0% CPU/GPU)
  function drawChart(canvas, config) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padLeft = 56;
    const padRight = 16;
    const padTop = 20;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx.clearRect(0, 0, w, h);

    const { points, series, formatY } = config;
    if (!points || points.length === 0) return;

    // Calculate Y range
    let minY = config.minY !== undefined ? config.minY : Infinity;
    let maxY = -Infinity;

    series.forEach((s) => {
      s.data.forEach((v) => {
        if (v > maxY) maxY = v;
        if (v < minY) minY = v;
      });
    });

    if (minY === Infinity) minY = 0;
    if (maxY === -Infinity || maxY === minY) maxY = minY + (config.defaultSpan || 10);
    if (config.minY === undefined && minY > 0) minY = 0;

    const span = maxY - minY || 1;
    maxY = maxY + span * 0.12; // 12% headroom

    // Subtle horizontal grid lines & Y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = '#71717a';
    ctx.font = '10px var(--font-mono, monospace)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const val = minY + (maxY - minY) * (i / steps);
      const yPos = padTop + plotH - plotH * (i / steps);

      ctx.beginPath();
      ctx.moveTo(padLeft, Math.round(yPos) + 0.5);
      ctx.lineTo(w - padRight, Math.round(yPos) + 0.5);
      ctx.stroke();

      const lbl = formatY ? formatY(val) : Math.round(val);
      ctx.fillText(lbl, padLeft - 8, yPos);
    }

    // X-axis time marks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const numLabels = 4;
    for (let i = 0; i <= numLabels; i++) {
      const idx = Math.min(points.length - 1, Math.round((points.length - 1) * (i / numLabels)));
      const pt = points[idx];
      if (pt && pt.t) {
        const d = new Date(pt.t * 1000);
        const hours = d.getHours().toString().padStart(2, '0');
        const mins = d.getMinutes().toString().padStart(2, '0');
        const xPos = padLeft + plotW * (i / numLabels);
        ctx.fillText(`${hours}:${mins}`, xPos, h - padBottom + 8);
      }
    }

    // Draw curves
    series.forEach((s) => {
      if (!s.data || s.data.length === 0) return;
      const n = s.data.length;
      const coords = [];

      for (let i = 0; i < n; i++) {
        const x = padLeft + plotW * (i / (n - 1 || 1));
        const normY = Math.max(0, Math.min(1, (s.data[i] - minY) / (maxY - minY || 1)));
        const y = padTop + plotH - plotH * normY;
        coords.push({ x, y, val: s.data[i] });
      }

      // Gradient Fill
      if (s.fill && coords.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(coords[0].x, padTop + plotH);
        ctx.lineTo(coords[0].x, coords[0].y);

        for (let i = 0; i < coords.length - 1; i++) {
          const xc = (coords[i].x + coords[i + 1].x) / 2;
          const yc = (coords[i].y + coords[i + 1].y) / 2;
          ctx.quadraticCurveTo(coords[i].x, coords[i].y, xc, yc);
        }
        ctx.lineTo(coords[coords.length - 1].x, coords[coords.length - 1].y);
        ctx.lineTo(coords[coords.length - 1].x, padTop + plotH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, s.fillColor || `${s.color}33`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      // Smooth Stroke
      if (coords.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 6;
        ctx.lineWidth = s.lineWidth || 2;
        ctx.strokeStyle = s.color;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        ctx.moveTo(coords[0].x, coords[0].y);
        for (let i = 0; i < coords.length - 1; i++) {
          const xc = (coords[i].x + coords[i + 1].x) / 2;
          const yc = (coords[i].y + coords[i + 1].y) / 2;
          ctx.quadraticCurveTo(coords[i].x, coords[i].y, xc, yc);
        }
        ctx.lineTo(coords[coords.length - 1].x, coords[coords.length - 1].y);
        ctx.stroke();
        ctx.restore();
      }

      // Peak Highlight
      if (s.showPeak && coords.length > 0) {
        let maxIdx = 0,
          maxVal = -Infinity;
        coords.forEach((c, idx) => {
          if (c.val > maxVal) {
            maxVal = c.val;
            maxIdx = idx;
          }
        });
        if (maxVal > 0) {
          const p = coords[maxIdx];
          ctx.save();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.shadowColor = s.color;
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      }
    });

    // Outage Incident Markers (Red Pins)
    if (config.outages && config.outages.length > 0) {
      config.outages.forEach((outage) => {
        let nearestIdx = -1,
          minDiff = Infinity;
        points.forEach((p, idx) => {
          const diff = Math.abs(p.t - outage.t);
          if (diff < minDiff) {
            minDiff = diff;
            nearestIdx = idx;
          }
        });
        if (nearestIdx !== -1 && minDiff < 180) {
          const x = padLeft + plotW * (nearestIdx / (points.length - 1 || 1));
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1.2;
          ctx.moveTo(x, padTop);
          ctx.lineTo(x, padTop + plotH);
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(x, padTop + 4, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.shadowColor = '#ef4444';
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.restore();
        }
      });
    }

    // Attach Interactive Hover
    canvas._chartMeta = {
      plotW,
      plotH,
      padLeft,
      padRight,
      padTop,
      padBottom,
      points,
      series
    };
    attachCanvasHover(canvas);
  }

  function attachCanvasHover(canvas) {
    if (canvas._hasHover) return;
    canvas._hasHover = true;

    const tooltip = document.getElementById('metrics-tooltip');

    canvas.addEventListener('mousemove', (e) => {
      const meta = canvas._chartMeta;
      if (!meta || !meta.points || meta.points.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;

      if (mouseX < meta.padLeft || mouseX > rect.width - meta.padRight) {
        if (tooltip) tooltip.style.display = 'none';
        return;
      }

      const relX = (mouseX - meta.padLeft) / meta.plotW;
      const idx = Math.max(
        0,
        Math.min(meta.points.length - 1, Math.round(relX * (meta.points.length - 1)))
      );
      const pt = meta.points[idx];
      if (!pt) return;

      const timeStr = new Date(pt.t * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      let tooltipHtml = `<div style="color: #a1a1aa; font-size: 0.7rem; margin-bottom: 4px;">Time: <strong style="color:#fff;">${timeStr}</strong></div>`;
      meta.series.forEach((s) => {
        const val = s.data[idx];
        const displayVal = s.formatVal ? s.formatVal(val) : val;
        tooltipHtml += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
          <span style="width:7px;height:7px;border-radius:50%;background:${s.color};"></span>
          <span style="color:#a1a1aa;">${s.label}:</span>
          <strong style="color:#fff;">${displayVal}</strong>
        </div>`;
      });

      if (tooltip) {
        tooltip.innerHTML = tooltipHtml;
        tooltip.style.left = `${e.clientX}px`;
        tooltip.style.top = `${e.clientY - 12}px`;
        tooltip.style.display = 'block';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (tooltip) tooltip.style.display = 'none';
    });
  }

  // Periodic Refresh
  function startSyncTimer() {
    state.timerId = setInterval(() => {
      if (document.hidden) return; // Full suspension when browser tab is inactive
      fetchSystem();
      fetchPings();
      if (state.activeTab === 'downloads') fetchDownloads();
      if (state.activeTab === 'vpn') fetchVpnStatus();
      if (state.activeTab === 'logs') fetchLogs();
      if (state.activeTab === 'metrics' || state.activeTab === 'apps') fetchMetrics();
      if (state.activeTab === 'requests') fetchRequests();
    }, 4000);
  }

  // Window Resize Controller with Debounce
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateNavPill(state.activeTab);
      if ((state.activeTab === 'metrics' || state.activeTab === 'apps') && state.metricsData) {
        renderAllCharts(state.metricsData);
      }
    }, 120);
  });

  // ==============================================================================
  // QUALITY ORCHESTRATOR REQUEST HANDLING
  // ==============================================================================

  const ORCHESTRATOR_URL = 'http://localhost:8002';
  const ORCHESTRATOR_API_KEY = localStorage.getItem('orchestrator_api_key') || '';

  // TMDB Search
  async function searchTMDB(query) {
    if (!query || query.length < 2) return [];
    try {
      const res = await fetch(`/api/tmdb/search?query=${encodeURIComponent(query)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.results || [];
    } catch (e) {
      console.error('TMDB search failed:', e);
      return [];
    }
  }

  // Render TMDB search results
  function renderSearchResults(results) {
    const container = document.getElementById('request-search-results');
    if (!container) return;

    if (results.length === 0) {
      container.innerHTML =
        '<div style="padding: 20px; text-align: center; color: #71717a;">No results found</div>';
      container.style.display = 'block';
      return;
    }

    container.innerHTML = results
      .map(
        (item) => `
      <div class="search-result-item" style="display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; cursor: pointer; transition: background 0.2s; background: #121215; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 8px;" 
           onclick="selectMedia(${JSON.stringify(item).replace(/"/g, '"')})"
           onmouseover="this.style.background='#1a1a2e'" onmouseout="this.style.background='#121215'">
        <img src="https://image.tmdb.org/t/p/w92${item.poster_path || ''}" alt="" style="width: 50px; height: 75px; object-fit: cover; border-radius: 6px; background: #222;">
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${item.title || item.name}
          </div>
          <div style="font-size: 0.75rem; color: #71717a;">
            ${item.media_type === 'tv' ? 'TV Series' : 'Movie'} • ${item.release_date || item.first_air_date || 'Unknown'} • ${item.vote_average?.toFixed(1) || '?'}★
          </div>
          <div style="font-size: 0.7rem; color: #52525b; margin-top: 2px;">${item.overview?.substring(0, 100) || 'No overview'}...</div>
        </div>
        <span style="font-size: 0.7rem; color: #3b82f6; padding: 2px 8px; border: 1px solid rgba(59,130,246,0.3); border-radius: 4px;">Select</span>
      </div>
    `
      )
      .join('');
    container.style.display = 'block';
  }

  window.selectMedia = function (media) {
    state.requestSelectedMedia = media;
    state.requestSearchResults = [];
    document.getElementById('request-search-results').style.display = 'none';
    document.getElementById('request-search-input').value = media.title || media.name;

    // Move to quality selection step
    document.getElementById('request-step-search').style.display = 'none';
    document.getElementById('request-step-quality').style.display = 'block';

    // Reset quality tier
    state.requestQualityTier = 'max';
    document.querySelectorAll('.quality-tier-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tier === 'max');
      if (btn.dataset.tier === 'max') {
        btn.style.borderColor = 'rgba(59, 130, 246, 0.5)';
        btn.style.background = 'rgba(59, 130, 246, 0.15)';
        btn.style.color = '#3b82f6';
      } else {
        btn.style.borderColor = 'rgba(255,255,255,0.1)';
        btn.style.background = '#121215';
        btn.style.color = '#a1a1aa';
      }
    });
    document.getElementById('request-advanced-discovery').style.display = 'none';
    updateConfirmButton();
  };

  window.backToSearch = function () {
    document.getElementById('request-step-quality').style.display = 'none';
    document.getElementById('request-step-search').style.display = 'block';
    state.requestSelectedMedia = null;
  };

  // Quality tier button handling
  document.addEventListener('click', (e) => {
    if (e.target.closest('.quality-tier-btn')) {
      const btn = e.target.closest('.quality-tier-btn');
      const tier = btn.dataset.tier;
      state.requestQualityTier = tier;

      document.querySelectorAll('.quality-tier-btn').forEach((b) => {
        b.classList.remove('active');
        b.style.borderColor = 'rgba(255,255,255,0.1)';
        b.style.background = '#121215';
        b.style.color = '#a1a1aa';
      });
      btn.classList.add('active');
      btn.style.borderColor =
        tier === 'max' || tier === 'advanced'
          ? 'rgba(139, 92, 246, 0.5)'
          : 'rgba(59, 130, 246, 0.5)';
      btn.style.background =
        tier === 'max' || tier === 'advanced'
          ? 'rgba(139, 92, 246, 0.15)'
          : 'rgba(59, 130, 246, 0.15)';
      btn.style.color = tier === 'max' || tier === 'advanced' ? '#8b5cf6' : '#3b82f6';

      if (tier === 'advanced') {
        document.getElementById('request-advanced-discovery').style.display = 'block';
      } else {
        document.getElementById('request-advanced-discovery').style.display = 'none';
      }
      updateConfirmButton();
    }
  });

  function updateConfirmButton() {
    const btn = document.getElementById('btn-confirm-request');
    if (!btn) return;

    if (state.requestQualityTier === 'advanced') {
      const hasSelected =
        state.selectedReleaseIndex !== undefined && state.selectedReleaseIndex !== null;
      btn.disabled = !hasSelected;
      btn.textContent = 'Grab Selected Release';
    } else {
      btn.disabled = !state.requestSelectedMedia;
      btn.textContent = `Request in ${(state.requestQualityTier || 'max').toUpperCase()}`;
    }
  }

  // Discover qualities (Advanced mode - Real-Time Prowlarr Swarm Inspector)
  window.discoverQualities = async function () {
    if (!state.requestSelectedMedia) return;

    const statusEl = document.getElementById('discovery-status');
    const gridEl = document.getElementById('quality-grid');
    const discoverBtn = document.getElementById('btn-discover-qualities');
    const rediscoverBtn = document.getElementById('btn-rediscover');

    state.requestDiscoveryInProgress = true;
    if (discoverBtn) discoverBtn.disabled = true;
    if (rediscoverBtn) rediscoverBtn.disabled = true;
    if (statusEl)
      statusEl.textContent = 'Inspecting live tracker swarms (LimeTorrents, Knaben, YTS)...';
    if (gridEl)
      gridEl.innerHTML =
        '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #71717a;"><div class="spinner-small" style="margin: 0 auto 12px;"></div> Querying indexers in real time...</div>';

    try {
      const media = state.requestSelectedMedia;
      const title = media.title || media.name || '';
      const year = (media.release_date || media.first_air_date || '').substring(0, 4);

      const res = await fetch(
        `/api/media/releases/search?query=${encodeURIComponent(title)}&year=${encodeURIComponent(year)}&tmdbId=${media.id}`
      );
      if (!res.ok) throw new Error('Search failed: HTTP ' + res.status);
      const data = await res.json();

      if (!data.releases || data.releases.length === 0) {
        if (statusEl) statusEl.textContent = 'No releases found for this title.';
        if (gridEl)
          gridEl.innerHTML =
            '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #71717a;">No active swarms found across indexers.</div>';
        return;
      }

      state.requestDiscoveredQualities = data.releases;
      if (statusEl)
        statusEl.textContent = `Found ${data.total} swarms in ${data.tookMs}ms. Click a release to select.`;

      renderQualityGrid(data.releases);

      if (discoverBtn) discoverBtn.style.display = 'none';
      if (rediscoverBtn) rediscoverBtn.style.display = 'inline-block';
    } catch (e) {
      console.error('Discovery failed:', e);
      if (statusEl) statusEl.textContent = 'Swarm inspection failed: ' + e.message;
      if (gridEl)
        gridEl.innerHTML =
          '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #ef4444;">Failed to inspect swarms. Please retry.</div>';
    } finally {
      state.requestDiscoveryInProgress = false;
      if (discoverBtn) discoverBtn.disabled = false;
      if (rediscoverBtn) rediscoverBtn.disabled = false;
    }
  };

  function renderQualityGrid(releases) {
    const gridEl = document.getElementById('quality-grid');
    if (!gridEl) return;

    if (!releases || releases.length === 0) {
      gridEl.innerHTML =
        '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #71717a;">No releases found</div>';
      return;
    }

    gridEl.innerHTML = releases
      .slice(0, 24)
      .map((rel, idx) => {
        const attrs = rel.attributes || {};
        const resPill = attrs.resolution || '1080p';
        const hdrPills = (attrs.hdr || [])
          .map((h) => `<span class="release-pill hdr">${escapeHtml(h)}</span>`)
          .join(' ');
        const audioPill = attrs.audio
          ? `<span class="release-pill audio">${escapeHtml(attrs.audio)}</span>`
          : '';
        const remuxPill = attrs.isRemux ? '<span class="release-pill remux">REMUX</span>' : '';
        const imaxPill = attrs.isImax ? '<span class="release-pill imax">IMAX</span>' : '';

        return `
        <div class="quality-card release-item-card" data-idx="${idx}" 
             style="background: #121215; border: 2px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; cursor: pointer; transition: all 0.2s; position: relative;"
             onclick="selectRelease(${idx})"
             onmouseover="this.style.borderColor='rgba(139,92,246,0.6)'; this.style.transform='translateY(-2px)'"
             onmouseout="if(!this.classList.contains('selected')) { this.style.borderColor='rgba(255,255,255,0.08)'; this.style.transform='translateY(0)'; }">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;">
            <span class="release-pill res-${resPill.includes('2160') ? '4k' : resPill.includes('720') ? '720' : '1080'}">${escapeHtml(resPill)}</span>
            <span style="font-size: 0.85rem; font-weight: 700; color: #fff;">${escapeHtml(rel.sizeFormatted)}</span>
          </div>
          <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px;">
            ${remuxPill} ${imaxPill} ${hdrPills} ${audioPill}
          </div>
          <div style="font-size: 0.72rem; color: #fff; font-weight: 500; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.3;">
            ${escapeHtml(rel.title)}
          </div>
          <div style="font-size: 0.7rem; color: #71717a; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 6px; margin-top: 6px;">
            <span>🌱 <strong style="color: #10b981;">${rel.seeders}</strong> seeds</span>
            <span style="color: #a1a1aa;">📍 ${escapeHtml(rel.indexer)}</span>
          </div>
          <div style="position: absolute; top: 10px; right: 10px; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.2); border-radius: 50%;" class="quality-check"></div>
        </div>
      `;
      })
      .join('');

    addQualityCardStyles();
  }

  window.selectRelease = function (idx) {
    document.querySelectorAll('.quality-card').forEach((card) => card.classList.remove('selected'));
    const target = document.querySelector(`.quality-card[data-idx="${idx}"]`);
    if (target) target.classList.add('selected');
    state.selectedReleaseIndex = idx;
    updateConfirmButton();
  };

  function addQualityCardStyles() {
    if (document.getElementById('quality-card-styles')) return;
    const style = document.createElement('style');
    style.id = 'quality-card-styles';
    style.textContent = `
      .quality-card { position: relative; }
      .quality-card.selected { border-color: #8b5cf6 !important; box-shadow: 0 0 0 2px rgba(139,92,246,0.3) !important; background: #1a1528 !important; }
      .quality-card.selected .quality-check { background: #8b5cf6; border-color: #8b5cf6 !important; }
      .quality-card.selected .quality-check::after { content: '✔'; color: #fff; font-size: 11px; position: absolute; top: 0; left: 3px; line-height: 16px; }
      .release-pill { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
      .release-pill.res-4k { background: rgba(236,72,153,0.15); color: #ec4899; border: 1px solid rgba(236,72,153,0.3); }
      .release-pill.res-1080 { background: rgba(59,130,246,0.15); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3); }
      .release-pill.res-720 { background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
      .release-pill.hdr { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
      .release-pill.audio { background: rgba(168,85,247,0.15); color: #a855f7; border: 1px solid rgba(168,85,247,0.3); }
      .release-pill.remux { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
      .release-pill.imax { background: rgba(6,182,212,0.15); color: #06b6d4; border: 1px solid rgba(6,182,212,0.3); }
    `;
    document.head.appendChild(style);
  }

  // Confirm request
  window.confirmRequest = async function () {
    const btn = document.getElementById('btn-confirm-request');
    const media = state.requestSelectedMedia;
    const tier = state.requestQualityTier || 'max';

    if (!media) return showToast('No media selected', 'error');

    btn.disabled = true;
    btn.textContent = 'Dispatching...';

    try {
      if (tier === 'advanced') {
        if (state.selectedReleaseIndex === undefined || state.selectedReleaseIndex === null) {
          return showToast('Select a release first', 'error');
        }
        const rel = (state.requestDiscoveredQualities || [])[state.selectedReleaseIndex];
        if (!rel) return showToast('Selected release not found', 'error');

        const grabRes = await fetch('/api/media/releases/grab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tmdbId: media.id,
            title: media.title || media.name,
            year: (media.release_date || media.first_air_date || '').substring(0, 4),
            downloadUrl: rel.downloadUrl,
            releaseTitle: rel.title,
            guid: rel.guid,
            indexerId: rel.indexerId
          })
        });

        if (!grabRes.ok) throw new Error('Failed to grab release');
        showToast(`🚀 Dispatched release to pipeline: ${rel.title.substring(0, 40)}...`, 'success');
      } else {
        // Direct request with tier (Medium 720p, High 1080p, MAX 4K)
        const reqRes = await fetch('/api/media/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tmdbId: media.id,
            mediaType: media.media_type || 'movie',
            tier: tier,
            title: media.title || media.name,
            year: (media.release_date || media.first_air_date || '').substring(0, 4)
          })
        });

        if (!reqRes.ok) {
          const errData = await reqRes.json().catch(() => ({}));
          throw new Error(errData.error || 'Request failed');
        }
        showToast(`✅ Request dispatched with ${tier.toUpperCase()} quality!`, 'success');
      }

      closeRequestModal();
      setTimeout(() => fetchRequests(true), 1200);
    } catch (e) {
      console.error('Request failed:', e);
      showToast('Failed to submit request: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      updateConfirmButton();
    }
  };

  window.openRequestModal = function () {
    document.getElementById('modal-request').style.display = 'flex';
    document.getElementById('request-step-search').style.display = 'block';
    document.getElementById('request-step-quality').style.display = 'none';
    document.getElementById('request-search-input').value = '';
    document.getElementById('request-search-results').style.display = 'none';
    state.requestSelectedMedia = null;
    state.requestQualityTier = 'max';
    document.querySelectorAll('.quality-tier-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tier === 'max');
    });
    document.getElementById('request-advanced-discovery').style.display = 'none';
    updateConfirmButton();
  };

  window.closeRequestModal = function () {
    document.getElementById('modal-request').style.display = 'none';
    state.currentDiscoveryRequestId = null;
    state.requestDiscoveredQualities = [];
  };

  // Debounced TMDB search
  let searchDebounceTimer = null;
  document.addEventListener('input', (e) => {
    if (e.target.id === 'request-search-input') {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async () => {
        const query = e.target.value.trim();
        if (query.length < 2) {
          document.getElementById('request-search-results').style.display = 'none';
          return;
        }

        const loadingEl = document.getElementById('request-search-loading');
        if (loadingEl) loadingEl.style.display = 'block';

        const results = await searchTMDB(query);

        if (loadingEl) loadingEl.style.display = 'none';
        renderSearchResults(results);
      }, 300);
    }
  });

  // ==============================================================================
  // VIEW 6: UNIFIED MEDIA REQUESTS PANEL
  // ==============================================================================

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
  }

  function formatEta(seconds) {
    if (!seconds || seconds <= 0 || seconds >= 8640000) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  window.fetchRequests = async function (manual = false) {
    const icon = document.getElementById('icon-refresh-req');
    if (manual && icon) icon.classList.add('animate-spin');

    try {
      const res = await fetch('/api/requests');
      if (!res.ok) throw new Error('Failed to fetch requests: ' + res.status);
      const data = await res.json();
      state.requests = Array.isArray(data) ? data : [];

      // Update Nav badge count (downloading + attention items)
      const activeCount = state.requests.filter(
        (r) => r.status === 'downloading' || r.status === 'stalled' || r.status === 'failed'
      ).length;
      const badge = document.getElementById('badge-req');
      if (badge) {
        badge.textContent = activeCount;
        badge.style.display = activeCount > 0 ? 'inline-block' : 'none';
      }

      // Update Header Pill
      const headerPill = document.getElementById('req-header-pill');
      if (headerPill) {
        headerPill.textContent = `${state.requests.length} Total`;
      }

      // Update Metrics Ribbon
      const totalCount = state.requests.length;
      const downloadingItems = state.requests.filter((r) => r.status === 'downloading');
      const downloadingCount = downloadingItems.length;
      const totalSpeed = downloadingItems.reduce((acc, r) => acc + (r.downloadSpeed || 0), 0);
      const attentionCount = state.requests.filter(
        (r) => r.status === 'stalled' || r.status === 'failed'
      ).length;
      const completedCount = state.requests.filter((r) => r.status === 'completed').length;

      const elTotal = document.getElementById('req-metric-total');
      if (elTotal) elTotal.textContent = totalCount;
      const elActive = document.getElementById('req-metric-active');
      if (elActive) elActive.textContent = downloadingCount;
      const elSpeed = document.getElementById('req-metric-speed');
      if (elSpeed) elSpeed.textContent = `↓ ${formatSpeed(totalSpeed)} in swarm`;
      const elAttention = document.getElementById('req-metric-attention');
      if (elAttention) elAttention.textContent = attentionCount;
      const elCompleted = document.getElementById('req-metric-completed');
      if (elCompleted) elCompleted.textContent = completedCount;

      // Populate User Filter Dropdown if options changed
      updateUserFilterOptions();

      // Render the request cards
      renderRequests();
    } catch (err) {
      console.error('Failed to load requests:', err);
      const grid = document.getElementById('requests-grid');
      if (grid && (!state.requests || state.requests.length === 0)) {
        grid.innerHTML = `
          <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 48px 24px; text-align: center; color: var(--text-muted);">
            <div style="font-size: 1.1rem; font-weight: 600; color: #f43f5e; margin-bottom: 8px;">Failed to Load Media Requests</div>
            <div style="font-size: 0.85rem; color: #a1a1aa; margin-bottom: 16px;">${escapeHtml(err.message)}</div>
            <button class="btn-primary" onclick="fetchRequests(true)" style="padding: 6px 14px; font-size: 0.8rem;">Retry Connection</button>
          </div>
        `;
      }
    } finally {
      if (manual && icon) {
        setTimeout(() => icon.classList.remove('animate-spin'), 600);
      }
    }
  };

  function updateUserFilterOptions() {
    const select = document.getElementById('req-user-select');
    if (!select) return;

    const currentVal = state.reqFilterUser || 'all';
    const users = Array.from(
      new Set(state.requests.map((r) => r.requestedBy?.displayName).filter(Boolean))
    );

    const existingOptions = Array.from(select.options).map((o) => o.value);
    const newOptions = ['all', ...users];
    if (existingOptions.join(',') === newOptions.join(',')) return;

    let html = '<option value="all">All Requesters</option>';
    users.forEach((u) => {
      html += `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`;
    });
    select.innerHTML = html;
    select.value = currentVal;
  }

  function renderRequests() {
    const grid = document.getElementById('requests-grid');
    if (!grid) return;

    const list = state.requests || [];
    const search = (state.reqFilterSearch || '').toLowerCase().trim();
    const statusFilter = state.reqFilterStatus || 'all';
    const userFilter = state.reqFilterUser || 'all';

    const filtered = list.filter((r) => {
      // Status filter
      if (statusFilter === 'downloading' && r.status !== 'downloading') return false;
      if (statusFilter === 'stalled' && r.status !== 'stalled' && r.status !== 'failed')
        return false;
      if (statusFilter === 'completed' && r.status !== 'completed') return false;
      if (statusFilter === 'pending' && r.status !== 'pending' && r.status !== 'searching')
        return false;

      // User filter
      if (userFilter !== 'all' && (r.requestedBy?.displayName || '') !== userFilter) return false;

      // Text search
      if (search) {
        const titleMatch = (r.title || '').toLowerCase().includes(search);
        const yearMatch = String(r.year || '').includes(search);
        const userMatch = (r.requestedBy?.displayName || '').toLowerCase().includes(search);
        if (!titleMatch && !yearMatch && !userMatch) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 48px 24px; text-align: center; color: var(--text-muted);">
          <div style="font-size: 1.1rem; font-weight: 600; color: #fff; margin-bottom: 6px;">No requests match your filter</div>
          <div style="font-size: 0.85rem; color: #71717a;">Try selecting another status tab or clearing your search filter.</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered.map((r) => renderRequestCard(r)).join('');
  }

  function renderRequestCard(r) {
    const id = r.id;
    const isCompleted = r.status === 'completed';
    const isDownloading = r.status === 'downloading';
    const isStalled = r.status === 'stalled';
    const isFailed = r.status === 'failed';
    const isSearching = r.status === 'searching';
    const isPending = r.status === 'pending';

    const progress = Math.min(100, Math.max(0, r.progress || 0));
    const dlSizeStr = formatBytes(r.downloadedBytes);
    const totalSizeStr = formatBytes(r.totalBytes);
    const speedStr = formatSpeed(r.downloadSpeed);
    const etaStr = formatEta(r.etaSeconds);

    const hasDiagnosis = Boolean(r.failureReason);
    const isDiagnosisExpanded = state.expandedDiagnoses.has(id);
    const hasEpisodes = Boolean(r.torrents && r.torrents.length > 1);
    const isEpisodesExpanded = state.expandedEpisodes.has(id);

    // Status pill HTML
    let pillClass = 'pending';
    let pillIcon = '';
    if (isCompleted) {
      pillClass = 'completed';
      pillIcon = '✔';
    } else if (isDownloading) {
      pillClass = 'downloading';
      pillIcon = '<span class="pulsing-dot"></span>';
    } else if (isStalled) {
      pillClass = 'stalled';
      pillIcon = '⚠';
    } else if (isFailed) {
      pillClass = 'failed';
      pillIcon = '✖';
    } else if (isSearching) {
      pillClass = 'searching';
      pillIcon = '⟳';
    }

    // Poster thumbnail
    const posterHtml = r.posterUrl
      ? `<img src="${escapeHtml(r.posterUrl)}" alt="" class="req-poster-img" loading="lazy" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'req-poster-fallback\\'>${escapeHtml((r.title || '?')[0])}</div>';">`
      : `<div class="req-poster-fallback">${escapeHtml((r.title || '?')[0])}</div>`;

    // Requester avatar
    const avatarHtml = r.requestedBy?.avatarUrl
      ? `<img src="${escapeHtml(r.requestedBy.avatarUrl)}" alt="" class="req-avatar" onerror="this.style.display='none';">`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

    // Diagnosis banner HTML
    let diagnosisHtml = '';
    if (hasDiagnosis) {
      const diag = r.failureReason;
      diagnosisHtml = `
        <div class="req-diagnosis-box ${isFailed ? 'failed' : ''}">
          <div class="req-diagnosis-header ${isFailed ? 'failed' : ''}" onclick="toggleDiagnosis(${id})">
            <span>⚠ ${escapeHtml(diag.summary)}</span>
            <span style="font-size: 0.72rem; text-decoration: underline;">${isDiagnosisExpanded ? 'Hide Details ▲' : 'Show Details ▼'}</span>
          </div>
          ${
            isDiagnosisExpanded
              ? `
            <div class="req-diagnosis-content">
              <p><strong>Root Cause:</strong> ${escapeHtml(diag.details || '')}</p>
              ${diag.suggestedFix ? `<p><strong>Suggested Action:</strong> ${escapeHtml(diag.suggestedFix)}</p>` : ''}
              <div style="margin-top: 8px;">
                <button class="req-action-btn primary" onclick="retrySingleRequest(event, ${id}, ${r.tmdbId}, '${escapeHtml(r.type)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                  Re-Index & Search
                </button>
              </div>
            </div>
          `
              : ''
          }
        </div>
      `;
    }

    // Episode breakdown HTML
    let episodesHtml = '';
    if (hasEpisodes) {
      episodesHtml = `
        <div style="margin-top: 4px;">
          <button class="req-action-btn" onclick="toggleEpisodes(${id})" style="font-size: 0.72rem; padding: 3px 8px;">
            ${isEpisodesExpanded ? 'Hide Episodes (▲)' : `Show Episodes (${r.torrents.length}) ▼`}
          </button>
          ${
            isEpisodesExpanded
              ? `
            <div class="req-episodes-drawer">
              ${r.torrents
                .map(
                  (t) => `
                <div class="req-episode-item">
                  <div style="min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff;">
                    ${escapeHtml(t.name)}
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0; color: #a1a1aa; font-family: var(--font-mono); font-size: 0.7rem;">
                    <span>${t.progress}%</span>
                    <span>${formatBytes(t.size)}</span>
                    <span style="color: ${t.state === 'downloading' ? '#38bdf8' : t.state === 'stalledDL' ? '#f59e0b' : '#71717a'};">${escapeHtml(t.state)}</span>
                    <span>🌱 ${t.seeds}</span>
                  </div>
                </div>
              `
                )
                .join('')}
            </div>
          `
              : ''
          }
        </div>
      `;
    }

    // Seeds & Swarm line
    const totalSeeds = (r.torrents || []).reduce((acc, t) => acc + (t.seeds || 0), 0);
    const totalPeers = (r.torrents || []).reduce((acc, t) => acc + (t.peers || 0), 0);

    return `
      <div class="req-card ${r.isPrioritized ? 'priority-active' : ''}" id="req-card-${id}">
        <div class="req-poster-wrap">
          ${posterHtml}
        </div>
        <div class="req-card-body">
          <div class="req-card-header">
            <div class="req-title-row">
              <span class="req-title">${escapeHtml(r.title)}</span>
              ${r.year ? `<span class="req-year">(${r.year})</span>` : ''}
              <span class="req-type-badge">${escapeHtml(r.type || 'movie')}</span>
              <span class="req-profile-badge">${escapeHtml(r.qualityProfile || 'Standard')}</span>
              ${r.isPrioritized ? `<span class="req-turbo-badge"><span class="pulsing-bolt">⚡</span> TURBO ACTIVE</span>` : ''}
            </div>
            <div class="req-status-pill ${pillClass}">
              ${pillIcon}
              <span>${escapeHtml(r.statusLabel || r.status)}</span>
            </div>
          </div>

          <div class="req-meta-line">
            <div class="req-user-badge">
              ${avatarHtml}
              <span>Requested by <strong>${escapeHtml(r.requestedBy?.displayName || 'User')}</strong></span>
            </div>
            <span>•</span>
            <span>${escapeHtml(r.relativeTime || '')}</span>
            ${r.torrentsCount > 0 ? `<span>•</span><span>📁 ${r.torrentsCount} file${r.torrentsCount > 1 ? 's' : ''} in swarm</span>` : ''}
          </div>

          <!-- Progress Bar (shown when downloading, stalled, or completed) -->
          ${
            (!isSearching && !isPending) || progress > 0
              ? `
            <div class="req-progress-wrap">
              <div class="req-progress-track">
                <div class="req-progress-fill ${isCompleted ? 'completed' : isStalled ? 'stalled' : ''}" style="width: ${progress}%;"></div>
              </div>
              <div class="req-progress-sub">
                <div>
                  <strong>${progress}%</strong>
                  ${r.totalBytes > 0 ? ` • ${dlSizeStr} / ${totalSizeStr}` : ''}
                </div>
                <div style="display: flex; gap: 12px; align-items: center;">
                  ${isDownloading && r.downloadSpeed > 0 ? `<span style="color: #38bdf8;">↓ ${speedStr}</span>` : ''}
                  ${isDownloading && r.etaSeconds > 0 ? `<span>ETA: ${etaStr}</span>` : ''}
                  ${r.torrentsCount > 0 ? `<span>🌱 ${totalSeeds} seeds • 👥 ${totalPeers} peers</span>` : ''}
                </div>
              </div>
            </div>
          `
              : ''
          }

          <!-- Diagnosis Banner (if stalled/failed) -->
          ${diagnosisHtml}

          <!-- TV Episodes Drawer -->
          ${episodesHtml}

          <!-- Footer Actions -->
          <div class="req-card-actions">
            ${
              isCompleted
                ? `
              <a href="http://127.0.0.1:8096" target="_blank" class="req-action-btn success">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                Watch in Jellyfin ↗
              </a>
            `
                : ''
            }
            ${
              !isCompleted
                ? `
              ${
                r.isPrioritized
                  ? `
                <button class="req-action-btn req-btn-unprioritize" onclick="unprioritizeRequest(event, ${id})">
                  <span class="pulsing-bolt">⚡</span> <strong>PRIORITY ACTIVE</strong> &bull; Cancel ✕
                </button>
              `
                  : `
                <button class="req-action-btn req-btn-prioritize" onclick="prioritizeRequest(event, ${id}, '${escapeHtml(r.title)}')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                  ⚡ Prioritize Download
                </button>
              `
              }
            `
                : ''
            }
            ${
              isStalled || isFailed || isSearching
                ? `
              <button class="req-action-btn primary" onclick="retrySingleRequest(event, ${id}, ${r.tmdbId}, '${escapeHtml(r.type)}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                Retry Search
              </button>
            `
                : ''
            }
            <a href="http://127.0.0.1:5055/${r.type === 'tv' ? 'tv' : 'movie'}/${r.tmdbId}" target="_blank" class="req-action-btn" style="color: #a1a1aa;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              View in Seerr
            </a>
          </div>

        </div>
      </div>
    `;
  }

  window.toggleDiagnosis = function (id) {
    if (state.expandedDiagnoses.has(id)) {
      state.expandedDiagnoses.delete(id);
    } else {
      state.expandedDiagnoses.add(id);
    }
    renderRequests();
  };

  window.toggleEpisodes = function (id) {
    if (state.expandedEpisodes.has(id)) {
      state.expandedEpisodes.delete(id);
    } else {
      state.expandedEpisodes.add(id);
    }
    renderRequests();
  };

  window.retrySingleRequest = async function (e, id, tmdbId, type) {
    if (e && e.stopPropagation) e.stopPropagation();
    showToast(`Triggering re-search for request #${id}...`, 'info');
    try {
      const res = await fetch('/api/requests/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, tmdbId, type })
      });
      if (res.ok) {
        showToast(`Re-search commanded for request #${id}!`, 'success');
        setTimeout(() => fetchRequests(true), 1500);
      } else {
        showToast('Failed to trigger retry', 'error');
      }
    } catch (err) {
      showToast('Retry error: ' + err.message, 'error');
    }
  };

  window.prioritizeRequest = async function (e, id, title) {
    if (e && e.stopPropagation) e.stopPropagation();
    showToast(`⚡ Allocating maximum bandwidth to '${title}'...`, 'info');
    try {
      const res = await fetch(`/api/requests/${id}/prioritize`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(
          `⚡ Priority Mode Activated: 100% bandwidth allocated to '${title}'! (${data.pausedCount} background downloads paused)`,
          'success'
        );
        fetchRequests(true);
      } else {
        showToast(data.error || 'Failed to prioritize request', 'error');
      }
    } catch (err) {
      showToast('Prioritize error: ' + err.message, 'error');
    }
  };

  window.unprioritizeRequest = async function (e, id) {
    if (e && e.stopPropagation) e.stopPropagation();
    showToast('Reverting priority and resuming background downloads...', 'info');
    try {
      const res = await fetch(`/api/requests/${id}/unprioritize`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(
          `✔ Priority mode disabled. Resumed ${data.resumedCount || 0} background download(s).`,
          'success'
        );
        fetchRequests(true);
      } else {
        showToast(data.error || 'Failed to unprioritize request', 'error');
      }
    } catch (err) {
      showToast('Unprioritize error: ' + err.message, 'error');
    }
  };

  function setupRequestsToolbar() {
    // Status Filter Tabs
    const filterTabs = document.getElementById('req-status-filters');
    if (filterTabs) {
      filterTabs.querySelectorAll('.req-filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          filterTabs
            .querySelectorAll('.req-filter-btn')
            .forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          state.reqFilterStatus = btn.dataset.filter || 'all';
          renderRequests();
        });
      });
    }

    // Search input
    const searchInput = document.getElementById('req-filter-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.reqFilterSearch = e.target.value;
        renderRequests();
      });
    }

    // User select dropdown
    const userSelect = document.getElementById('req-user-select');
    if (userSelect) {
      userSelect.addEventListener('change', (e) => {
        state.reqFilterUser = e.target.value;
        renderRequests();
      });
    }

    // Modal open button
    const btnNew = document.getElementById('btn-new-request');
    if (btnNew) {
      btnNew.addEventListener('click', () => {
        const modal = document.getElementById('modal-request');
        if (modal) {
          modal.style.display = 'flex';
          const input = document.getElementById('request-search-input');
          if (input) {
            input.value = '';
            input.focus();
          }
          const results = document.getElementById('request-search-results');
          if (results) results.style.display = 'none';
          const stepSearch = document.getElementById('request-step-search');
          if (stepSearch) stepSearch.style.display = 'block';
          const stepQuality = document.getElementById('request-step-quality');
          if (stepQuality) stepQuality.style.display = 'none';
        }
      });
    }
  }

  // ==============================================================================
  // INIT
  // ==============================================================================
  function init() {
    setupEventListeners();
    loadLogSources();
    renderAppGrid();
    switchView(state.activeTab);
    fetchSystem();
    fetchPings();
    fetchDownloads();
    fetchVpnStatus();
    fetchRequests();
    if (state.activeTab === 'metrics' || state.activeTab === 'apps') fetchMetrics(true);
    startSyncTimer();
    setTimeout(() => updateNavPill(state.activeTab), 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
