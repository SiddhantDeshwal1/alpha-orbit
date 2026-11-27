// Orbit Server Dashboard: High-Performance Frontend Engine (dx.bi + Access Gate)

(function () {
  'use strict';

  // --- Accent Theme Presets (dx.bi) ---
  const DX_ACCENTS = {
    red: '#e50914',
    crimson: '#d81f3c',
    blue: '#2f80ff',
    purple: '#8b5cf6',
    green: '#1db954',
    amber: '#f5a524',
    pink: '#ec4899',
    white: '#f4f4f5'
  };

  // --- Known Containers for Normalization & Pre-Load Fallback ---
  const KNOWN_CONTAINERS = [
    'alpha-prod-seerr',
    'alpha-prod-jellyfin',
    'alpha-prod-dashboard',
    'alpha-prod-gatekeeper',
    'alpha-prod-gluetun',
    'alpha-prod-qbittorrent',
    'alpha-prod-radarr',
    'alpha-prod-sonarr',
    'alpha-prod-prowlarr',
    'alpha-prod-tailscale',
    'alpha-prod-vpn-switcher',
    'alpha-prod-flaresolverr',
    'alpha-prod-clamav'
  ];

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

  // --- VPN Provider metadata with official brand logos ---
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

  const VALID_TABS = ['home', 'downloads', 'access', 'observability', 'vpn'];

  /**
   * Normalize legacy `sandbox-*` log container names to `alpha-prod-*` while preserving `file:*`.
   */
  function normalizeLogSource(src) {
    if (typeof src !== 'string') return 'alpha-prod-seerr';
    const trimmed = src.trim();
    if (!trimmed) return 'alpha-prod-seerr';
    if (trimmed.startsWith('file:')) return trimmed;
    return trimmed.replace(/^sandbox-/, 'alpha-prod-');
  }

  /**
   * Resolve persisted tab name, aliasing legacy `apps` to `home`.
   */
  function resolveTabName(tabId) {
    if (tabId === 'apps') return 'home';
    if (tabId === 'requests') return 'downloads';
    if (tabId === 'metrics' || tabId === 'logs') return 'observability';
    return VALID_TABS.includes(tabId) ? tabId : 'home';
  }

  const pathSlug =
    typeof window !== 'undefined'
      ? window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase()
      : '';
  const savedTab = resolveTabName(
    VALID_TABS.includes(pathSlug) ? pathSlug : localStorage.getItem('alpha_tab')
  );
  const rawStoredLogSource = localStorage.getItem('alpha_log_source');
  const initialLogSource = normalizeLogSource(rawStoredLogSource || 'alpha-prod-seerr');
  if (rawStoredLogSource && rawStoredLogSource !== initialLogSource) {
    localStorage.setItem('alpha_log_source', initialLogSource);
  }

  // --- Global Application State ---
  const state = {
    activeTab: savedTab,
    accent: 'red',
    auth: {
      checked: false,
      authenticated: false,
      username: '',
      user: null,
      mode: 'login'
    },
    sessionExpiredHandled: false,
    pings: {},
    downloads: null,
    vpn: null,
    system: null,
    logSource: initialLogSource,
    logSourcesData: { containers: [], fileLogs: [] },
    logFilter: 'all',
    logSearch: '',
    logTail: 150,
    autoScroll: true,
    lastLogsFingerprint: '',
    tailscaleIp:
      window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
        ? window.location.hostname
        : '127.0.0.1',
    metricsRange: localStorage.getItem('alpha_metrics_range') || '24h',
    metricsData: null,
    timerId: null,
    syncTick: 0,
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
    selectedReleaseIndex: null,
    // Access & Users state
    signupLibraries: [],
    accessSubtab: 'pending',
    accessHistoryFilter: 'all',
    accessUsersSearch: '',
    accessPending: [],
    accessHistory: [],
    accessUsers: [],
    adminLibraries: [],
    activeApproveRequestId: null,
    activeRejectRequestId: null
  };

  // ==============================================================================
  // SHARED UTILITIES & THEME ACCENT ENGINE
  // ==============================================================================

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
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

  function formatTimestamp(val) {
    if (!val) return '—';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function hexToRgba(hex, alpha) {
    const clean = (hex || '#e50914').replace('#', '').trim();
    const full =
      clean.length === 3
        ? clean
            .split('')
            .map((c) => c + c)
            .join('')
        : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return `rgba(229, 9, 20, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Return the active dx.bi accent hex color for UI and Canvas charts.
   */
  function getAccentColor() {
    const key = document.documentElement.dataset.dxAccent || state.accent || 'red';
    return DX_ACCENTS[key] || DX_ACCENTS.red;
  }
  window.getAccentColor = getAccentColor;

  /**
   * Apply and persist a dx.bi accent preset across DOM, CSS variables, and Metrics Canvas charts.
   * Locked permanently to 'red' per interface requirements.
   */
  function applyAccent(_accentName = 'red', rerenderCharts = true) {
    const key = 'red';
    const hex = DX_ACCENTS.red || '#e50914';
    state.accent = 'red';
    document.documentElement.dataset.dxAccent = 'red';
    document.documentElement.style.setProperty('--dx-accent', hex);
    document.documentElement.style.setProperty('--dx-accent-soft', hexToRgba(hex, 0.18));
    try {
      localStorage.setItem('dxbi.accent', 'red');
    } catch (_) {}

    document.querySelectorAll('.dx-swatch-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.accent === key);
    });

    const dotPreview = document.querySelector('#btn-accent-picker .dx-accent-dot-preview');
    if (dotPreview) dotPreview.style.background = hex;

    if (rerenderCharts && state.metricsData) {
      renderAllCharts(state.metricsData);
    }
  }
  window.applyAccent = applyAccent;

  function showToast(message, type = 'info') {
    const shelf = document.getElementById('toast-shelf');
    if (!shelf) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;
    if (type === 'error') toast.style.borderColor = 'var(--accent-rose, #f43f5e)';
    if (type === 'success') toast.style.borderColor = 'var(--accent-emerald, #10b981)';
    if (type === 'warn') toast.style.borderColor = 'var(--accent-amber, #f59e0b)';
    shelf.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3400);
  }

  /**
   * Authenticated fetch wrapper with `same-origin` credentials and graceful 401 session lock.
   */
  async function apiFetch(url, options = {}) {
    const opts = Object.assign({}, options, {
      credentials: 'same-origin'
    });
    const res = await fetch(url, opts);
    if (res.status === 401 && !options.skipAuthRedirect) {
      handleSessionExpired();
    }
    return res;
  }

  // ==============================================================================
  // AUTH GATE & SELF-SERVICE ACCESS PORTAL
  // ==============================================================================

  function stopSyncTimer() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function setAuthError(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  function updateAdminPillUI() {
    const pill = document.getElementById('admin-user-pill');
    if (pill) pill.style.display = 'none';
  }

  function switchAuthMode(mode) {
    const targetMode = ['login', 'signup', 'status'].includes(mode) ? mode : 'login';
    state.auth.mode = targetMode;

    document.querySelectorAll('.auth-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.authMode === targetMode);
    });
    document.querySelectorAll('.auth-mode-panel').forEach((panel) => {
      panel.style.display = panel.id === `auth-panel-${targetMode}` ? 'block' : 'none';
    });

    setAuthError('login-error', '');
    setAuthError('signup-error', '');

    if (targetMode === 'signup' && state.signupLibraries.length === 0) {
      loadSignupOptions();
    }
    if (targetMode === 'status') {
      const tokenInput = document.getElementById('status-token-input');
      const storedToken = localStorage.getItem('alpha_signup_status_token') || '';
      if (tokenInput && !tokenInput.value && storedToken) {
        tokenInput.value = storedToken;
      }
    }
  }

  function showAuthGate(mode = 'login', prefillToken = '') {
    const gate = document.getElementById('auth-gate');
    document.body.classList.remove('auth-pending');
    document.body.classList.add('auth-locked');
    updateAdminPillUI();
    if (gate) gate.style.display = 'flex';
    switchAuthMode(mode);

    const tokenInput = document.getElementById('status-token-input');
    const savedToken = prefillToken || localStorage.getItem('alpha_signup_status_token') || '';
    if (tokenInput && savedToken) {
      tokenInput.value = savedToken;
      if (mode === 'status') {
        checkSignupStatus(savedToken);
      }
    }
  }

  function hideAuthGate() {
    const gate = document.getElementById('auth-gate');
    document.body.classList.remove('auth-pending', 'auth-locked');
    if (gate) gate.style.display = 'none';
    updateAdminPillUI();
  }

  function handleSessionExpired() {
    if (state.sessionExpiredHandled && !state.auth.authenticated) return;
    state.sessionExpiredHandled = true;
    state.auth.authenticated = false;
    state.auth.user = null;
    stopSyncTimer();
    showAuthGate('login');
    setAuthError('login-error', 'Session expired. Please sign in again.');
  }

  function resolveInitialUrlDirective() {
    const params = new URLSearchParams(window.location.search);
    const hash = (window.location.hash || '').replace(/^#/, '').toLowerCase();
    const viewParam = (params.get('view') || params.get('mode') || '').toLowerCase();
    const tabParam = (params.get('tab') || '').toLowerCase();
    const tokenParam = params.get('token') || params.get('statusToken') || '';

    let authMode = 'login';
    if (viewParam === 'signup' || hash === 'signup') authMode = 'signup';
    else if (viewParam === 'status' || hash === 'status' || tokenParam) authMode = 'status';

    let requestedTab = null;
    const pathSlug = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    if (VALID_TABS.includes(pathSlug) || pathSlug === 'apps') {
      requestedTab = resolveTabName(pathSlug);
    } else if (VALID_TABS.includes(tabParam) || tabParam === 'apps') {
      requestedTab = resolveTabName(tabParam);
    } else if (VALID_TABS.includes(hash) || hash === 'apps') {
      requestedTab = resolveTabName(hash);
    }

    return { authMode, tokenParam, requestedTab };
  }

  async function checkInitialAuth() {
    const directive = resolveInitialUrlDirective();
    let setupRequired = false;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const me = res.ok ? await res.json().catch(() => ({})) : {};

      if (me && me.authenticated) {
        const userObj = me.user || me;
        state.auth.checked = true;
        state.auth.authenticated = true;
        state.auth.user = userObj;
        state.auth.username = userObj.username || userObj.name || 'admin';
        state.sessionExpiredHandled = false;
        hideAuthGate();
        startAuthenticatedSession(directive.requestedTab);
        return;
      }
      setupRequired = Boolean(me && me.setupRequired);
    } catch (_) {
      // Fall through to showing auth gate when auth check fails or unauthenticated
    }

    state.auth.checked = true;
    state.auth.authenticated = false;
    stopSyncTimer();
    showAuthGate(directive.authMode, directive.tokenParam);
    if (setupRequired && directive.authMode === 'login') {
      setAuthError(
        'login-error',
        'Jellyfin initial setup is not finished yet. Complete setup at :8096 before signing in.'
      );
    }
    loadSignupOptions();
  }

  async function handleAdminLogin(e) {
    e.preventDefault();
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const btn = document.getElementById('btn-admin-login');
    const username = (usernameEl?.value || '').trim();
    const password = passwordEl?.value || '';

    if (!username || !password) {
      setAuthError('login-error', 'Enter both username and password.');
      return;
    }

    setAuthError('login-error', '');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Signing In...';
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setAuthError('login-error', data.error || data.message || `Sign in failed (${res.status})`);
        return;
      }

      const userObj = data.user || data;
      state.auth.authenticated = true;
      state.auth.user = userObj;
      state.auth.username = userObj.username || username;
      state.sessionExpiredHandled = false;
      if (passwordEl) passwordEl.value = '';
      hideAuthGate();
      startAuthenticatedSession();
      showToast(`Signed in as ${state.auth.username}`, 'success');
    } catch (err) {
      setAuthError('login-error', err.message || 'Network error during sign in.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Sign In to Cockpit';
      }
    }
  }

  async function handleAdminLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } catch (_) {}

    stopSyncTimer();
    state.auth.authenticated = false;
    state.auth.user = null;
    state.auth.username = '';
    showAuthGate('login');
    showToast('Signed out', 'info');
  }

  async function loadSignupOptions() {
    const container = document.getElementById('signup-libraries');
    if (!container) return;

    try {
      const res = await fetch('/api/auth/signup-options', { credentials: 'same-origin' });
      const data = res.ok ? await res.json().catch(() => ({})) : {};
      const rawLibs = Array.isArray(data)
        ? data
        : data.libraries || data.items || data.availableLibraries || [];

      state.signupLibraries = rawLibs.map((lib) =>
        typeof lib === 'string'
          ? { id: lib, name: lib, defaultChecked: true }
          : {
              id: lib.id || lib.ItemId || lib.name || lib.Name,
              name: lib.name || lib.Name || lib.id,
              type: lib.collectionType || lib.CollectionType || '',
              defaultChecked: lib.defaultChecked !== undefined ? Boolean(lib.defaultChecked) : true
            }
      );

      if (state.signupLibraries.length === 0) {
        container.innerHTML =
          '<span class="dx-muted-hint">Libraries will be assigned upon approval.</span>';
        return;
      }

      container.innerHTML = state.signupLibraries
        .map(
          (lib) => `
          <label class="dx-check-pill">
            <input type="checkbox" name="signup-library" value="${escapeHtml(lib.id)}" ${lib.defaultChecked ? 'checked' : ''} />
            <span>${escapeHtml(lib.name)}</span>
          </label>
        `
        )
        .join('');
    } catch (_) {
      container.innerHTML =
        '<span class="dx-muted-hint">Libraries will be assigned upon approval.</span>';
    }
  }

  async function handleSignupSubmit(e) {
    e.preventDefault();
    const fullName = (document.getElementById('signup-fullname')?.value || '').trim();
    const username = (document.getElementById('signup-username')?.value || '').trim();
    const email = (document.getElementById('signup-email')?.value || '').trim();
    const password = document.getElementById('signup-password')?.value || '';
    const requestJellyfin = Boolean(document.getElementById('signup-jellyfin')?.checked);
    const requestSeerr = Boolean(document.getElementById('signup-seerr')?.checked);
    const deviceNote = (document.getElementById('signup-note')?.value || '').trim();
    const btn = document.getElementById('btn-signup-submit');

    const requestedLibraries = Array.from(
      document.querySelectorAll('#signup-libraries input[type="checkbox"]:checked')
    ).map((cb) => cb.value);

    if (!fullName || !username || !email || !password) {
      setAuthError('signup-error', 'Please fill out all required fields.');
      return;
    }
    if (password.length < 8) {
      setAuthError('signup-error', 'Password must be at least 8 characters.');
      return;
    }
    if (!requestJellyfin && !requestSeerr) {
      setAuthError('signup-error', 'Select at least one service (Jellyfin Cinema or Seerr).');
      return;
    }

    setAuthError('signup-error', '');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting Request...';
    }

    try {
      const payload = {
        fullName,
        username,
        email,
        password,
        requestedAccess: {
          jellyfin: requestJellyfin,
          seerr: requestSeerr,
          libraries: requestedLibraries,
          deviceNote
        }
      };

      const res = await fetch('/api/auth/signup-request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setAuthError(
          'signup-error',
          data.error || data.message || `Submission failed (${res.status})`
        );
        return;
      }

      const reqObj = data.request || data;
      const statusToken = data.statusToken || reqObj.statusToken || data.token || '';
      const reqId = data.id || reqObj.id || reqObj.requestId || '';

      if (statusToken) {
        localStorage.setItem('alpha_signup_status_token', statusToken);
      }

      const tokenInput = document.getElementById('status-token-input');
      if (tokenInput) tokenInput.value = statusToken;

      switchAuthMode('status');
      renderSignupStatusCard({
        id: reqId,
        statusToken,
        status: reqObj.status || 'pending',
        fullName,
        username,
        email,
        requestedAccess: reqObj.requestedAccess || {
          jellyfin: requestJellyfin,
          seerr: requestSeerr,
          libraries: requestedLibraries,
          deviceNote
        },
        submittedAt: reqObj.submittedAt || reqObj.createdAt || new Date().toISOString()
      });

      if (statusToken) {
        checkSignupStatus(statusToken);
      }
      document.getElementById('form-signup-request')?.reset();
      showToast('Access request submitted!', 'success');
    } catch (err) {
      setAuthError('signup-error', err.message || 'Network error while submitting request.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Submit Access Request';
      }
    }
  }

  async function checkSignupStatus(explicitToken) {
    const tokenInput = document.getElementById('status-token-input');
    const card = document.getElementById('signup-status-card');
    const btn = document.getElementById('btn-check-status');
    const token = (
      explicitToken ||
      tokenInput?.value ||
      localStorage.getItem('alpha_signup_status_token') ||
      ''
    ).trim();

    if (!card) return;
    if (!token) {
      card.style.display = 'block';
      card.innerHTML =
        '<div class="dx-status-empty">Enter your status token to check your onboarding status.</div>';
      return;
    }

    localStorage.setItem('alpha_signup_status_token', token);
    if (btn) btn.disabled = true;

    try {
      let res = await fetch(`/api/auth/signup-status?token=${encodeURIComponent(token)}`, {
        credentials: 'same-origin'
      });
      const contentType = res.headers.get('content-type') || '';
      if (res.status === 404 && !contentType.includes('application/json')) {
        res = await fetch(`/api/auth/signup-status/${encodeURIComponent(token)}`, {
          credentials: 'same-origin'
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        card.style.display = 'block';
        card.innerHTML = `<div class="dx-status-empty" style="color: #fb7185;">${escapeHtml(data.error || 'No access request found for that token.')}</div>`;
        return;
      }

      const reqObj = data.request || data;
      renderSignupStatusCard({ ...reqObj, statusToken: reqObj.statusToken || token });
    } catch (err) {
      card.style.display = 'block';
      card.innerHTML = `<div class="dx-status-empty" style="color: #fb7185;">Failed to check status: ${escapeHtml(err.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderSignupStatusCard(req) {
    const card = document.getElementById('signup-status-card');
    if (!card || !req) return;

    const status = String(req.status || 'pending').toLowerCase();
    const statusLabel =
      status === 'approved'
        ? 'Approved & Provisioned'
        : status === 'rejected'
          ? 'Declined'
          : 'Pending Review';
    const host = window.location.hostname || 'localhost';
    const jellyfinUrl = `http://${host}:8096`;
    const seerrUrl = `http://${host}:5055`;
    const reqId = req.id ? `#${escapeHtml(req.id)}` : 'Pending ID';
    const token = req.statusToken || localStorage.getItem('alpha_signup_status_token') || '';
    const note = req.decisionNote || req.reviewNote || req.reason || '';
    const services = extractRequestServices(req);
    const submitted = req.submittedAt || req.createdAt;
    const warnings = Array.isArray(req.warnings) ? req.warnings : [];

    card.className = `dx-status-card is-${status}`;
    card.style.display = 'flex';
    card.innerHTML = `
      <div class="signup-status-head">
        <div>
          <div style="font-size: 0.72rem; color: var(--dx-text-3, #8a8a96); font-family: var(--font-mono, monospace);">Request ${reqId}</div>
          <div style="font-size: 0.98rem; font-weight: 700; color: #fff; margin-top: 2px;">
            ${escapeHtml(req.fullName || req.username || 'Applicant')}
            ${req.username ? `<span style="font-weight: 500; color: var(--dx-text-3, #8a8a96);">@${escapeHtml(req.username)}</span>` : ''}
          </div>
        </div>
        <span class="signup-status-pill is-${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
      </div>
      ${
        token
          ? `<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); font-size: 0.75rem;">
               <span style="color: var(--dx-text-3, #8a8a96);">Status Token</span>
               <code style="color: #fff; word-break: break-all;">${escapeHtml(token)}</code>
             </div>`
          : ''
      }
      <div class="signup-status-steps">
        ${services.jf ? `<span class="signup-step-pill ${req.jellyfinProvisioned ? 'is-approved' : `is-${escapeHtml(status)}`}">Jellyfin Cinema${req.jellyfinProvisioned ? ' ✓' : ''}</span>` : ''}
        ${services.seerr ? `<span class="signup-step-pill ${req.seerrProvisioned ? 'is-approved' : `is-${escapeHtml(status)}`}">Seerr Requests${req.seerrProvisioned ? ' ✓' : ''}</span>` : ''}
        ${submitted ? `<span class="dx-muted-hint">Submitted ${escapeHtml(formatTimestamp(submitted))}</span>` : ''}
      </div>
      ${note ? `<div class="access-req-note"><strong>Review Note:</strong> ${escapeHtml(note)}</div>` : ''}
      ${
        warnings.length > 0
          ? `<div class="dx-alert is-warn">${escapeHtml(warnings.join(' · '))}</div>`
          : ''
      }
      ${
        status === 'approved'
          ? `<div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px;">
               <a href="${jellyfinUrl}" target="_blank" class="dx-btn-primary" style="text-decoration:none; flex: 1; text-align:center;">Open Jellyfin Cinema (:8096) ↗</a>
               ${services.seerr ? `<a href="${seerrUrl}" target="_blank" class="dx-btn-secondary" style="text-decoration:none;">Open Seerr (:5055) ↗</a>` : ''}
             </div>`
          : ''
      }
    `;
  }

  function setupAuthGateListeners() {
    document.querySelectorAll('.auth-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchAuthMode(btn.dataset.authMode));
    });

    document.getElementById('form-admin-login')?.addEventListener('submit', handleAdminLogin);
    document.getElementById('form-signup-request')?.addEventListener('submit', handleSignupSubmit);
    document
      .getElementById('btn-check-status')
      ?.addEventListener('click', () => checkSignupStatus());
    document.getElementById('status-token-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        checkSignupStatus();
      }
    });
    document.getElementById('btn-admin-logout')?.addEventListener('click', handleAdminLogout);
  }

  function setupAccentPicker() {
    const btn = document.getElementById('btn-accent-picker');
    const popover = document.getElementById('accent-popover');
    if (!btn || !popover) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popover.style.display !== 'none';
      popover.style.display = isOpen ? 'none' : 'block';
      btn.setAttribute('aria-expanded', String(!isOpen));
    });

    popover.querySelectorAll('.dx-swatch-btn').forEach((swatch) => {
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        applyAccent(swatch.dataset.accent, true);
        popover.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('click', (e) => {
      if (popover.style.display !== 'none' && !e.target.closest('.dx-accent-wrap')) {
        popover.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ==============================================================================
  // NAVIGATION & CORE ACTIONS
  // ==============================================================================

  window.copyLink = function (e, url) {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard
      .writeText(url)
      .then(() => showToast(`Copied to clipboard: ${url}`, 'success'))
      .catch(() => showToast('Failed to copy', 'error'));
  };

  function syncLogSourceControls(source) {
    const normalized = normalizeLogSource(source);
    const select = document.getElementById('select-log-target');
    if (select) {
      const hasMatch = Array.from(select.options).some((opt) => opt.value === normalized);
      if (!hasMatch && normalized) {
        const opt = document.createElement('option');
        opt.value = normalized;
        opt.textContent = normalized.replace(/^file:/, '');
        select.appendChild(opt);
      }
      select.value = normalized;
    }

    document.querySelectorAll('#logs-rail-sources .dx-rail-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.logSource === normalized);
    });
  }

  window.openLogsFor = function (e, containerName) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (e && e.preventDefault) e.preventDefault();
    const normalized = normalizeLogSource(containerName);
    state.logSource = normalized;
    state.lastLogsFingerprint = '';
    localStorage.setItem('alpha_log_source', normalized);
    syncLogSourceControls(normalized);
    switchView('observability');
  };

  window.restartService = async function (e, containerName) {
    e.stopPropagation();
    e.preventDefault();
    const target = normalizeLogSource(containerName);
    if (!confirm(`Restart container "${target}"?`)) return;
    showToast(`Restarting ${target}...`, 'info');
    try {
      const res = await apiFetch('/api/containers/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: target })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(`${target} restarted successfully!`, 'success');
        setTimeout(fetchPings, 1500);
      } else if (res.status !== 401) {
        showToast(data.error || 'Failed to restart container', 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  window.switchVpnTunnel = async function (profileId) {
    if (
      !confirm(
        `Switch active VPN tunnel to "${profileId}"? Running downloads will pause momentarily and resume via the new gateway.`
      )
    ) {
      return;
    }
    showToast(`Switching VPN tunnel to ${profileId}...`, 'info');
    try {
      const res = await apiFetch('/api/vpn/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileId })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(`Switched to ${profileId}!`, 'success');
        setTimeout(fetchVpnStatus, 2000);
      } else if (res.status !== 401) {
        showToast(data.error || 'Failed to switch profile', 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  window.toggleTorrentState = async function (hash, action) {
    try {
      const res = await apiFetch('/api/downloads/action', {
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

  window.switchView = function (tabId, updateHistory = true) {
    const resolved = resolveTabName(tabId);
    state.activeTab = resolved;
    localStorage.setItem('alpha_tab', resolved);

    if (updateHistory && typeof window !== 'undefined' && window.history) {
      const targetPath = `/${resolved}`;
      if (window.location.pathname !== targetPath) {
        window.history.pushState({ tab: resolved }, '', targetPath);
      }
    }

    document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === resolved);
    });

    document.querySelectorAll('.tab-pane').forEach((pane) => {
      const matches =
        pane.id === `tab-${resolved}` ||
        pane.id === `view-${resolved}` ||
        pane.dataset.tab === resolved;
      pane.classList.toggle('active', matches);
    });

    if (!state.auth.authenticated) return;

    if (resolved === 'observability') {
      fetchSystem();
      fetchMetrics(true);
      loadLogSources();
      fetchLogs();
    } else if (resolved === 'downloads') {
      fetchDownloads();
      fetchRequests(true);
    } else if (resolved === 'vpn') {
      fetchVpnStatus();
    } else if (resolved === 'home') {
      fetchSystem();
      fetchMetrics(true);
    } else if (resolved === 'access') {
      fetchAccessOverview();
    }
  };

  window.addEventListener('popstate', (e) => {
    const pathSlug = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    const targetTab =
      (e.state && e.state.tab) || (VALID_TABS.includes(pathSlug) ? pathSlug : 'home');
    window.switchView(targetTab, false);
  });

  // ==============================================================================
  // API DATA SYNC (TELEMETRY, LOGS, VPN, DOWNLOADS)
  // ==============================================================================

  async function fetchSystem() {
    try {
      const res = await apiFetch('/api/system');
      if (!res.ok) return;
      const data = await res.json();
      state.system = data;

      // Update Header Telemetry Pills
      const cpuPill = document.getElementById('val-cpu-pill');
      if (cpuPill && data.cpu) {
        cpuPill.textContent = `${Math.round(data.cpu.percentUsed ?? 0)}%`;
      }

      const gpuPill = document.getElementById('val-gpu-pill');
      if (gpuPill) {
        gpuPill.textContent = data.gpu?.model || 'VirtIO';
      }

      const ramPill = document.getElementById('val-ram-pill');
      if (ramPill && data.memory) {
        const usedGB = (data.memory.used / 1024 ** 3).toFixed(1);
        const totalGB = Math.round(data.memory.total / 1024 ** 3);
        ramPill.textContent = `${usedGB}/${totalGB} GB`;
      }

      if (data.disk && data.disk.totalBytes > 0) {
        const freeGB = Math.round(data.disk.freeBytes / 1024 ** 3);
        const totalGB = Math.round(data.disk.totalBytes / 1024 ** 3);
        const freeEl = document.getElementById('val-storage-free');
        const fillEl = document.getElementById('val-storage-fill');
        if (freeEl) freeEl.textContent = `${freeGB} GB Free`;
        if (fillEl) fillEl.style.width = `${data.disk.percentUsed}%`;
      }

      // Update Observability Hardware Grid Cards
      const obsCpuVal = document.getElementById('obs-cpu-val');
      const obsCpuSub = document.getElementById('obs-cpu-sub');
      const obsCpuBar = document.getElementById('obs-cpu-bar');
      const obsCpuLoad = document.getElementById('obs-cpu-load');
      if (obsCpuVal && data.cpu) {
        const cpuPct = Math.round(data.cpu.percentUsed ?? 0);
        obsCpuVal.textContent = `${cpuPct}%`;
        if (obsCpuSub)
          obsCpuSub.textContent = `${data.cpu.cores || 4} Cores · ${data.cpu.model || 'ARM64'}`;
        if (obsCpuBar) obsCpuBar.style.width = `${Math.min(100, cpuPct)}%`;
        if (obsCpuLoad && Array.isArray(data.cpu.loadAvg))
          obsCpuLoad.textContent = data.cpu.loadAvg.join(', ');
      }

      const obsGpuVal = document.getElementById('obs-gpu-val');
      const obsGpuSub = document.getElementById('obs-gpu-sub');
      const obsGpuTrans = document.getElementById('obs-gpu-transcode');
      if (obsGpuVal && data.gpu) {
        obsGpuVal.textContent = data.gpu.model || 'VirtIO GPU';
        if (obsGpuSub)
          obsGpuSub.textContent = `${data.gpu.vendor || 'Red Hat'} · ${data.gpu.drmNode || 'renderD128'}`;
        if (obsGpuTrans)
          obsGpuTrans.textContent = `Transcode: ${data.gpu.transcode || 'CPU Multi-thread fallback'}`;
      }

      const obsRamVal = document.getElementById('obs-ram-val');
      const obsRamSub = document.getElementById('obs-ram-sub');
      const obsRamBar = document.getElementById('obs-ram-bar');
      const obsRamFree = document.getElementById('obs-ram-free');
      if (obsRamVal && data.memory) {
        const usedGB = (data.memory.used / 1024 ** 3).toFixed(1);
        const totalGB = (data.memory.total / 1024 ** 3).toFixed(1);
        const freeGB = (data.memory.free / 1024 ** 3).toFixed(1);
        obsRamVal.textContent = `${usedGB} / ${totalGB} GB`;
        if (obsRamSub) obsRamSub.textContent = `${data.memory.percentUsed}% System RAM allocated`;
        if (obsRamBar) obsRamBar.style.width = `${data.memory.percentUsed}%`;
        if (obsRamFree) obsRamFree.textContent = `${freeGB} GB Free`;
      }

      const obsStorageVal = document.getElementById('obs-storage-val');
      const obsStorageSub = document.getElementById('obs-storage-sub');
      const obsStorageBar = document.getElementById('obs-storage-bar');
      const obsStorageMount = document.getElementById('obs-storage-mount');
      if (obsStorageVal && data.disk && data.disk.totalBytes > 0) {
        const freeGB = Math.round(data.disk.freeBytes / 1024 ** 3);
        const totalGB = Math.round(data.disk.totalBytes / 1024 ** 3);
        obsStorageVal.textContent = `${freeGB} GB Free / ${totalGB} GB`;
        if (obsStorageSub)
          obsStorageSub.textContent = `Pool Utilization: ${data.disk.percentUsed}% Used`;
        if (obsStorageBar) obsStorageBar.style.width = `${data.disk.percentUsed}%`;
        if (obsStorageMount)
          obsStorageMount.textContent = `Mount: ${data.disk.mount || '/media/alpha'}`;
      }
    } catch (_) {}
  }

  async function fetchPings() {
    try {
      const res = await apiFetch('/api/pings');
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

  async function fetchDownloads() {
    try {
      const res = await apiFetch('/api/downloads');
      if (!res.ok) return;
      const data = await res.json();
      state.downloads = data;

      const dlRate = document.getElementById('dl-rate-val');
      const upRate = document.getElementById('up-rate-val');
      const dlSession = document.getElementById('dl-session-val');
      const guard = document.getElementById('tunnel-guard-val');
      const badgeDl = document.getElementById('badge-downloads');

      if (data.transfer) {
        if (dlRate) dlRate.textContent = formatSpeed(data.transfer.downloadSpeed);
        if (upRate) upRate.textContent = formatSpeed(data.transfer.uploadSpeed);
        if (dlSession) {
          dlSession.textContent = `Session: ${formatBytes(data.transfer.totalDownloaded)}`;
        }
        if (guard) {
          guard.textContent =
            data.transfer.connectionStatus === 'connected' ? 'Protected' : 'Firewalled';
        }
      }

      const torrentsCount = (data.torrents || []).length;
      if (badgeDl) {
        badgeDl.textContent = torrentsCount;
        badgeDl.style.display = torrentsCount > 0 ? 'inline-flex' : 'none';
      }

      renderTorrents(data.torrents || []);
      renderSeerrQueue(data.seerrRequests || []);
    } catch (_) {}
  }

  async function fetchVpnStatus() {
    try {
      const res = await apiFetch('/api/vpn/status');
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
      if (actDesc) {
        actDesc.textContent = `${data.description} · ${data.organization || 'VPN Gateway'}`;
      }
      if (actIp) actIp.textContent = data.public_ip;
      if (actCountry) {
        actCountry.textContent = `${data.ip_country} (${data.tier?.toUpperCase() || 'FREE'})`;
      }
      if (tunnelSub) {
        tunnelSub.textContent = `Egress: ${data.public_ip} (${data.display_name || data.active_profile})`;
      }

      renderVpnCards(data.active_profile);
    } catch (_) {}
  }

  function renderTerminalError(screen, title, detail, showDefaultFallback = false) {
    state.lastLogsFingerprint = '';
    screen.innerHTML = `
      <div style="color: #fda4af; text-align: center; padding: 40px 24px;">
        <div style="font-size: 0.95rem; font-weight: 700; color: #f43f5e; margin-bottom: 6px;">${escapeHtml(title)}</div>
        <div style="font-size: 0.82rem; color: #a1a1aa; max-width: 520px; margin: 0 auto 16px auto;">${escapeHtml(detail)}</div>
        <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
          <button type="button" class="req-action-btn primary" onclick="fetchLogs()">Retry Stream</button>
          ${
            showDefaultFallback
              ? '<button type="button" class="req-action-btn" onclick="openLogsFor(event, \'alpha-prod-seerr\')">Switch to alpha-prod-seerr</button>'
              : ''
          }
        </div>
      </div>
    `;
  }

  async function fetchLogs() {
    const source = normalizeLogSource(state.logSource);
    state.logSource = source;
    const isFile = source.startsWith('file:');
    const container = isFile ? source.replace(/^file:/, '') : source;
    const tail = state.logTail;
    const filter = state.logFilter;

    const screen = document.getElementById('terminal-screen');
    if (!screen) return;

    try {
      const url = `/api/logs/stream?container=${encodeURIComponent(container)}&tail=${tail}&filter=${filter}&type=${isFile ? 'file' : 'container'}`;
      const res = await apiFetch(url);
      if (res.status === 401) {
        state.lastLogsFingerprint = '';
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        if (res.status === 404) {
          renderTerminalError(
            screen,
            `Log source "${container}" not found (404)`,
            data.error ||
              'This container or log file does not exist or is not running yet. Select an active source from the left rail.',
            container !== 'alpha-prod-seerr'
          );
          return;
        }
        if (res.status === 503) {
          renderTerminalError(
            screen,
            'Log stream backend unavailable (503)',
            data.error ||
              'Container runtime / Podman socket is temporarily unreachable. Verify service status and retry.'
          );
          return;
        }
        renderTerminalError(
          screen,
          `Failed to load logs${res.ok ? '' : ` (HTTP ${res.status})`}`,
          data.error || `Unexpected response from log stream for "${container}".`
        );
        return;
      }

      let lines = Array.isArray(data.lines) ? data.lines : [];
      if (state.logSearch) {
        const query = state.logSearch.toLowerCase();
        lines = lines.filter((l) => (l.text || '').toLowerCase().includes(query));
      }

      const errBadge = document.getElementById('badge-err');
      const errCount = lines.filter((l) => l.level === 'error').length;
      if (errBadge) {
        errBadge.textContent = errCount;
        errBadge.style.display = errCount > 0 ? 'inline-flex' : 'none';
      }

      if (lines.length === 0) {
        // Always clear fingerprint before returning early so switching filters never gets stuck
        state.lastLogsFingerprint = '';
        screen.innerHTML = `
          <div style="color: var(--text-muted, #8a8a96); text-align: center; padding: 48px;">
            No log entries found for filter [${escapeHtml(filter.toUpperCase())}]${state.logSearch ? ` matching "${escapeHtml(state.logSearch)}"` : ''}.
          </div>
        `;
        return;
      }

      const lastLine = lines[lines.length - 1]?.text || '';
      const logsFingerprint = `${container}_${tail}_${filter}_${lines.length}_${lastLine}_${state.logSearch}`;
      if (logsFingerprint === state.lastLogsFingerprint) {
        return;
      }
      state.lastLogsFingerprint = logsFingerprint;

      let html = '';
      lines.forEach((l) => {
        const isErr = l.level === 'error';
        const isWrn = l.level === 'warn';
        const rowClass = isErr ? 'row-error' : '';
        const badgeClass = isErr ? 'badge-err' : isWrn ? 'badge-wrn' : 'badge-inf';

        html += `
          <div class="terminal-row ${rowClass}">
            <span class="terminal-badge ${badgeClass}">${escapeHtml(l.level)}</span>
            <span style="color: ${isErr ? '#fda4af' : '#d4d4d8'}; word-break: break-all; white-space: pre-wrap;">${escapeHtml(l.text)}</span>
          </div>
        `;
      });

      screen.innerHTML = html;
      if (state.autoScroll) {
        screen.scrollTop = screen.scrollHeight;
      }
    } catch (err) {
      renderTerminalError(
        screen,
        'Log stream connection failed',
        err.message || 'Unable to reach log streaming endpoint.'
      );
    }
  }
  window.fetchLogs = fetchLogs;

  function renderLogsRail(containers, fileLogs) {
    const rail = document.getElementById('logs-rail-sources');
    if (!rail) return;

    const current = normalizeLogSource(state.logSource);
    let html = '';

    if (containers.length > 0) {
      html += '<div class="dx-rail-group-label">Containers</div>';
      html += containers
        .map(
          (c) => `
          <button
            type="button"
            class="dx-rail-btn ${current === c ? 'active' : ''}"
            data-log-source="${escapeHtml(c)}"
          >
            <span class="dx-rail-dot"></span>
            <span class="dx-rail-text">${escapeHtml(c)}</span>
          </button>
        `
        )
        .join('');
    }

    if (fileLogs.length > 0) {
      html += '<div class="dx-rail-group-label">Daemon Logs</div>';
      html += fileLogs
        .map((f) => {
          const val = `file:${f}`;
          return `
            <button
              type="button"
              class="dx-rail-btn ${current === val ? 'active' : ''}"
              data-log-source="${escapeHtml(val)}"
            >
              <span class="dx-rail-dot"></span>
              <span class="dx-rail-text">${escapeHtml(f)}</span>
            </button>
          `;
        })
        .join('');
    }

    rail.innerHTML = html || '<div class="dx-muted-hint">No log sources available.</div>';

    rail.querySelectorAll('.dx-rail-btn[data-log-source]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextSource = normalizeLogSource(btn.dataset.logSource);
        state.logSource = nextSource;
        state.lastLogsFingerprint = '';
        localStorage.setItem('alpha_log_source', nextSource);
        syncLogSourceControls(nextSource);
        fetchLogs();
      });
    });
  }

  async function loadLogSources() {
    try {
      const res = await apiFetch('/api/logs/sources');
      if (!res.ok) return;
      const data = await res.json();
      const select = document.getElementById('select-log-target');

      const containers =
        Array.isArray(data.containers) && data.containers.length > 0
          ? data.containers
          : KNOWN_CONTAINERS;
      const fileLogs = Array.isArray(data.fileLogs) ? data.fileLogs : [];
      state.logSourcesData = { containers, fileLogs };

      if (select) {
        let html = '';
        if (containers.length > 0) {
          html += '<optgroup label="Server Containers">';
          containers.forEach((c) => {
            html += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`;
          });
          html += '</optgroup>';
        }
        if (fileLogs.length > 0) {
          html += '<optgroup label="System Daemon Logs">';
          fileLogs.forEach((f) => {
            html += `<option value="file:${escapeHtml(f)}">${escapeHtml(f)}</option>`;
          });
          html += '</optgroup>';
        }
        select.innerHTML = html;
      }

      const normalized = normalizeLogSource(state.logSource);
      state.logSource = normalized;
      localStorage.setItem('alpha_log_source', normalized);

      renderLogsRail(containers, fileLogs);
      syncLogSourceControls(normalized);
    } catch (_) {}
  }
  window.loadLogSources = loadLogSources;

  // ==============================================================================
  // RENDERING COMPONENTS (HOME, DOWNLOADS, VPN)
  // ==============================================================================

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

  function renderAppGrid() {
    const container = document.getElementById('apps-container');
    if (!container) return;

    if (container.children.length > 0) {
      updatePingsUI();
      return;
    }

    let html = '';
    APP_CATALOG.forEach((cat) => {
      html += `
        <div class="section-category">
          <div class="section-category-title">${escapeHtml(cat.category)}</div>
          <div class="app-grid">
      `;

      cat.items.forEach((item) => {
        const ping = state.pings[item.id];
        const isOnline = ping && ping.status === 'healthy';
        const latencyText = ping && ping.latencyMs !== null ? `${ping.latencyMs}ms` : 'Checking';
        const dotClass = isOnline ? 'dot-status-healthy' : 'dot-status-down';

        const host = window.location.hostname || 'localhost';
        const openUrl = item.path
          ? `http://${host}:${item.port}${item.path}`
          : `http://${host}:${item.port}`;
        const tsUrl = item.path
          ? `http://${state.tailscaleIp}:${item.port}${item.path}`
          : `http://${state.tailscaleIp}:${item.port}`;

        html += `
          <div class="app-card" onclick="window.open('${openUrl}', '_blank')">
            <div class="app-card-top">
              <div class="app-icon-wrap">
                <img class="app-icon-img" src="${item.icon}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.style.display='none'">
              </div>
              <div class="app-details">
                <div class="app-name">${escapeHtml(item.name)}</div>
                <div class="app-desc">${escapeHtml(item.desc)}</div>
              </div>
            </div>

            <div class="app-card-bottom">
              <div class="latency-indicator">
                <span class="${dotClass}"></span>
                <span id="ping-${item.id}">${isOnline ? `Online · ${latencyText}` : 'Checking'}</span>
              </div>

              <div class="app-actions">
                <button class="btn-card-action" onclick="copyLink(event, '${tsUrl}')" title="Copy Mobile Tailscale Link (${tsUrl})">📱</button>
                <button class="btn-card-action" onclick="openLogsFor(event, '${item.container}')" title="Inspect Container Logs">📜</button>
                <button class="btn-card-action" onclick="restartService(event, '${item.container}')" title="1-Click Restart Container">⟳</button>
              </div>
            </div>
          </div>
        `;
      });

      html += '</div></div>';
    });

    container.innerHTML = html;
  }

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
      const isPaused = (t.state || '').includes('paused');
      html += `
        <div class="torrent-item">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div style="font-size: 0.92rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${escapeHtml(t.name)}
            </div>
            <span style="font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; background: rgba(56, 189, 248, 0.12); color: var(--accent-sky); font-weight: 700; text-transform: uppercase;">
              ${escapeHtml(t.category || 'general')}
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
              <button class="btn-card-action" style="width: auto; padding: 2px 8px; font-size: 0.75rem;" onclick="toggleTorrentState('${escapeHtml(t.hash)}', '${isPaused ? 'resume' : 'pause'}')">
                ${isPaused ? 'Resume' : 'Pause'}
              </button>
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

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
            <strong style="color: #fff;">Request #${escapeHtml(r.id)} (${escapeHtml(r.type)})</strong>
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

  function renderVpnCards(activeProfile) {
    const grid = document.getElementById('vpn-cards-grid');
    if (!grid) return;
    if (grid.children.length > 0 && state.lastVpnProfile === activeProfile) {
      return;
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
                <img src="${p.icon}" style="width: 28px; height: 28px; object-fit: contain; border-radius: 6px;" alt="${escapeHtml(p.name)}">
                <div style="font-size: 1.05rem; font-weight: 600; color: #fff;">${escapeHtml(p.name)}</div>
              </div>
              <span style="font-size: 0.68rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.08);">
                ${escapeHtml(p.tier)}
              </span>
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
              ${escapeHtml(p.desc)}
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
  // ADMIN ACCESS REQUESTS & USERS DIRECTORY (#view-access)
  // ==============================================================================

  function switchAccessSubtab(subtab) {
    const target = ['pending', 'history', 'users'].includes(subtab) ? subtab : 'pending';
    state.accessSubtab = target;

    document.querySelectorAll('.dx-rail-btn[data-access-subtab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.accessSubtab === target);
    });
    document.querySelectorAll('.dx-access-subpanel').forEach((panel) => {
      panel.style.display = panel.id === `access-subpanel-${target}` ? 'block' : 'none';
    });

    if (target === 'users' && state.accessUsers.length === 0) {
      fetchAccessUsers();
    }
  }

  function resolveLibraryNames(libIds) {
    if (!Array.isArray(libIds) || libIds.length === 0) return [];
    const lookup = new Map(
      (state.adminLibraries || []).map((l) => [String(l.id), l.name || String(l.id)])
    );
    return libIds.map((entry) => {
      if (entry && typeof entry === 'object') return entry.name || entry.id || '';
      return lookup.get(String(entry)) || String(entry);
    });
  }

  function updateAccessCounters() {
    const pendingCount = state.accessPending.length;
    const approvedCount = state.accessHistory.filter(
      (r) => String(r.status || '').toLowerCase() === 'approved'
    ).length;
    const usersCount = state.accessUsers.length;

    const badge = document.getElementById('badge-access');
    if (badge) {
      badge.textContent = pendingCount;
      badge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
    }

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setVal('access-rail-pending-count', pendingCount);
    setVal('access-rail-history-count', state.accessHistory.length);
    setVal('access-rail-users-count', usersCount);
    setVal('access-stat-pending', pendingCount);
    setVal('access-stat-approved', approvedCount);
    setVal('access-stat-jf-users', usersCount);
  }

  async function fetchAdminLibraries() {
    try {
      const res = await apiFetch('/api/admin/libraries');
      if (!res.ok) return state.adminLibraries;
      const data = await res.json().catch(() => ({}));
      const raw = Array.isArray(data) ? data : data.libraries || data.items || [];
      state.adminLibraries = raw.map((lib) =>
        typeof lib === 'string'
          ? { id: lib, name: lib }
          : {
              id: lib.id || lib.ItemId || lib.name || lib.Name,
              name: lib.name || lib.Name || lib.id
            }
      );
      return state.adminLibraries;
    } catch (_) {
      return state.adminLibraries;
    }
  }

  async function fetchAccessRequests() {
    try {
      const res = await apiFetch('/api/admin/access-requests');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));

      if (Array.isArray(data.pending) || Array.isArray(data.history)) {
        state.accessPending = Array.isArray(data.pending) ? data.pending : [];
        state.accessHistory = Array.isArray(data.history) ? data.history : [];
      } else {
        const all = Array.isArray(data) ? data : data.requests || data.items || [];
        state.accessPending = all.filter(
          (r) => String(r.status || 'pending').toLowerCase() === 'pending'
        );
        state.accessHistory = all.filter(
          (r) => String(r.status || 'pending').toLowerCase() !== 'pending'
        );
      }

      updateAccessCounters();
      renderAccessPending();
      renderAccessHistory();
    } catch (_) {}
  }

  async function fetchAccessUsers() {
    try {
      const res = await apiFetch('/api/admin/users');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const raw = Array.isArray(data) ? data : data.users || data.items || [];
      state.accessUsers = raw;
      updateAccessCounters();
      renderAccessUsers();
    } catch (_) {}
  }

  async function fetchAccessOverview() {
    await Promise.all([fetchAdminLibraries(), fetchAccessRequests(), fetchAccessUsers()]);
  }

  function extractRequestServices(req) {
    const ra = req && typeof req.requestedAccess === 'object' ? req.requestedAccess : {};
    const jf =
      ra.jellyfin ??
      req.requestJellyfin ??
      req.grantJellyfin ??
      req.services?.jellyfin ??
      (Array.isArray(req.requestedServices) && req.requestedServices.includes('jellyfin'));
    const seerr =
      ra.seerr ??
      req.requestSeerr ??
      req.grantSeerr ??
      req.services?.seerr ??
      (Array.isArray(req.requestedServices) && req.requestedServices.includes('seerr'));
    return { jf: Boolean(jf), seerr: Boolean(seerr) };
  }

  function extractRequestLibraries(req) {
    const ra = req && typeof req.requestedAccess === 'object' ? req.requestedAccess : {};
    if (Array.isArray(ra.libraries)) return ra.libraries;
    if (Array.isArray(req.requestedLibraries)) return req.requestedLibraries;
    if (Array.isArray(req.libraries)) return req.libraries;
    return [];
  }

  function extractRequestNote(req) {
    const ra = req && typeof req.requestedAccess === 'object' ? req.requestedAccess : {};
    return ra.deviceNote || req.deviceNote || req.note || req.reason || '';
  }

  function renderAccessPending() {
    const container = document.getElementById('access-pending-list');
    if (!container) return;

    if (state.accessPending.length === 0) {
      container.innerHTML =
        '<div class="dx-empty-card">No pending access requests in the queue.</div>';
      return;
    }

    container.innerHTML = state.accessPending
      .map((req) => {
        const services = extractRequestServices(req);
        const libs = resolveLibraryNames(extractRequestLibraries(req));
        const note = extractRequestNote(req);
        const ip = req.clientIp || req.ip || req.ipAddress || '';
        const submitted = req.submittedAt || req.createdAt || req.requestedAt;

        return `
          <div class="access-req-card">
            <div class="access-req-header">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <strong style="color: #fff; font-size: 0.98rem;">${escapeHtml(req.fullName || req.name || req.username || 'Applicant')}</strong>
                  <span class="dx-muted-hint">@${escapeHtml(req.username || 'unknown')}</span>
                </div>
                <div class="access-req-meta" style="margin-top: 3px;">
                  <span>${escapeHtml(req.email || 'No email provided')}</span>
                  <span>Submitted: ${escapeHtml(formatTimestamp(submitted))}</span>
                  ${ip ? `<span>IP: <code>${escapeHtml(ip)}</code></span>` : ''}
                </div>
              </div>
              <span class="status-badge is-pending">Pending</span>
            </div>

            <div class="access-req-chips">
              ${services.jf ? '<span class="access-chip" style="border-color: var(--dx-accent); color: #fff;">Jellyfin Cinema</span>' : ''}
              ${services.seerr ? '<span class="access-chip" style="border-color: rgba(56,189,248,0.45); color: #7dd3fc;">Seerr Requests</span>' : ''}
              ${libs.map((l) => `<span class="access-chip">${escapeHtml(l)}</span>`).join('')}
            </div>

            ${
              note
                ? `<div class="access-req-note"><strong>Device / Reason Note:</strong> ${escapeHtml(note)}</div>`
                : ''
            }

            <div class="access-req-actions">
              <button type="button" class="dx-btn-primary dx-btn-sm" data-action="approve" data-req-id="${escapeHtml(req.id)}">Accept &amp; Provision</button>
              <button type="button" class="dx-btn-danger dx-btn-sm" data-action="reject" data-req-id="${escapeHtml(req.id)}">Decline</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderAccessHistory() {
    const container = document.getElementById('access-history-list');
    if (!container) return;

    const filter = state.accessHistoryFilter || 'all';
    const items = state.accessHistory.filter((r) => {
      const st = String(r.status || '').toLowerCase();
      if (filter === 'approved') return st === 'approved';
      if (filter === 'rejected') return st === 'rejected';
      return true;
    });

    if (items.length === 0) {
      container.innerHTML = `<div class="dx-empty-card">No ${filter === 'all' ? 'reviewed' : escapeHtml(filter)} access requests found.</div>`;
      return;
    }

    container.innerHTML = items
      .map((req) => {
        const st = String(req.status || 'approved').toLowerCase();
        const services = extractRequestServices(req);
        const note = req.decisionNote || req.reviewNote || req.reason || '';
        const provisionedJf = req.provisioned?.jellyfin ?? Boolean(req.jellyfinUserId);
        const provisionedSeerr = req.provisioned?.seerr ?? Boolean(req.seerrUserId);
        const warnings = [];
        if (req.seerrProvisionError) warnings.push(req.seerrProvisionError);
        if (Array.isArray(req.warnings)) warnings.push(...req.warnings);

        return `
          <div class="access-req-card">
            <div class="access-req-header">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <strong style="color: #fff; font-size: 0.96rem;">${escapeHtml(req.fullName || req.name || req.username || 'Applicant')}</strong>
                  <span class="dx-muted-hint">@${escapeHtml(req.username || 'unknown')}</span>
                </div>
                <div class="access-req-meta" style="margin-top: 3px;">
                  ${req.email ? `<span>${escapeHtml(req.email)}</span>` : ''}
                  <span>Reviewed: ${escapeHtml(formatTimestamp(req.reviewedAt || req.updatedAt || req.submittedAt || req.createdAt))}</span>
                  ${req.reviewedBy ? `<span>By: <strong>${escapeHtml(req.reviewedBy)}</strong></span>` : ''}
                </div>
              </div>
              <span class="status-badge is-${escapeHtml(st)}">${st === 'approved' ? 'Approved' : 'Declined'}</span>
            </div>

            <div class="access-req-chips">
              ${provisionedJf || (st === 'approved' && services.jf && req.grantedOptions?.grantJellyfin !== false) ? '<span class="access-chip" style="border-color: rgba(70,211,105,0.4); color: var(--dx-green, #46d369);">Jellyfin Provisioned</span>' : ''}
              ${provisionedSeerr ? '<span class="access-chip" style="border-color: rgba(56,189,248,0.45); color: #7dd3fc;">Seerr Provisioned</span>' : ''}
              ${services.seerr && st === 'approved' && !provisionedSeerr && req.grantedOptions?.grantSeerr ? '<span class="access-chip" style="border-color: rgba(245,197,24,0.4); color: var(--dx-warn, #f5c518);">Seerr Skipped / Warning</span>' : ''}
            </div>

            ${note ? `<div class="access-req-note"><strong>Decision Note:</strong> ${escapeHtml(note)}</div>` : ''}
            ${warnings.length > 0 ? `<div class="dx-alert is-warn">${escapeHtml(Array.from(new Set(warnings)).join(' · '))}</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  function renderAccessUsers() {
    const container = document.getElementById('access-users-list');
    if (!container) return;

    const search = (state.accessUsersSearch || '').toLowerCase().trim();
    const list = state.accessUsers.filter((u) => {
      if (!search) return true;
      const name = (u.username || u.name || u.Name || '').toLowerCase();
      const email = (u.email || u.seerrUser?.email || '').toLowerCase();
      return name.includes(search) || email.includes(search);
    });

    if (list.length === 0) {
      container.innerHTML = '<div class="dx-empty-card">No users match the filter.</div>';
      return;
    }

    container.innerHTML = list
      .map((user) => {
        const uid = user.id || user.jellyfinId || user.userId || user.Id;
        const username = user.username || user.name || user.Name || 'Unknown';
        const email = user.email || user.seerrUser?.email || '';
        const isAdmin = Boolean(user.isAdmin ?? user.Policy?.IsAdministrator);
        const isDisabled = Boolean(user.isDisabled ?? user.disabled ?? user.Policy?.IsDisabled);
        const hasSeerr = Boolean(user.hasSeerr || user.seerrId || user.seerrUser);
        const isProtected = Boolean(
          user.isPrimaryAdmin ||
          user.isCurrentUser ||
          user.protected ||
          isAdmin ||
          username === state.auth.username
        );

        return `
          <div class="access-user-row">
            <div style="min-width: 0; flex: 1;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong style="color: #fff; font-size: 0.95rem;">${escapeHtml(username)}</strong>
                ${isAdmin ? '<span class="status-badge is-admin">Admin</span>' : ''}
                ${hasSeerr ? '<span class="status-badge" style="color: #7dd3fc; border-color: rgba(56,189,248,0.35);">Seerr</span>' : ''}
                ${isDisabled ? '<span class="status-badge is-disabled">Disabled</span>' : '<span class="status-badge is-approved">Active</span>'}
              </div>
              <div class="access-req-meta" style="margin-top: 4px;">
                <span>${email ? escapeHtml(email) : 'Jellyfin Local User'}</span>
                ${user.maxActiveSessions ? `<span>Max streams: ${escapeHtml(user.maxActiveSessions)}</span>` : ''}
                ${user.lastActivityDate || user.lastSeen ? `<span>Last active: ${escapeHtml(formatTimestamp(user.lastActivityDate || user.lastSeen))}</span>` : ''}
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
              ${
                isProtected
                  ? '<span class="dx-muted-hint">Protected Primary/Admin</span>'
                  : `
                    <button type="button" class="dx-btn-secondary dx-btn-sm" data-user-action="toggle" data-user-id="${escapeHtml(uid)}" data-user-disabled="${isDisabled ? '1' : '0'}">
                      ${isDisabled ? 'Enable' : 'Disable'}
                    </button>
                    <button type="button" class="dx-btn-danger dx-btn-sm" data-user-action="delete" data-user-id="${escapeHtml(uid)}" data-username="${escapeHtml(username)}">
                      Delete
                    </button>
                  `
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderApproveLibrariesList(requestedLibs = []) {
    const container = document.getElementById('approve-libraries-list');
    const allCheckbox = document.getElementById('approve-all-libraries');
    if (!container) return;

    const reqSet = new Set((requestedLibs || []).map((v) => String(v)));
    const libs = state.adminLibraries || [];
    if (libs.length === 0) {
      container.innerHTML =
        '<span class="dx-muted-hint">No specific Jellyfin libraries listed; check "Grant All Libraries" or confirm defaults.</span>';
      if (allCheckbox) allCheckbox.checked = true;
      return;
    }

    const disableBoxes = Boolean(allCheckbox?.checked);
    container.innerHTML = libs
      .map((lib) => {
        const checked =
          disableBoxes ||
          reqSet.size === 0 ||
          reqSet.has(String(lib.id)) ||
          reqSet.has(String(lib.name));
        return `
          <label class="dx-check-pill">
            <input type="checkbox" name="approve-library" value="${escapeHtml(lib.id)}" ${checked ? 'checked' : ''} ${disableBoxes ? 'disabled' : ''} />
            <span>${escapeHtml(lib.name)}</span>
          </label>
        `;
      })
      .join('');
  }

  async function openApproveModal(reqId) {
    const req = state.accessPending.find((r) => String(r.id) === String(reqId));
    if (!req) return;

    state.activeApproveRequestId = req.id;
    const services = extractRequestServices(req);
    const reqNote = extractRequestNote(req);

    const summaryEl = document.getElementById('approve-req-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div><strong>${escapeHtml(req.fullName || req.username)}</strong> <span class="dx-muted-hint">@${escapeHtml(req.username)}</span></div>
        <div class="dx-muted-hint">${escapeHtml(req.email || '')}${reqNote ? ` · ${escapeHtml(reqNote)}` : ''}</div>
      `;
    }

    const jfBox = document.getElementById('approve-grant-jellyfin');
    const seerrBox = document.getElementById('approve-grant-seerr');
    const allLibsBox = document.getElementById('approve-all-libraries');
    const maxStreamsEl = document.getElementById('approve-max-streams');
    const autoApproveEl = document.getElementById('approve-seerr-autoapprove');
    const noteEl = document.getElementById('approve-note');

    if (jfBox) jfBox.checked = services.jf;
    if (seerrBox) seerrBox.checked = services.seerr;
    if (allLibsBox) allLibsBox.checked = false;
    if (maxStreamsEl) maxStreamsEl.value = '2';
    if (autoApproveEl) autoApproveEl.checked = false;
    if (noteEl) noteEl.value = '';

    const modal = document.getElementById('access-approve-modal');
    if (modal) modal.style.display = 'flex';

    await fetchAdminLibraries();
    renderApproveLibrariesList(extractRequestLibraries(req));
  }

  window.closeApproveModal = function () {
    const modal = document.getElementById('access-approve-modal');
    if (modal) modal.style.display = 'none';
    state.activeApproveRequestId = null;
  };

  function openRejectModal(reqId) {
    const req = state.accessPending.find((r) => String(r.id) === String(reqId));
    if (!req) return;

    state.activeRejectRequestId = req.id;
    const summaryEl = document.getElementById('reject-req-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div>Decline access request from <strong>${escapeHtml(req.fullName || req.username)}</strong> (@${escapeHtml(req.username)})?</div>
        <div class="dx-muted-hint">${escapeHtml(req.email || '')}</div>
      `;
    }
    const reasonEl = document.getElementById('reject-reason-input');
    if (reasonEl) reasonEl.value = '';

    const modal = document.getElementById('access-reject-modal');
    if (modal) modal.style.display = 'flex';
  }

  window.closeRejectModal = function () {
    const modal = document.getElementById('access-reject-modal');
    if (modal) modal.style.display = 'none';
    state.activeRejectRequestId = null;
  };

  async function confirmApproveRequest() {
    const id = state.activeApproveRequestId;
    if (!id) return;

    const btn = document.getElementById('btn-confirm-approve');
    const grantJellyfin = Boolean(document.getElementById('approve-grant-jellyfin')?.checked);
    const grantSeerr = Boolean(document.getElementById('approve-grant-seerr')?.checked);
    const enableAllLibraries = Boolean(document.getElementById('approve-all-libraries')?.checked);
    const maxStreams =
      parseInt(document.getElementById('approve-max-streams')?.value || '2', 10) || 2;
    const seerrAutoApprove = Boolean(document.getElementById('approve-seerr-autoapprove')?.checked);
    const note = (document.getElementById('approve-note')?.value || '').trim();
    const enabledLibraries = Array.from(
      document.querySelectorAll('#approve-libraries-list input[type="checkbox"]:checked')
    ).map((cb) => cb.value);

    if (!grantJellyfin && !grantSeerr) {
      showToast('Select at least one service to provision.', 'error');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Provisioning...';
    }

    try {
      const res = await apiFetch(`/api/admin/access-requests/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantJellyfin,
          grantSeerr,
          enableAllLibraries,
          enabledFolderIds: enableAllLibraries ? [] : enabledLibraries,
          maxConcurrentStreams: maxStreams,
          seerrAutoApprove,
          decisionNote: note
        })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status !== 401) showToast(data.error || 'Failed to approve request', 'error');
        return;
      }

      window.closeApproveModal();
      showToast(data.message || 'User approved and provisioned!', 'success');

      const warnings = [];
      if (data.seerrWarning) warnings.push(data.seerrWarning);
      if (data.seerrProvisionError) warnings.push(data.seerrProvisionError);
      if (data.warning) warnings.push(data.warning);
      if (Array.isArray(data.warnings)) warnings.push(...data.warnings);
      if (warnings.length > 0) {
        showToast(`Seerr warning: ${Array.from(new Set(warnings)).join(' · ')}`, 'warn');
      }

      await fetchAccessOverview();
    } catch (err) {
      showToast(`Approval error: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Accept & Provision';
      }
    }
  }

  async function confirmRejectRequest() {
    const id = state.activeRejectRequestId;
    if (!id) return;

    const btn = document.getElementById('btn-confirm-reject');
    const reason = (document.getElementById('reject-reason-input')?.value || '').trim();

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Declining...';
    }

    try {
      const res = await apiFetch(`/api/admin/access-requests/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisionNote: reason })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status !== 401) showToast(data.error || 'Failed to decline request', 'error');
        return;
      }

      window.closeRejectModal();
      showToast('Access request declined.', 'info');
      await fetchAccessRequests();
    } catch (err) {
      showToast(`Decline error: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Decline Request';
      }
    }
  }

  async function toggleAccessUser(userId, currentlyDisabled) {
    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: !currentlyDisabled })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status !== 401) showToast(data.error || 'Failed to update user status', 'error');
        return;
      }
      showToast(currentlyDisabled ? 'User enabled' : 'User disabled', 'success');
      await fetchAccessUsers();
    } catch (err) {
      showToast(`User toggle error: ${err.message}`, 'error');
    }
  }

  async function deleteAccessUser(userId, username) {
    if (
      !confirm(
        `Delete user "${username}" from Jellyfin${hasSeerrUser(userId) ? ' and Seerr' : ''}? This cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status !== 401) showToast(data.error || 'Failed to delete user', 'error');
        return;
      }
      showToast(`Deleted user "${username}"`, 'success');
      if (data.warning) {
        showToast(data.warning, 'warn');
      }
      await fetchAccessUsers();
    } catch (err) {
      showToast(`Delete error: ${err.message}`, 'error');
    }
  }

  function hasSeerrUser(userId) {
    const u = state.accessUsers.find(
      (item) => String(item.id || item.jellyfinId || item.userId || item.Id) === String(userId)
    );
    return Boolean(u && (u.hasSeerr || u.seerrId || u.seerrUser));
  }

  function setupAccessListeners() {
    document.querySelectorAll('.dx-rail-btn[data-access-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => switchAccessSubtab(btn.dataset.accessSubtab));
    });

    document.getElementById('btn-refresh-access')?.addEventListener('click', fetchAccessOverview);

    document.querySelectorAll('#access-history-filters .filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('#access-history-filters .filter-btn')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.accessHistoryFilter = btn.dataset.historyFilter || 'all';
        renderAccessHistory();
      });
    });

    document.getElementById('access-users-search')?.addEventListener('input', (e) => {
      state.accessUsersSearch = e.target.value;
      renderAccessUsers();
    });

    document.getElementById('access-pending-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action][data-req-id]');
      if (!btn) return;
      if (btn.dataset.action === 'approve') openApproveModal(btn.dataset.reqId);
      else if (btn.dataset.action === 'reject') openRejectModal(btn.dataset.reqId);
    });

    document.getElementById('access-users-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-user-action][data-user-id]');
      if (!btn) return;
      if (btn.dataset.userAction === 'toggle') {
        toggleAccessUser(btn.dataset.userId, btn.dataset.userDisabled === '1');
      } else if (btn.dataset.userAction === 'delete') {
        deleteAccessUser(btn.dataset.userId, btn.dataset.username || 'user');
      }
    });

    document.getElementById('approve-all-libraries')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('#approve-libraries-list input[type="checkbox"]').forEach((cb) => {
        cb.disabled = checked;
        if (checked) cb.checked = true;
      });
    });

    document
      .getElementById('btn-confirm-approve')
      ?.addEventListener('click', confirmApproveRequest);
    document.getElementById('btn-confirm-reject')?.addEventListener('click', confirmRejectRequest);

    document.getElementById('access-approve-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'access-approve-modal') window.closeApproveModal();
    });
    document.getElementById('access-reject-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'access-reject-modal') window.closeRejectModal();
    });
    document.getElementById('modal-request')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-request') window.closeRequestModal();
    });
  }

  // ==============================================================================
  // EVENT LISTENERS & KEYBOARD SHORTCUTS
  // ==============================================================================

  function setupEventListeners() {
    const refreshBtn = document.getElementById('btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (!state.auth.authenticated) return;
        refreshBtn.classList.add('animate-spin');
        Promise.all([
          fetchSystem(),
          fetchPings(),
          fetchDownloads(),
          fetchVpnStatus(),
          loadLogSources(),
          fetchAccessRequests()
        ]).then(() => {
          setTimeout(() => refreshBtn.classList.remove('animate-spin'), 600);
        });
      });
    }

    const logSelect = document.getElementById('select-log-target');
    if (logSelect) {
      logSelect.addEventListener('change', (e) => {
        const nextSource = normalizeLogSource(e.target.value);
        state.logSource = nextSource;
        state.lastLogsFingerprint = '';
        localStorage.setItem('alpha_log_source', nextSource);
        syncLogSourceControls(nextSource);
        fetchLogs();
      });
    }

    document.querySelectorAll('.filter-btn[data-log-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document
          .querySelectorAll('.filter-btn[data-log-filter]')
          .forEach((b) => b.classList.remove('active', 'active-error'));
        state.logFilter = btn.dataset.logFilter;
        state.lastLogsFingerprint = '';
        if (state.logFilter === 'error') {
          btn.classList.add('active-error');
        } else {
          btn.classList.add('active');
        }
        fetchLogs();
      });
    });

    const tailSelect = document.getElementById('select-log-count');
    if (tailSelect) {
      tailSelect.addEventListener('change', (e) => {
        state.logTail = parseInt(e.target.value, 10) || 150;
        state.lastLogsFingerprint = '';
        fetchLogs();
      });
    }

    const searchBox = document.getElementById('log-search-box');
    if (searchBox) {
      searchBox.addEventListener('input', (e) => {
        state.logSearch = e.target.value;
        state.lastLogsFingerprint = '';
        fetchLogs();
      });
    }

    const scrollBtn = document.getElementById('btn-autoscroll');
    if (scrollBtn) {
      scrollBtn.addEventListener('click', () => {
        state.autoScroll = !state.autoScroll;
        scrollBtn.textContent = `Scroll: ${state.autoScroll ? 'ON' : 'OFF'}`;
        scrollBtn.style.color = state.autoScroll ? '#fff' : 'var(--text-muted)';
      });
    }

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

    const reloadLogBtn = document.getElementById('btn-reload-log');
    if (reloadLogBtn) {
      reloadLogBtn.addEventListener('click', () => {
        state.lastLogsFingerprint = '';
        loadLogSources();
        fetchLogs();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!state.auth.authenticated) return;
      const tag = e.target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        e.target?.isContentEditable
      ) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }

      if (e.key === 'Escape') {
        window.closeApproveModal();
        window.closeRejectModal();
        window.closeRequestModal();
        return;
      }
      if (e.key === '1') switchView('home');
      else if (e.key === '2') switchView('downloads');
      else if (e.key === '3') switchView('access');
      else if (e.key === '4') switchView('observability');
      else if (e.key === '5') switchView('vpn');
      else if (e.key === 'r' || e.key === 'R') {
        fetchSystem();
        fetchPings();
        fetchDownloads();
        fetchVpnStatus();
      } else if (e.key === '/') {
        e.preventDefault();
        switchView('observability');
        document.getElementById('log-search-box')?.focus();
      }
    });

    setupRequestsToolbar();
  }

  // ==============================================================================
  // METRICS & OBSERVABILITY ENGINE (CANVAS CHARTS DYNAMICALLY TINTED BY dx.bi)
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
    if (
      !state.auth.authenticated ||
      document.hidden ||
      (!force && state.activeTab !== 'observability' && state.activeTab !== 'home')
    ) {
      return;
    }

    try {
      const res = await apiFetch(
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
      const avgLatStr = `${data.summary?.avgLatency || 12} ms`;
      const uptimeStr = `${data.summary?.uptimePercent || 100}%`;
      const freeStorageStr = `${data.summary?.current?.freeGB || 461} GB Free`;

      setElText('stat-peak-dl', peakDlStr);
      setElText('home-stat-peak-dl', peakDlStr);
      setElText('stat-peak-streams', peakStreamsStr);
      setElText('home-stat-peak-streams', peakStreamsStr);
      setElText('stat-avg-latency', avgLatStr);
      setElText('home-stat-avg-latency', avgLatStr);
      setElText('stat-uptime', uptimeStr);
      setElText('home-stat-uptime', uptimeStr);
      setElText('stat-alpha-storage', freeStorageStr);

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
    const accent = getAccentColor();

    function renderChartTo(ids, config) {
      ids.forEach((id) => {
        const canvas = document.getElementById(id);
        if (canvas && canvas.offsetParent !== null) {
          drawChart(canvas, config);
        }
      });
    }

    // 1. Bandwidth Throughput & Peak Speeds (Accent-tinted download curve + amber upload)
    renderChartTo(['canvas-bandwidth', 'canvas-home-bandwidth'], {
      points: pts,
      formatY: (v) => formatSpeed(v),
      defaultSpan: 1000000,
      series: [
        {
          label: 'Download Speed',
          color: accent,
          fillColor: hexToRgba(accent, 0.24),
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

    // 2. Active Users & Concurrent Streams
    renderChartTo(['canvas-streams', 'canvas-home-streams'], {
      points: pts,
      minY: 0,
      defaultSpan: 3,
      formatY: (v) => `${Math.round(v)}`,
      series: [
        {
          label: 'Active Streams',
          color: accent,
          fillColor: hexToRgba(accent, 0.22),
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

    // 3. Service Latency & Downtime Radar (Semantic green + red incident pins)
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
          color: accent,
          fillColor: hexToRgba(accent, 0.22),
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
          color: accent,
          fillColor: hexToRgba(accent, 0.22),
          fill: true,
          showPeak: false,
          formatVal: (v) => `${v} GB`,
          data: pts.map((p) => p.freeGB)
        }
      ]
    });
  }

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
    maxY = maxY + span * 0.12;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = '#8a8a96';
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
        grad.addColorStop(0, s.fillColor || hexToRgba(s.color, 0.22));
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

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

      if (s.showPeak && coords.length > 0) {
        let maxIdx = 0;
        let maxVal = -Infinity;
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
          ctx.strokeStyle = '#0b0b0d';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      }
    });

    if (config.outages && config.outages.length > 0) {
      config.outages.forEach((outage) => {
        let nearestIdx = -1;
        let minDiff = Infinity;
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
          <span style="color:#a1a1aa;">${escapeHtml(s.label)}:</span>
          <strong style="color:#fff;">${escapeHtml(displayVal)}</strong>
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

  // Periodic Sync
  function startSyncTimer() {
    stopSyncTimer();
    state.timerId = setInterval(() => {
      if (document.hidden || !state.auth.authenticated) return;
      state.syncTick += 1;
      fetchSystem();
      fetchPings();
      if (state.activeTab === 'downloads') {
        fetchDownloads();
        if (state.syncTick % 2 === 0) fetchRequests();
      }
      if (state.activeTab === 'vpn') fetchVpnStatus();
      if (state.activeTab === 'observability') {
        fetchLogs();
        fetchMetrics();
      }
      if (state.activeTab === 'home') fetchMetrics();
      if (state.activeTab === 'access') {
        fetchAccessRequests();
      } else if (state.syncTick % 3 === 0) {
        fetchAccessRequests();
      }
    }, 4000);
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (
        (state.activeTab === 'observability' || state.activeTab === 'home') &&
        state.metricsData
      ) {
        renderAllCharts(state.metricsData);
      }
    }, 120);
  });

  // ==============================================================================
  // QUALITY ORCHESTRATOR & RELEASE INSPECTOR (WITH .dxv-q QUALITY TILES)
  // ==============================================================================

  async function searchTMDB(query) {
    if (!query || query.length < 2) return [];
    try {
      const res = await apiFetch(`/api/tmdb/search?query=${encodeURIComponent(query)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.results || [];
    } catch (e) {
      console.error('TMDB search failed:', e);
      return [];
    }
  }

  function renderSearchResults(results) {
    const container = document.getElementById('request-search-results');
    if (!container) return;

    state.requestSearchResults = results || [];
    if (state.requestSearchResults.length === 0) {
      container.innerHTML =
        '<div style="padding: 20px; text-align: center; color: #71717a;">No results found</div>';
      container.style.display = 'block';
      return;
    }

    container.innerHTML = state.requestSearchResults
      .map(
        (item, idx) => `
      <div class="search-result-item" style="display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; cursor: pointer; transition: background 0.2s; background: #121215; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 8px;"
           onclick="selectMediaByIndex(${idx})"
           onmouseover="this.style.background='#1a1a2e'" onmouseout="this.style.background='#121215'">
        <img src="https://image.tmdb.org/t/p/w92${escapeHtml(item.poster_path || '')}" alt="" style="width: 50px; height: 75px; object-fit: cover; border-radius: 6px; background: #222;">
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(item.title || item.name)}
          </div>
          <div style="font-size: 0.75rem; color: #71717a;">
            ${item.media_type === 'tv' ? 'TV Series' : 'Movie'} • ${escapeHtml(item.release_date || item.first_air_date || 'Unknown')} • ${item.vote_average?.toFixed(1) || '?'}★
          </div>
          <div style="font-size: 0.7rem; color: #8a8a96; margin-top: 2px;">${escapeHtml((item.overview || 'No overview').substring(0, 100))}...</div>
        </div>
        <span style="font-size: 0.7rem; color: #3b82f6; padding: 2px 8px; border: 1px solid rgba(59,130,246,0.3); border-radius: 4px;">Select</span>
      </div>
    `
      )
      .join('');
    container.style.display = 'block';
  }

  window.selectMediaByIndex = function (idx) {
    const media = (state.requestSearchResults || [])[idx];
    if (media) window.selectMedia(media);
  };

  window.selectMedia = function (media) {
    state.requestSelectedMedia = media;
    state.requestSearchResults = [];
    state.selectedReleaseIndex = null;
    const resultsEl = document.getElementById('request-search-results');
    const searchInput = document.getElementById('request-search-input');
    const stepSearch = document.getElementById('request-step-search');
    const stepQuality = document.getElementById('request-step-quality');
    const advEl = document.getElementById('request-advanced-discovery');

    if (resultsEl) resultsEl.style.display = 'none';
    if (searchInput) searchInput.value = media.title || media.name || '';
    if (stepSearch) stepSearch.style.display = 'none';
    if (stepQuality) stepQuality.style.display = 'block';

    state.requestQualityTier = 'max';
    document.querySelectorAll('.quality-tier-btn').forEach((btn) => {
      const active = btn.dataset.tier === 'max';
      btn.classList.toggle('active', active);
      btn.style.borderColor = active ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255,255,255,0.1)';
      btn.style.background = active ? 'rgba(59, 130, 246, 0.15)' : '#121215';
      btn.style.color = active ? '#3b82f6' : '#a1a1aa';
    });
    if (advEl) advEl.style.display = 'none';
    updateConfirmButton();
  };

  window.backToSearch = function () {
    const stepQuality = document.getElementById('request-step-quality');
    const stepSearch = document.getElementById('request-step-search');
    if (stepQuality) stepQuality.style.display = 'none';
    if (stepSearch) stepSearch.style.display = 'block';
    state.requestSelectedMedia = null;
    state.selectedReleaseIndex = null;
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.quality-tier-btn');
    if (!btn) return;
    const tier = btn.dataset.tier;
    state.requestQualityTier = tier;

    document.querySelectorAll('.quality-tier-btn').forEach((b) => {
      b.classList.remove('active');
      b.style.borderColor = 'rgba(255,255,255,0.1)';
      b.style.background = '#121215';
      b.style.color = '#a1a1aa';
    });
    btn.classList.add('active');
    const isPurple = tier === 'max' || tier === 'advanced';
    btn.style.borderColor = isPurple ? 'rgba(139, 92, 246, 0.5)' : 'rgba(59, 130, 246, 0.5)';
    btn.style.background = isPurple ? 'rgba(139, 92, 246, 0.15)' : 'rgba(59, 130, 246, 0.15)';
    btn.style.color = isPurple ? '#8b5cf6' : '#3b82f6';

    const advEl = document.getElementById('request-advanced-discovery');
    if (advEl) advEl.style.display = tier === 'advanced' ? 'block' : 'none';
    updateConfirmButton();
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

  window.discoverQualities = async function () {
    if (!state.requestSelectedMedia) return;

    const statusEl = document.getElementById('discovery-status');
    const gridEl = document.getElementById('quality-grid');
    const discoverBtn = document.getElementById('btn-discover-qualities');
    const rediscoverBtn = document.getElementById('btn-rediscover');

    state.requestDiscoveryInProgress = true;
    state.selectedReleaseIndex = null;
    updateConfirmButton();

    if (discoverBtn) discoverBtn.disabled = true;
    if (rediscoverBtn) rediscoverBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = 'Inspecting live tracker swarms (LimeTorrents, Knaben, YTS)...';
    }
    if (gridEl) {
      gridEl.innerHTML =
        '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #71717a;"><div class="spinner-small" style="margin: 0 auto 12px;"></div> Querying indexers in real time...</div>';
    }

    try {
      const media = state.requestSelectedMedia;
      const title = media.title || media.name || '';
      const year = (media.release_date || media.first_air_date || '').substring(0, 4);

      const res = await apiFetch(
        `/api/media/releases/search?query=${encodeURIComponent(title)}&year=${encodeURIComponent(year)}&tmdbId=${media.id}`
      );
      if (!res.ok) throw new Error('Search failed: HTTP ' + res.status);
      const data = await res.json();

      if (!data.releases || data.releases.length === 0) {
        if (statusEl) statusEl.textContent = 'No releases found for this title.';
        if (gridEl) {
          gridEl.innerHTML =
            '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #71717a;">No active swarms found across indexers.</div>';
        }
        return;
      }

      state.requestDiscoveredQualities = data.releases;
      if (statusEl) {
        statusEl.textContent = `Found ${data.total} swarms in ${data.tookMs}ms. Click a release to select.`;
      }

      renderQualityGrid(data.releases);

      if (discoverBtn) discoverBtn.style.display = 'none';
      if (rediscoverBtn) rediscoverBtn.style.display = 'inline-block';
    } catch (e) {
      console.error('Discovery failed:', e);
      if (statusEl) statusEl.textContent = 'Swarm inspection failed: ' + e.message;
      if (gridEl) {
        gridEl.innerHTML =
          '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #ef4444;">Failed to inspect swarms. Please retry.</div>';
      }
    } finally {
      state.requestDiscoveryInProgress = false;
      if (discoverBtn) discoverBtn.disabled = false;
      if (rediscoverBtn) rediscoverBtn.disabled = false;
    }
  };

  function getQualityTileInfo(attrs) {
    const resPill = attrs.resolution || '1080p';
    const is4k = resPill.includes('2160') || resPill.includes('4K');
    const is720 = resPill.includes('720');
    const is480 = resPill.includes('480');
    const shortRes = is4k ? '4K' : is720 ? '720p' : is480 ? '480p' : '1080p';
    const hdrList = Array.isArray(attrs.hdr) ? attrs.hdr : [];
    const subTag =
      hdrList.find((h) => h && h !== 'SDR') ||
      (attrs.isRemux ? 'REMUX' : attrs.isImax ? 'IMAX' : '');
    const tierKey = is4k ? '4k' : is720 ? '720' : '1080';
    return { resPill, shortRes, subTag, tierKey };
  }

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
        const q = getQualityTileInfo(attrs);
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
             onclick="selectRelease(${idx})">
          <div class="dxv-row" style="padding: 0; border-bottom: 0; min-height: auto; margin-bottom: 10px;">
            <span class="dxv-q" data-q="${q.tierKey}">
              <b>${escapeHtml(q.shortRes)}</b>
              ${q.subTag ? `<i>${escapeHtml(q.subTag)}</i>` : ''}
            </span>
            <div class="dxv-main">
              <strong>${escapeHtml(rel.sizeFormatted || '')}</strong>
              <small>${escapeHtml(rel.indexer || 'Torrent')} · ${rel.seeders || 0} seeds</small>
            </div>
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
      .quality-card:hover { border-color: var(--dx-accent, #8b5cf6) !important; transform: translateY(-2px); }
      .quality-card.selected { border-color: var(--dx-accent, #8b5cf6) !important; box-shadow: 0 0 0 2px var(--dx-accent-soft, rgba(139,92,246,0.3)) !important; background: #1a1520 !important; }
      .quality-card:hover .dxv-q, .quality-card.selected .dxv-q { --dxv-tile: var(--dx-accent); }
      .quality-card:hover .dxv-q b, .quality-card.selected .dxv-q b,
      .quality-card:hover .dxv-q i, .quality-card.selected .dxv-q i { color: var(--dx-accent-fg, #fff); }
      .quality-card.selected .quality-check { background: var(--dx-accent, #8b5cf6); border-color: var(--dx-accent, #8b5cf6) !important; }
      .quality-card.selected .quality-check::after { content: '✔'; color: #fff; font-size: 11px; position: absolute; top: 0; left: 3px; line-height: 16px; }
      .quality-card .dxv-q[data-q="4k"] { --dxv-tile: rgba(236, 72, 153, 0.22); }
      .quality-card .dxv-q[data-q="1080"] { --dxv-tile: rgba(59, 130, 246, 0.22); }
      .quality-card .dxv-q[data-q="720"] { --dxv-tile: rgba(16, 185, 129, 0.22); }
    `;
    document.head.appendChild(style);
  }

  window.confirmRequest = async function () {
    const btn = document.getElementById('btn-confirm-request');
    const media = state.requestSelectedMedia;
    const tier = state.requestQualityTier || 'max';

    if (!media) return showToast('No media selected', 'error');

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Dispatching...';
    }

    try {
      if (tier === 'advanced') {
        if (state.selectedReleaseIndex === undefined || state.selectedReleaseIndex === null) {
          showToast('Select a release first', 'error');
          return;
        }
        const rel = (state.requestDiscoveredQualities || [])[state.selectedReleaseIndex];
        if (!rel) {
          showToast('Selected release not found', 'error');
          return;
        }

        const grabRes = await apiFetch('/api/media/releases/grab', {
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
        showToast(
          `🚀 Dispatched release to pipeline: ${(rel.title || '').substring(0, 40)}...`,
          'success'
        );
      } else {
        const reqRes = await apiFetch('/api/media/request', {
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

      window.closeRequestModal();
      setTimeout(() => window.fetchRequests(true), 1200);
    } catch (e) {
      console.error('Request failed:', e);
      showToast('Failed to submit request: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
      updateConfirmButton();
    }
  };

  window.openRequestModal = function () {
    const modal = document.getElementById('modal-request');
    const stepSearch = document.getElementById('request-step-search');
    const stepQuality = document.getElementById('request-step-quality');
    const searchInput = document.getElementById('request-search-input');
    const searchResults = document.getElementById('request-search-results');
    const advEl = document.getElementById('request-advanced-discovery');
    const discoverBtn = document.getElementById('btn-discover-qualities');
    const rediscoverBtn = document.getElementById('btn-rediscover');
    const gridEl = document.getElementById('quality-grid');

    if (modal) modal.style.display = 'flex';
    if (stepSearch) stepSearch.style.display = 'block';
    if (stepQuality) stepQuality.style.display = 'none';
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    if (searchResults) searchResults.style.display = 'none';
    if (advEl) advEl.style.display = 'none';
    if (discoverBtn) discoverBtn.style.display = 'inline-block';
    if (rediscoverBtn) rediscoverBtn.style.display = 'none';
    if (gridEl) gridEl.innerHTML = '';

    state.requestSelectedMedia = null;
    state.selectedReleaseIndex = null;
    state.requestQualityTier = 'max';
    document.querySelectorAll('.quality-tier-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tier === 'max');
    });
    updateConfirmButton();
  };

  window.closeRequestModal = function () {
    const modal = document.getElementById('modal-request');
    if (modal) modal.style.display = 'none';
    state.requestDiscoveredQualities = [];
    state.selectedReleaseIndex = null;
  };

  let searchDebounceTimer = null;
  document.addEventListener('input', (e) => {
    if (e.target.id === 'request-search-input') {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async () => {
        const query = e.target.value.trim();
        const resultsEl = document.getElementById('request-search-results');
        if (query.length < 2) {
          if (resultsEl) resultsEl.style.display = 'none';
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
  // UNIFIED MEDIA REQUESTS PANEL
  // ==============================================================================

  window.fetchRequests = async function (manual = false) {
    const icon = document.getElementById('icon-refresh-req');
    if (manual && icon) icon.classList.add('animate-spin');

    try {
      const res = await apiFetch('/api/requests');
      if (!res.ok) throw new Error('Failed to fetch requests: ' + res.status);
      const data = await res.json();
      state.requests = Array.isArray(data) ? data : [];

      const activeCount = state.requests.filter(
        (r) => r.status === 'downloading' || r.status === 'stalled' || r.status === 'failed'
      ).length;
      const badge = document.getElementById('badge-req');
      if (badge) {
        badge.textContent = activeCount;
        badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
      }

      const headerPill = document.getElementById('req-header-pill');
      if (headerPill) headerPill.textContent = `${state.requests.length} Total`;

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

      updateUserFilterOptions();
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
      if (statusFilter === 'downloading' && r.status !== 'downloading') return false;
      if (statusFilter === 'stalled' && r.status !== 'stalled' && r.status !== 'failed') {
        return false;
      }
      if (statusFilter === 'completed' && r.status !== 'completed') return false;
      if (statusFilter === 'pending' && r.status !== 'pending' && r.status !== 'searching') {
        return false;
      }
      if (userFilter !== 'all' && (r.requestedBy?.displayName || '') !== userFilter) return false;

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

    const posterHtml = r.posterUrl
      ? `<img src="${escapeHtml(r.posterUrl)}" alt="" class="req-poster-img" loading="lazy" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'req-poster-fallback\\'>${escapeHtml((r.title || '?')[0])}</div>';">`
      : `<div class="req-poster-fallback">${escapeHtml((r.title || '?')[0])}</div>`;

    const avatarHtml = r.requestedBy?.avatarUrl
      ? `<img src="${escapeHtml(r.requestedBy.avatarUrl)}" alt="" class="req-avatar" onerror="this.style.display='none';">`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

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
                  Re-Index &amp; Search
                </button>
              </div>
            </div>
          `
              : ''
          }
        </div>
      `;
    }

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

    const totalSeeds = (r.torrents || []).reduce((acc, t) => acc + (t.seeds || 0), 0);
    const totalPeers = (r.torrents || []).reduce((acc, t) => acc + (t.peers || 0), 0);
    const host = window.location.hostname || '127.0.0.1';

    return `
      <div class="req-card ${r.isPrioritized ? 'priority-active' : ''}" id="req-card-${id}">
        <div class="req-poster-wrap">
          ${posterHtml}
        </div>
        <div class="req-card-body">
          <div class="req-card-header">
            <div class="req-title-row">
              <span class="req-title">${escapeHtml(r.title)}</span>
              ${r.year ? `<span class="req-year">(${escapeHtml(r.year)})</span>` : ''}
              <span class="req-type-badge">${escapeHtml(r.type || 'movie')}</span>
              <span class="req-profile-badge">${escapeHtml(r.qualityProfile || 'Standard')}</span>
              ${r.isPrioritized ? '<span class="req-turbo-badge"><span class="pulsing-bolt">⚡</span> TURBO ACTIVE</span>' : ''}
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

          ${diagnosisHtml}
          ${episodesHtml}

          <div class="req-card-actions">
            ${
              isCompleted
                ? `
              <a href="http://${host}:8096" target="_blank" class="req-action-btn success">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                Watch in Jellyfin ↗
              </a>
            `
                : ''
            }
            ${
              !isCompleted
                ? r.isPrioritized
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
            <a href="http://${host}:5055/${r.type === 'tv' ? 'tv' : 'movie'}/${r.tmdbId}" target="_blank" class="req-action-btn" style="color: #a1a1aa;">
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
      const res = await apiFetch('/api/requests/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, tmdbId, type })
      });
      if (res.ok) {
        showToast(`Re-search commanded for request #${id}!`, 'success');
        setTimeout(() => window.fetchRequests(true), 1500);
      } else if (res.status !== 401) {
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
      const res = await apiFetch(`/api/requests/${id}/prioritize`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        showToast(
          `⚡ Priority Mode Activated: 100% bandwidth allocated to '${title}'! (${data.pausedCount} background downloads paused)`,
          'success'
        );
        window.fetchRequests(true);
      } else if (res.status !== 401) {
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
      const res = await apiFetch(`/api/requests/${id}/unprioritize`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        showToast(
          `✔ Priority mode disabled. Resumed ${data.resumedCount || 0} background download(s).`,
          'success'
        );
        window.fetchRequests(true);
      } else if (res.status !== 401) {
        showToast(data.error || 'Failed to unprioritize request', 'error');
      }
    } catch (err) {
      showToast('Unprioritize error: ' + err.message, 'error');
    }
  };

  function setupRequestsToolbar() {
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

    const searchInput = document.getElementById('req-filter-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.reqFilterSearch = e.target.value;
        renderRequests();
      });
    }

    const userSelect = document.getElementById('req-user-select');
    if (userSelect) {
      userSelect.addEventListener('change', (e) => {
        state.reqFilterUser = e.target.value;
        renderRequests();
      });
    }

    document.getElementById('btn-new-request')?.addEventListener('click', window.openRequestModal);
    document
      .getElementById('btn-confirm-request')
      ?.addEventListener('click', window.confirmRequest);
  }

  // ==============================================================================
  // RESTART CONTAINERS MODAL HANDLERS
  // ==============================================================================

  const RESTARTABLE_SERVICES = [
    {
      id: 'alpha-prod-jellyfin',
      name: 'Jellyfin Cinema',
      desc: 'Direct streaming & hardware transcoding',
      icon: '🎬'
    },
    {
      id: 'alpha-prod-seerr',
      name: 'Seerr Discovery',
      desc: 'Media requests & automation hub',
      icon: '🍿'
    },
    {
      id: 'alpha-prod-qbittorrent',
      name: 'qBittorrent Engine',
      desc: 'Protected torrent download client',
      icon: '⚡'
    },
    {
      id: 'alpha-prod-radarr',
      name: 'Radarr',
      desc: 'Movie catalog & quality management',
      icon: '🎞️'
    },
    {
      id: 'alpha-prod-sonarr',
      name: 'Sonarr',
      desc: 'TV series automation & indexers',
      icon: '📺'
    },
    {
      id: 'alpha-prod-prowlarr',
      name: 'Prowlarr',
      desc: 'Torrents & Usenet indexer proxy',
      icon: '🔍'
    },
    {
      id: 'alpha-prod-gluetun',
      name: 'Gluetun VPN',
      desc: 'Wireguard encrypted killswitch tunnel',
      icon: '🛡️'
    },
    {
      id: 'alpha-prod-tailscale',
      name: 'Tailscale Mesh',
      desc: 'Secure mesh networking & routing',
      icon: '🌐'
    },
    {
      id: 'alpha-prod-dashboard',
      name: 'Orbit Dashboard',
      desc: 'Core UI & monitoring daemon',
      icon: '🚀'
    }
  ];

  window.openRestartContainersModal = function () {
    const modal = document.getElementById('modal-restart-containers');
    if (!modal) return;
    modal.style.display = 'flex';
    window.renderRestartContainersList();
  };

  window.closeRestartContainersModal = function () {
    const modal = document.getElementById('modal-restart-containers');
    if (modal) modal.style.display = 'none';
  };

  window.renderRestartContainersList = async function () {
    const containerEl = document.getElementById('restart-containers-list');
    if (!containerEl) return;
    containerEl.innerHTML =
      '<div style="color: var(--dx-text-3); font-size: 0.85rem; padding: 12px 0;">Loading container telemetry...</div>';

    let liveContainers = [];
    try {
      const res = await apiFetch('/api/containers');
      if (res.ok) {
        const data = await res.json();
        liveContainers = data.containers || [];
      }
    } catch (_) {}

    const liveMap = new Map(liveContainers.map((c) => [c.name, c]));

    const html = RESTARTABLE_SERVICES.map((item) => {
      const live = liveMap.get(item.id);
      const isUp = live ? live.state === 'running' : true;
      const statusText = live ? live.status : 'Active';
      const statusColor = isUp ? '#10b981' : '#f59e0b';

      return `
        <div class="restart-container-card" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="font-size: 1.3rem;">${item.icon}</div>
            <div>
              <div style="font-size: 0.92rem; font-weight: 600; color: #fff;">${escapeHtml(item.name)} <code style="font-size: 0.72rem; color: #8a8a96; font-weight: normal;">${escapeHtml(item.id)}</code></div>
              <div style="font-size: 0.75rem; color: #8a8a96; display: flex; align-items: center; gap: 6px; margin-top: 2px;">
                <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${statusColor};"></span>
                <span>${escapeHtml(statusText)}</span>
                <span>•</span>
                <span>${escapeHtml(item.desc)}</span>
              </div>
            </div>
          </div>
          <button
            class="dx-btn dx-btn-sm"
            onclick="triggerContainerRestart(this, '${escapeHtml(item.id)}')"
            style="display: inline-flex; align-items: center; gap: 5px; background: rgba(229,9,20,0.15); border: 1px solid rgba(229,9,20,0.4); color: #fff; padding: 6px 14px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all 0.2s;"
          >
            <span>⟳</span>
            <span>Restart</span>
          </button>
        </div>
      `;
    }).join('');

    containerEl.innerHTML = html;
  };

  window.triggerContainerRestart = async function (btn, containerName) {
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.innerHTML = '<span class="animate-spin">⟳</span> Restarting...';
    }
    showToast(`Restarting ${containerName}...`, 'info');
    try {
      const res = await apiFetch('/api/containers/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: containerName })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(`${containerName} restarted successfully!`, 'success');
        setTimeout(window.renderRestartContainersList, 1500);
      } else {
        showToast(data.error || 'Failed to restart container', 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.innerHTML = '<span>⟳</span> Restart';
      }
    }
  };

  window.restartAllContainers = async function () {
    if (
      !confirm(
        'Restart all Orbit service containers? Network traffic and streaming will briefly pause.'
      )
    )
      return;
    const btn = document.getElementById('btn-restart-all-containers');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="animate-spin">⟳</span> Restarting All...';
    }
    showToast('Triggering batch restart of containers...', 'info');
    for (const item of RESTARTABLE_SERVICES) {
      try {
        await apiFetch('/api/containers/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: item.id })
        });
      } catch (_) {}
    }
    showToast('All containers restarted successfully!', 'success');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⟳ Restart All Containers';
    }
    setTimeout(window.renderRestartContainersList, 1500);
  };

  // ==============================================================================
  // SESSION STARTUP & INITIALIZATION
  // ==============================================================================

  function startAuthenticatedSession(preferredTab = null) {
    loadLogSources();
    renderAppGrid();
    window.switchView(preferredTab || state.activeTab);
    fetchSystem();
    fetchPings();
    fetchDownloads();
    fetchVpnStatus();
    window.fetchRequests();
    fetchAccessRequests();
    if (state.activeTab === 'observability' || state.activeTab === 'home') {
      fetchMetrics(true);
    }
    startSyncTimer();
  }

  function init() {
    applyAccent(state.accent, false);
    state.logSource = normalizeLogSource(
      localStorage.getItem('alpha_log_source') || state.logSource
    );
    localStorage.setItem('alpha_log_source', state.logSource);
    syncLogSourceControls(state.logSource);

    setupAccentPicker();
    setupAuthGateListeners();
    setupAccessListeners();
    setupEventListeners();

    checkInitialAuth();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ==============================================================================
  // POWER MENU DROPDOWN & HOST SYSTEM REBOOT / SHUTDOWN
  // ==============================================================================
  window.togglePowerMenu = function (e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const menu = document.getElementById('power-dropdown-menu');
    if (!menu) return;
    const isShown = menu.style.display === 'block';
    menu.style.display = isShown ? 'none' : 'block';
  };

  window.hidePowerMenu = function () {
    const menu = document.getElementById('power-dropdown-menu');
    if (menu) menu.style.display = 'none';
  };

  document.addEventListener('click', (e) => {
    const wrapper = document.querySelector('.power-menu-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      window.hidePowerMenu();
    }
  });

  window.triggerHostPower = async function (action) {
    const confirmPrompt =
      action === 'reboot'
        ? 'Are you sure you want to REBOOT the server? Active downloads will pause and Orbit will briefly go offline.'
        : 'Are you sure you want to SHUT DOWN the server? The host machine will power off completely.';

    if (!confirm(confirmPrompt)) return;

    try {
      showToast(`Initiating server ${action}...`, 'warning');
      const res = await apiFetch(`/api/system/${action}`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || `Server ${action} scheduled`, 'success');
      } else {
        showToast(data.error || `Failed to initiate ${action}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };
})();
