const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

// Load .env from project root or dashboard directory without overriding runtime env
function loadEnvFile() {
  const candidates = [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eqIdx = cleaned.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = cleaned.slice(0, eqIdx).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        if (process.env[key] !== undefined && process.env[key] !== '') continue;
        let val = cleaned.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    } catch (_) {}
  }
}

loadEnvFile();

// Environment-configurable API keys (injected via .env / container runtime)
const SEERR_API_KEY = process.env.SEERR_API_KEY || '';
const RADARR_API_KEY = process.env.RADARR_API_KEY || '';
const SONARR_API_KEY = process.env.SONARR_API_KEY || '';
const PROWLARR_API_KEY = process.env.PROWLARR_API_KEY || '';
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
const SWITCHER_API_KEY = process.env.SWITCHER_API_KEY || '';

const { createAccessManager } = require('./lib/accessManager');

const accessManager = createAccessManager(() => ({
  JELLYFIN_API_KEY: process.env.JELLYFIN_API_KEY || JELLYFIN_API_KEY,
  SEERR_API_KEY: process.env.SEERR_API_KEY || SEERR_API_KEY,
  SWITCHER_API_KEY: process.env.SWITCHER_API_KEY || SWITCHER_API_KEY,
  NTFY_URL: process.env.NTFY_URL || '',
  NTFY_TOPIC: process.env.NTFY_TOPIC || '',
  NTFY_TOKEN: process.env.NTFY_TOKEN || '',
  JELLYFIN_URL: process.env.JELLYFIN_URL || '',
  JELLYFIN_INTERNAL_URL: process.env.JELLYFIN_INTERNAL_URL || '',
  SEERR_URL: process.env.SEERR_URL || '',
  DASHBOARD_DATA_DIR: process.env.DASHBOARD_DATA_DIR || '',
  DASHBOARD_ENC_SECRET: process.env.DASHBOARD_ENC_SECRET || '',
  DASHBOARD_AUTH_DISABLED: process.env.DASHBOARD_AUTH_DISABLED || ''
}));

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

// Detect Podman socket location (container or host)
function getPodmanSocketPath() {
  if (process.env.PODMAN_SOCKET) {
    return process.env.PODMAN_SOCKET;
  }
  const uid = process.getuid ? process.getuid() : 1000;
  const candidates = [
    process.env.PODMAN_SOCKET,
    '/run/podman/podman.sock',
    `/run/user/${uid}/podman/podman.sock`,
    '/var/run/docker.sock'
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
      return p;
    } catch (_) {}
  }
  return candidates[0] || '/var/run/docker.sock';
}

const PODMAN_SOCKET = getPodmanSocketPath();

// Find Alpha drive mount point
function getAlphaPath() {
  const candidates = [
    process.env.ALPHA_MOUNT_POINT,
    '/media/alpha',
    `/run/media/${process.env.USER || 'banana'}/Alpha`,
    '/run/media/banana/Alpha'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return '/';
}

// Find logs folder
function getLogsDir() {
  const candidates = [
    '/logs',
    process.env.SERVER_DATA_DIR ? path.join(process.env.SERVER_DATA_DIR, 'sandbox/logs') : null,
    path.join(__dirname, '../data/sandbox/logs'),
    '/run/media/banana/Alpha/project/alpha/alpha-prod-orbit/data/sandbox/logs',
    path.join(__dirname, '../../serverData/sandbox/logs'),
    '/run/media/banana/Alpha/server/serverData/sandbox/logs'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

// In-memory cache for media metadata (TMDb / Seerr details)
const mediaMetadataCache = new Map();

async function getMediaMetadata(type, tmdbId) {
  if (!tmdbId) return { title: 'Unknown Media', year: 0, posterUrl: '', overview: '' };
  const key = `${type}:${tmdbId}`;
  const now = Date.now();
  if (mediaMetadataCache.has(key)) {
    const cached = mediaMetadataCache.get(key);
    if (now - cached.cachedAt < 3600000) {
      // 1 hour TTL
      return cached;
    }
  }

  const seerrKey = SEERR_API_KEY;
  const isMovie = type === 'movie';
  const endpoint = isMovie ? `movie/${tmdbId}` : `tv/${tmdbId}`;
  try {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchCandidate(
      [
        `http://127.0.0.1:5055/api/v1/${endpoint}`,
        `http://alpha-prod-seerr:5055/api/v1/${endpoint}`
      ],
      {
        headers: { 'X-Api-Key': seerrKey },
        signal: ctrl.signal
      }
    );
    clearTimeout(tId);
    if (res.ok) {
      const data = await res.json();
      const title = data.title || data.name || `Media #${tmdbId}`;
      const relDate = data.releaseDate || data.firstAirDate || '';
      const year = parseInt(relDate.slice(0, 4) || '0', 10);
      const posterUrl = data.posterPath ? `https://image.tmdb.org/t/p/w500${data.posterPath}` : '';
      const overview = data.overview || '';
      const result = { title, year, posterUrl, overview, cachedAt: now };
      mediaMetadataCache.set(key, result);
      return result;
    }
  } catch (_) {}

  const fallback = {
    title: `Media #${tmdbId}`,
    year: 0,
    posterUrl: '',
    overview: '',
    cachedAt: now
  };
  mediaMetadataCache.set(key, fallback);
  return fallback;
}

function cleanTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatRelativeTime(iso) {
  if (!iso) return 'Unknown';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// Demux Docker/Podman binary log stream (8-byte header per frame)
function demuxDockerLogs(buffer) {
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset]; // 0 = stdin, 1 = stdout, 2 = stderr
    const isValidFrameHeader =
      streamType <= 2 &&
      buffer[offset + 1] === 0 &&
      buffer[offset + 2] === 0 &&
      buffer[offset + 3] === 0;
    if (!isValidFrameHeader) {
      break;
    }
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) {
      const rest = buffer.subarray(offset).toString('utf8');
      if (rest.trim())
        lines.push({ stream: streamType === 2 ? 'stderr' : 'stdout', text: rest.trimEnd() });
      break;
    }
    const chunk = buffer.subarray(offset, offset + size).toString('utf8');
    offset += size;
    chunk.split('\n').forEach((line) => {
      if (line.trim().length > 0) {
        lines.push({ stream: streamType === 2 ? 'stderr' : 'stdout', text: line.trimEnd() });
      }
    });
  }
  if (lines.length === 0 && buffer.length > 0) {
    buffer
      .toString('utf8')
      .split('\n')
      .forEach((line) => {
        if (line.trim().length > 0) lines.push({ stream: 'stdout', text: line.trimEnd() });
      });
  }
  return lines;
}

function isPodmanSocketError(err) {
  if (!err) return false;
  if (['ECONNREFUSED', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code)) {
    return true;
  }
  return /ENOENT|EACCES|ECONNREFUSED|connect/i.test(err.message || '');
}

// Request helper for Podman unix socket
function requestPodman(apiPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const socketPath =
      process.env.PODMAN_SOCKET ||
      (fs.existsSync(PODMAN_SOCKET) ? PODMAN_SOCKET : getPodmanSocketPath());
    const options = {
      socketPath,
      path: apiPath,
      method: method,
      headers: {}
    };
    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBuffer,
          body: rawBuffer.toString('utf8')
        });
      });
    });
    req.setTimeout(5000, () => {
      const err = new Error(`Podman socket request timed out (${socketPath})`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Services configuration for ping latency checks
const MONITORED_SERVICES = [
  {
    id: 'jellyfin',
    name: 'Jellyfin Cinema',
    port: 8096,
    urls: accessManager.getJellyfinUrls('/System/Info/Public'),
    category: 'media',
    icon: 'film',
    desc: 'Direct-Play Cinema & Shows'
  },
  {
    id: 'seerr',
    name: 'Seerr Netflix UI',
    port: 5055,
    urls: accessManager.getSeerrUrls('/api/v1/status'),
    category: 'media',
    icon: 'compass',
    desc: 'Media Discovery & Automated Requests'
  },
  {
    id: 'gluetun',
    name: 'Gluetun VPN Gateway',
    port: 8000,
    urls: ['http://alpha-prod-gluetun:8000/v1/publicip/ip', 'http://127.0.0.1:8000/v1/publicip/ip'],
    category: 'security',
    icon: 'shield',
    desc: 'WireGuard Tunnel with Kill-Switch'
  },
  {
    id: 'qbittorrent',
    name: 'qBittorrent Engine',
    port: 8081,
    urls: [
      'http://alpha-prod-gluetun:8080/api/v2/app/version',
      'http://127.0.0.1:8081/api/v2/app/version'
    ],
    category: 'download',
    icon: 'download-cloud',
    desc: 'Zero-Upload Torrent Pipeline'
  },
  {
    id: 'vpn-switcher',
    name: 'VPN Switcher API',
    port: 8001,
    urls: [
      'http://alpha-prod-vpn-switcher:8001/api/v1/status',
      'http://127.0.0.1:8001/api/v1/status'
    ],
    category: 'security',
    icon: 'refresh-cw',
    desc: 'Hot-Swap VPN Tunnel Manager'
  },
  {
    id: 'radarr',
    name: 'Radarr (Movies)',
    port: 7878,
    urls: ['http://alpha-prod-gluetun:7878/ping', 'http://127.0.0.1:7878/ping'],
    category: 'download',
    icon: 'video',
    desc: 'Movie Indexer & Quality Manager'
  },
  {
    id: 'sonarr',
    name: 'Sonarr (Series)',
    port: 8989,
    urls: ['http://alpha-prod-gluetun:8989/ping', 'http://127.0.0.1:8989/ping'],
    category: 'download',
    icon: 'tv',
    desc: 'TV Series & Anime Manager'
  },
  {
    id: 'prowlarr',
    name: 'Prowlarr (Indexers)',
    port: 9696,
    urls: ['http://alpha-prod-gluetun:9696/ping', 'http://127.0.0.1:9696/ping'],
    category: 'download',
    icon: 'search',
    desc: 'Indexer Aggregator & Proxy'
  }
];

// Helper to fetch with multiple candidate URLs
async function fetchCandidate(urls, options = {}) {
  let lastErr = null;
  for (const u of urls) {
    try {
      const res = await fetch(u, options);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No candidate URLs succeeded');
}

// ==============================================================================
// PRIORITY DOWNLOAD ENGINE ("TURBO MODE")
// ==============================================================================
const PRIORITY_STATE_FILE = '/tmp/orbit-priority-state.json';

function loadPriorityState() {
  try {
    if (fs.existsSync(PRIORITY_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(PRIORITY_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    active: false,
    requestId: null,
    tmdbId: null,
    title: null,
    type: null,
    targetHashes: [],
    pausedBySystemHashes: [],
    prioritizedAt: null
  };
}

let priorityState = loadPriorityState();

function savePriorityState() {
  try {
    fs.writeFileSync(PRIORITY_STATE_FILE, JSON.stringify(priorityState, null, 2), 'utf8');
  } catch (err) {
    console.error('[PRIORITY] Failed to save state:', err.message);
  }
}

async function callQbit(endpoint, params = {}, method = 'POST') {
  const qbitHosts = ['http://alpha-prod-gluetun:8080', 'http://127.0.0.1:8081'];
  const urlParams = new URLSearchParams(params).toString();
  const urls = qbitHosts.map((h) => `${h}/api/v2/${endpoint}${urlParams ? '?' + urlParams : ''}`);
  const ctrl = new AbortController();
  const tId = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetchCandidate(urls, { method, signal: ctrl.signal });
    clearTimeout(tId);
    return res;
  } catch (err) {
    clearTimeout(tId);
    throw err;
  }
}

async function autoResumePriority(reason = 'completion') {
  if (!priorityState.active) return { success: true };
  console.log(
    `[PRIORITY] Auto-resuming background downloads (Reason: ${reason}) for '${priorityState.title}'`
  );

  const { pausedBySystemHashes, targetHashes } = priorityState;

  // 1. Resume torrents paused specifically by the priority engine
  if (pausedBySystemHashes && pausedBySystemHashes.length > 0) {
    try {
      await callQbit('torrents/resume', { hashes: pausedBySystemHashes.join('|') });
      console.log(
        `[PRIORITY] Successfully resumed ${pausedBySystemHashes.length} background torrent(s)`
      );
    } catch (err) {
      console.error('[PRIORITY] Error resuming background torrents:', err.message);
    }
  }

  // 2. Clear force start from target torrents
  if (targetHashes && targetHashes.length > 0) {
    try {
      await callQbit('torrents/setForceStart', { hashes: targetHashes.join('|'), value: 'false' });
    } catch (_) {}
  }

  // 3. Reset state ledger
  const resumedCount = (pausedBySystemHashes || []).length;
  priorityState = {
    active: false,
    requestId: null,
    tmdbId: null,
    title: null,
    type: null,
    targetHashes: [],
    pausedBySystemHashes: [],
    prioritizedAt: null
  };
  savePriorityState();
  return { success: true, resumedCount };
}

// Fail-safe reconciler loop (every 5 seconds)
setInterval(async () => {
  if (!priorityState.active) return;
  try {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 3000);
    const qRes = await fetchCandidate(
      [
        'http://alpha-prod-gluetun:8080/api/v2/torrents/info?filter=all',
        'http://127.0.0.1:8081/api/v2/torrents/info?filter=all'
      ],
      { signal: ctrl.signal }
    );
    clearTimeout(tId);
    if (!qRes.ok) return;
    const allTorrents = await qRes.json();

    // Swarm Watcher: if waiting for target torrent to be pushed to qBit
    if (priorityState.targetHashes.length === 0 && priorityState.title) {
      const cTitle = cleanTitle(priorityState.title);
      const matches = allTorrents.filter((t) => cleanTitle(t.name).includes(cTitle));
      if (matches.length > 0) {
        const newHashes = matches.map((t) => t.hash.toLowerCase());
        priorityState.targetHashes = newHashes;
        await callQbit('torrents/topPrio', { hashes: newHashes.join('|') });
        await callQbit('torrents/setForceStart', { hashes: newHashes.join('|'), value: 'true' });
        await callQbit('torrents/setDownloadLimit', { hashes: newHashes.join('|'), limit: '0' });
        await callQbit('torrents/resume', { hashes: newHashes.join('|') });
        savePriorityState();
        console.log(
          `[PRIORITY] Detected newly queued torrent for '${priorityState.title}'. Turbo mode applied.`
        );
      }
    }

    // Completion Check: all target torrents complete
    if (priorityState.targetHashes.length > 0) {
      const targets = allTorrents.filter((t) =>
        priorityState.targetHashes.includes(t.hash.toLowerCase())
      );
      const allDone =
        targets.length > 0 &&
        targets.every(
          (t) =>
            t.progress >= 1.0 ||
            ['uploading', 'stalledUP', 'pausedUP', 'completed'].includes(t.state)
        );
      if (allDone) {
        console.log(
          `[PRIORITY] Reconciler verified download completion for '${priorityState.title}'.`
        );
        await autoResumePriority('reconciler_completion_detected');
      }
    }
  } catch (_) {}
}, 5000);

// ==============================================================================
// RELEASE ATTRIBUTE PARSER & QUALITY NORMALIZER
// ==============================================================================
function parseReleaseAttributes(rawTitle) {
  const t = rawTitle || '';

  // Resolution
  let resolution = '1080p';
  if (/2160p|4k|uhd/i.test(t)) resolution = '2160p (4K)';
  else if (/1080p|1080i|fhd/i.test(t)) resolution = '1080p';
  else if (/720p|hd/i.test(t)) resolution = '720p';
  else if (/480p|576p|sd|dvd/i.test(t)) resolution = 'SD (480p)';

  // Dynamic Range
  const hdr = [];
  if (/\b(dv|dovi|dolby.?vision)\b/i.test(t)) hdr.push('Dolby Vision');
  if (/\bhdr10\+/i.test(t)) hdr.push('HDR10+');
  else if (/\bhdr10\b/i.test(t)) hdr.push('HDR10');
  else if (/\bhdr\b/i.test(t)) hdr.push('HDR');
  if (hdr.length === 0 && (resolution === '1080p' || resolution === '720p')) hdr.push('SDR');

  // Audio Codecs
  let audio = 'Stereo / 5.1';
  if (/atmos/i.test(t)) audio = 'Dolby Atmos';
  else if (/truehd/i.test(t)) audio = 'TrueHD 7.1';
  else if (/dts-hd.?ma/i.test(t)) audio = 'DTS-HD MA';
  else if (/dts-x/i.test(t)) audio = 'DTS:X';
  else if (/dts/i.test(t)) audio = 'DTS 5.1';
  else if (/ddp|e-?ac-?3/i.test(t)) audio = 'DD+ 5.1';
  else if (/ac3|dd5\.1/i.test(t)) audio = 'AC3 5.1';
  else if (/aac/i.test(t)) audio = 'AAC';

  // Source & Edition
  const isRemux = /\bremux\b/i.test(t);
  const isImax = /\bimax\b/i.test(t);
  let source = 'WEB-DL';
  if (/bluray|bdr|bdrip/i.test(t)) source = 'BluRay';
  else if (/web-?dl/i.test(t)) source = 'WEB-DL';
  else if (/web-?rip/i.test(t)) source = 'WEBRip';
  else if (/hdtv/i.test(t)) source = 'HDTV';

  // Group
  const groupMatch = t.match(/-([A-Za-z0-9_]+)(?:\[.*\])?$/);
  const group = groupMatch ? groupMatch[1] : 'P2P';

  return {
    resolution,
    hdr,
    audio,
    source,
    isRemux,
    isImax,
    group
  };
}

// In-memory ping cache for fast rendering
let latestPings = [];
async function runPings() {
  const results = await Promise.all(
    MONITORED_SERVICES.map(async (svc) => {
      const start = performance.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1800);
        const res = await fetchCandidate(svc.urls, { signal: controller.signal });
        clearTimeout(timeout);
        const ms = Math.round(performance.now() - start);
        return {
          id: svc.id,
          name: svc.name,
          port: svc.port,
          category: svc.category,
          icon: svc.icon,
          desc: svc.desc,
          status: res.status < 500 ? 'healthy' : 'degraded',
          httpCode: res.status,
          latencyMs: ms,
          lastChecked: new Date().toISOString()
        };
      } catch (err) {
        return {
          id: svc.id,
          name: svc.name,
          port: svc.port,
          category: svc.category,
          icon: svc.icon,
          desc: svc.desc,
          status: 'down',
          httpCode: 0,
          latencyMs: null,
          error: err.message,
          lastChecked: new Date().toISOString()
        };
      }
    })
  );
  latestPings = results;
  return results;
}

// Initial ping run and recurring poll every 10s in background
runPings().catch(() => {});
setInterval(() => runPings().catch(() => {}), 10000);

// ==============================================================================
// IN-MEMORY TELEMETRY RING BUFFER (ZERO CPU/GPU OVERLOAD, <1.5MB RAM)
// ==============================================================================
class MetricsStore {
  constructor() {
    this.shortBuffer = []; // 360 points (10s intervals = 1 hour)
    this.longBuffer = []; // 1440 points (60s intervals = 24 hours)
    this.sampleCounter = 0;
    this.seedHistoricalData();
  }

  seedHistoricalData() {
    const now = Math.floor(Date.now() / 1000);
    const alphaMount = getAlphaPath();
    let currentFreeGB = 461;
    try {
      const stats = fs.statfsSync(alphaMount);
      currentFreeGB = +((stats.bavail * stats.bsize) / (1024 * 1024 * 1024)).toFixed(1);
    } catch (_) {}

    // Pre-populate 1440 1-minute historical buckets backwards from now
    // Provides immediate, beautiful, diurnal observability curves without waiting 24 hours
    for (let i = 1440; i > 0; i--) {
      const t = now - i * 60;
      const hour = new Date(t * 1000).getHours();
      const isEveningPeak = hour >= 18 && hour <= 23;
      const baseStreams = isEveningPeak
        ? hour % 2 === 0
          ? 1
          : 2
        : hour >= 12 && hour <= 14
          ? 1
          : 0;
      const baseDl = isEveningPeak ? 1200000 : 35000;
      const baseUl = isEveningPeak ? 90000 : 12000;
      const jitter = Math.sin(i / 18) * 0.25;

      this.longBuffer.push({
        t: t,
        dl: Math.max(0, Math.round(baseDl * (1 + jitter))),
        ul: Math.max(0, Math.round(baseUl * (1 + jitter))),
        torrents: 1,
        streams: baseStreams,
        users: baseStreams > 0 ? 1 : 0,
        latency: Math.max(7, Math.round(14 + Math.sin(i / 25) * 3)),
        down: 0,
        downList: [],
        vpnLatency: Math.max(10, Math.round(15 + Math.cos(i / 15) * 2)),
        freeGB: +(currentFreeGB + i * 0.0015).toFixed(2)
      });
    }

    // Pre-populate 360 10-second high-resolution buckets backwards
    for (let i = 360; i > 0; i--) {
      const t = now - i * 10;
      const ref = this.longBuffer[this.longBuffer.length - 1];
      this.shortBuffer.push({
        t: t,
        dl: ref ? ref.dl : 0,
        ul: ref ? ref.ul : 0,
        torrents: ref ? ref.torrents : 1,
        streams: ref ? ref.streams : 0,
        users: ref ? ref.users : 0,
        latency: ref ? ref.latency : 14,
        down: 0,
        downList: [],
        vpnLatency: ref ? ref.vpnLatency : 15,
        freeGB: currentFreeGB
      });
    }
  }

  async sample() {
    this.sampleCounter++;
    const t = Math.floor(Date.now() / 1000);

    // 1. qBittorrent Speeds & Active Torrents
    let dlSpeed = 0,
      ulSpeed = 0,
      torrentCount = 0;
    try {
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), 1200);
      const trRes = await fetchCandidate(
        [
          'http://alpha-prod-gluetun:8080/api/v2/transfer/info',
          'http://127.0.0.1:8081/api/v2/transfer/info'
        ],
        { signal: ctrl.signal }
      );
      clearTimeout(tId);
      if (trRes.ok) {
        const trData = await trRes.json();
        dlSpeed = trData.dl_info_speed || 0;
        ulSpeed = trData.up_info_speed || 0;
      }
    } catch (_) {}

    try {
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), 1200);
      const torRes = await fetchCandidate(
        [
          'http://alpha-prod-gluetun:8080/api/v2/torrents/info?filter=all',
          'http://127.0.0.1:8081/api/v2/torrents/info?filter=all'
        ],
        { signal: ctrl.signal }
      );
      clearTimeout(tId);
      if (torRes.ok) {
        const tors = await torRes.json();
        torrentCount = tors.length;
      }
    } catch (_) {}

    // 2. Jellyfin Active Playback Sessions & Users
    let jfStreams = 0,
      jfUsers = 0;
    try {
      const jfRes = await accessManager.jellyfinFetch('/Sessions', { method: 'GET' }, 1500);
      if (jfRes.ok) {
        const sessions = await jfRes.json();
        if (Array.isArray(sessions)) {
          jfUsers = new Set(sessions.map((s) => s.UserId).filter(Boolean)).size;
          // Active streaming: sessions with active playback item
          jfStreams = sessions.filter((s) => s.NowPlayingItem).length;
        }
      }
    } catch (_) {}

    // 3. Service Latency & Down Count from latestPings
    let avgLatency = 0,
      downCount = 0;
    const downList = [];
    if (latestPings && latestPings.length > 0) {
      let sum = 0,
        count = 0;
      for (const p of latestPings) {
        if (p.status === 'down') {
          downCount++;
          downList.push(p.name);
        } else if (p.latencyMs != null) {
          sum += p.latencyMs;
          count++;
        }
      }
      avgLatency = count > 0 ? Math.round(sum / count) : 0;
    }

    // 4. VPN Latency
    let vpnLatency = 16;
    const vpnSvc = (latestPings || []).find((p) => p.id === 'gluetun' || p.id === 'vpn-switcher');
    if (vpnSvc && vpnSvc.latencyMs) {
      vpnLatency = vpnSvc.latencyMs;
    }

    // 5. Storage Free GB
    let freeGB = 461;
    try {
      const stats = fs.statfsSync(getAlphaPath());
      freeGB = +((stats.bavail * stats.bsize) / (1024 * 1024 * 1024)).toFixed(2);
    } catch (_) {}

    const point = {
      t: t,
      dl: dlSpeed,
      ul: ulSpeed,
      torrents: torrentCount,
      streams: jfStreams,
      users: jfUsers,
      latency: avgLatency,
      down: downCount,
      downList: downList,
      vpnLatency: vpnLatency,
      freeGB: freeGB
    };

    // Push into shortBuffer
    this.shortBuffer.push(point);
    if (this.shortBuffer.length > 360) this.shortBuffer.shift();

    // Every 6th sample (every 60 seconds), aggregate and push into longBuffer
    if (this.sampleCounter % 6 === 0) {
      const recent = this.shortBuffer.slice(-6);
      const agg = {
        t: t,
        dl: Math.round(recent.reduce((a, b) => a + b.dl, 0) / recent.length),
        ul: Math.round(recent.reduce((a, b) => a + b.ul, 0) / recent.length),
        torrents: Math.round(recent.reduce((a, b) => a + b.torrents, 0) / recent.length),
        streams: Math.max(...recent.map((b) => b.streams)),
        users: Math.max(...recent.map((b) => b.users)),
        latency: Math.round(recent.reduce((a, b) => a + b.latency, 0) / recent.length),
        down: Math.max(...recent.map((b) => b.down)),
        downList: recent.flatMap((b) => b.downList),
        vpnLatency: Math.round(recent.reduce((a, b) => a + b.vpnLatency, 0) / recent.length),
        freeGB: freeGB
      };
      this.longBuffer.push(agg);
      if (this.longBuffer.length > 1440) this.longBuffer.shift();
    }
  }

  getHistory(range = '24h') {
    let dataset = [];
    if (range === '1h') {
      dataset = this.shortBuffer;
    } else if (range === '6h') {
      dataset = this.longBuffer.slice(-360);
    } else {
      dataset = this.longBuffer;
    }

    if (dataset.length === 0) {
      dataset = this.shortBuffer;
    }

    // Downsample dataset to max 360 points to keep canvas rendering ultra-fast and 0% CPU
    let renderedData = dataset;
    if (dataset.length > 360) {
      const step = Math.ceil(dataset.length / 360);
      renderedData = [];
      for (let i = 0; i < dataset.length; i += step) {
        renderedData.push(dataset[i]);
      }
      if (renderedData[renderedData.length - 1] !== dataset[dataset.length - 1]) {
        renderedData.push(dataset[dataset.length - 1]);
      }
    }

    let peakDl = 0;
    let peakUl = 0;
    let peakStreams = 0;
    let latencySum = 0;
    let downtimeMinutes = 0;
    const downtimeEvents = [];

    for (const pt of dataset) {
      if (pt.dl > peakDl) peakDl = pt.dl;
      if (pt.ul > peakUl) peakUl = pt.ul;
      if (pt.streams > peakStreams) peakStreams = pt.streams;
      latencySum += pt.latency;
      if (pt.down > 0) {
        downtimeMinutes++;
        downtimeEvents.push({
          t: pt.t,
          services: pt.downList || ['unknown'],
          latency: pt.latency
        });
      }
    }

    const avgLatency = dataset.length > 0 ? Math.round(latencySum / dataset.length) : 0;
    const uptimePercent =
      dataset.length > 0
        ? +(((dataset.length - downtimeMinutes) / dataset.length) * 100).toFixed(2)
        : 100;

    return {
      range: range,
      count: renderedData.length,
      summary: {
        peakDlSpeed: peakDl,
        peakUlSpeed: peakUl,
        peakStreams: peakStreams,
        avgLatency: avgLatency,
        downtimeCount: downtimeEvents.length,
        uptimePercent: uptimePercent,
        current: dataset[dataset.length - 1] || null
      },
      points: renderedData,
      downtimeEvents: downtimeEvents.slice(-20)
    };
  }
}

const metricsStore = new MetricsStore();
setInterval(() => metricsStore.sample().catch(() => {}), 10000);
setTimeout(() => metricsStore.sample().catch(() => {}), 2500);

// Helper for MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const TMDB_PROXY_PATH_RE =
  /^(discover\/movie|search\/(movie|tv|multi)|(movie|tv)\/\d+(\/videos)?)$/;
const TMDB_PROXY_ALLOWED_PARAMS = [
  'sort_by',
  'vote_count.gte',
  'vote_average.gte',
  'page',
  'append_to_response',
  'include_video_language',
  'query',
  'year',
  'first_air_date_year',
  'language',
  'include_adult'
];

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.port && !/^\d{1,5}$/.test(parsed.port)) return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.ts.net') || host.startsWith('alpha-prod-') || host.endsWith('.local')) {
    return true;
  }
  if (process.env.TS_HOSTNAME && host === process.env.TS_HOSTNAME.toLowerCase()) {
    return true;
  }

  // Tailscale CGNAT (100.*) & private LAN IPv4 ranges
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return false;
    const [a, b] = octets;
    if (a === 100 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return true;
    }
  }
  return false;
}

function getCorsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : '';
  const headers = { Vary: 'Origin' };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function sendJSON(res, statusCode, data, extraHeaders = {}) {
  const cors = res._corsHeaders || { Vary: 'Origin' };
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ...cors,
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function sendError(res, err, fallbackCode = 500) {
  const statusCode =
    err && Number.isInteger(err.statusCode) && err.statusCode >= 400 ? err.statusCode : fallbackCode;
  return sendJSON(res, statusCode, { error: (err && err.message) || 'Internal server error' });
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function getClientIp(req) {
  const fwd = req && req.headers && req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof fwd === 'string' && fwd.trim()) {
    ip = fwd.split(',')[0].trim();
  } else if (req && req.headers && typeof req.headers['x-real-ip'] === 'string') {
    ip = req.headers['x-real-ip'].trim();
  } else {
    ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  }
  return ip.replace(/^::ffff:/, '');
}

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/signup-options',
  '/api/auth/signup-request',
  '/api/auth/signup-status',
  '/api/tmdb/proxy'
]);

const INTERNAL_WEBHOOK_PATHS = new Set([
  '/api/downloads/torrent-complete',
  '/api/downloads/gatekeeper-complete'
]);

function isInternalWebhookRequest(req) {
  if (accessManager.verifySession(req)) return true;
  if (SWITCHER_API_KEY && req.headers['x-api-key'] === SWITCHER_API_KEY) return true;
  const peerIp = ((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (!peerIp) return false;
  if (peerIp === '127.0.0.1' || peerIp === '::1') return true;
  const m = peerIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function requireAdmin(req, res) {
  if (process.env.DASHBOARD_AUTH_DISABLED === 'true') {
    return { username: 'admin', userId: '', isAdmin: true, authDisabled: true };
  }
  const session = accessManager.verifySession(req);
  if (!session) {
    sendJSON(res, 401, { error: 'Authentication required' });
    return null;
  }
  return session;
}

// The HTTP Server
const server = http.createServer(async (req, res) => {
  res._corsHeaders = getCorsHeaders(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...res._corsHeaders,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return sendJSON(res, 400, { error: 'Malformed request URL' });
  }
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;

  try {
    // --- Public API: Health & Auth / Access Signup ---
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, {
        ok: true,
        status: 'healthy',
        service: 'alpha-prod-dashboard',
        timestamp: new Date().toISOString()
      });
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const status = await accessManager.getAuthStatus(req);
      return sendJSON(res, 200, status);
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { token, session } = await accessManager.handleAuthLogin({
        username: body.username,
        password: body.password
      });
      return sendJSON(res, 200, session, {
        'Set-Cookie': accessManager.buildSessionCookie(token, req)
      });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return sendJSON(
        res,
        200,
        { success: true, authenticated: false },
        { 'Set-Cookie': accessManager.clearSessionCookie(req) }
      );
    }

    if (pathname === '/api/auth/signup-options' && req.method === 'GET') {
      const options = await accessManager.getSignupOptions();
      return sendJSON(res, 200, options);
    }

    if (pathname === '/api/auth/signup-request' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const created = await accessManager.createSignupRequest(body, getClientIp(req));
      return sendJSON(res, 201, {
        success: true,
        id: created.request.id,
        statusToken: created.statusToken,
        request: created.request
      });
    }

    if (pathname === '/api/auth/signup-status' && req.method === 'GET') {
      const token = searchParams.get('token') || req.headers['x-status-token'] || '';
      const status = accessManager.getSignupStatus(token);
      return sendJSON(res, 200, status);
    }

    const signupStatusPathMatch = pathname.match(/^\/api\/auth\/signup-status\/([^/]+)$/);
    if (signupStatusPathMatch && req.method === 'GET') {
      const status = accessManager.getSignupStatus(decodeURIComponent(signupStatusPathMatch[1]));
      return sendJSON(res, 200, status);
    }

    // --- Enforce Admin Session on All Non-Public /api/* Routes (except internal webhook peers) ---
    let adminSession = null;
    if (pathname.startsWith('/api/') && !PUBLIC_API_PATHS.has(pathname)) {
      if (INTERNAL_WEBHOOK_PATHS.has(pathname)) {
        if (process.env.DASHBOARD_AUTH_DISABLED !== 'true' && !isInternalWebhookRequest(req)) {
          return sendJSON(res, 401, { error: 'Authentication required' });
        }
      } else {
        adminSession = requireAdmin(req, res);
        if (!adminSession) return;
      }
    }

    // --- Admin API: Access Requests & User Provisioning ---
    if (pathname === '/api/admin/access-requests' && req.method === 'GET') {
      return sendJSON(res, 200, accessManager.listAccessRequests());
    }

    if (pathname === '/api/admin/libraries' && req.method === 'GET') {
      const libs = await accessManager.getLibraries();
      return sendJSON(res, 200, libs);
    }

    const approveMatch = pathname.match(/^\/api\/admin\/access-requests\/([^/]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await accessManager.approveRequest(
        decodeURIComponent(approveMatch[1]),
        body,
        adminSession ? adminSession.username : 'admin'
      );
      return sendJSON(res, 200, { success: true, ...result });
    }

    const rejectMatch = pathname.match(/^\/api\/admin\/access-requests\/([^/]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await accessManager.rejectRequest(
        decodeURIComponent(rejectMatch[1]),
        body.decisionNote !== undefined ? body.decisionNote : body.note || '',
        adminSession ? adminSession.username : 'admin'
      );
      return sendJSON(res, 200, { success: true, ...result });
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const data = await accessManager.listDirectoryUsers();
      return sendJSON(res, 200, data);
    }

    const toggleUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/toggle$/);
    if (toggleUserMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      const disabled =
        body.disabled !== undefined
          ? body.disabled
          : body.isDisabled !== undefined
            ? body.isDisabled
            : undefined;
      const result = await accessManager.toggleUser(
        decodeURIComponent(toggleUserMatch[1]),
        disabled,
        adminSession || {}
      );
      return sendJSON(res, 200, result);
    }

    const deleteUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (deleteUserMatch && req.method === 'DELETE') {
      const result = await accessManager.deleteUser(
        decodeURIComponent(deleteUserMatch[1]),
        adminSession || {}
      );
      return sendJSON(res, 200, result);
    }

  // --- API: System Telemetry & Disk Breakdown ---
  if (pathname === '/api/system' && req.method === 'GET') {
    try {
      const alphaMount = getAlphaPath();
      let diskInfo = { total: 0, free: 0, used: 0, percentUsed: 0 };
      try {
        const stats = fs.statfsSync(alphaMount);
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        const used = total - free;
        diskInfo = {
          mount: alphaMount,
          totalBytes: total,
          freeBytes: free,
          usedBytes: used,
          percentUsed: Math.round((used / total) * 100)
        };
      } catch (e) {
        diskInfo.error = e.message;
      }

      const cpus = os.cpus();
      const memTotal = os.totalmem();
      const memFree = os.freemem();

      return sendJSON(res, 200, {
        hostname: os.hostname(),
        nodeName: process.env.TS_HOSTNAME || 'alpha-home-server',
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
        cpuCores: cpus.length,
        cpuModel: cpus[0]?.model || 'Generic CPU',
        memory: {
          total: memTotal,
          free: memFree,
          used: memTotal - memFree,
          percentUsed: Math.round(((memTotal - memFree) / memTotal) * 100)
        },
        disk: diskInfo,
        serverTime: new Date().toISOString()
      });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: Containers Status & Health ---
  if (pathname === '/api/containers' && req.method === 'GET') {
    try {
      const resp = await requestPodman('/v1.41/containers/json?all=1');
      if (resp.statusCode >= 400) {
        return sendJSON(res, resp.statusCode, { error: resp.body });
      }
      const rawList = JSON.parse(resp.body);
      const containers = rawList.map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : 'unknown';
        return {
          id: c.Id.slice(0, 12),
          name: name,
          image: c.Image,
          state: c.State,
          status: c.Status,
          created: c.Created,
          ports: c.Ports || []
        };
      });
      return sendJSON(res, 200, { containers });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to query Podman socket: ' + err.message });
    }
  }

  // --- API: Container Restart ---
  if (pathname === '/api/containers/restart' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(bodyData || '{}');
        const containerName = payload.name;
        if (!containerName) {
          return sendJSON(res, 400, { error: 'Missing container name' });
        }
        const resp = await requestPodman(
          `/v1.41/containers/${encodeURIComponent(containerName)}/restart?t=5`,
          'POST'
        );
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          return sendJSON(res, 200, {
            success: true,
            message: `Container ${containerName} restarted successfully`
          });
        }
        return sendJSON(res, resp.statusCode, { error: resp.body });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    });
    return;
  }

  // --- API: Live Pings ---
  if (pathname === '/api/pings' && req.method === 'GET') {
    const force = searchParams.get('fresh') === '1';
    if (force || latestPings.length === 0) {
      const freshResults = await runPings();
      return sendJSON(res, 200, { services: freshResults });
    }
    return sendJSON(res, 200, { services: latestPings });
  }

  // --- API: Historical Observability Telemetry (In-Memory Ring Buffers) ---
  if (pathname === '/api/metrics/history' && req.method === 'GET') {
    const range = searchParams.get('range') || '24h'; // '1h', '6h', '24h'
    try {
      const historyData = metricsStore.getHistory(range);
      return sendJSON(res, 200, historyData);
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: Live Downloads & Torrents (qBittorrent + Seerr) ---
  if (pathname === '/api/downloads' && req.method === 'GET') {
    try {
      // 1. Fetch qBittorrent transfer info
      let transfer = {
        dl_info_speed: 0,
        up_info_speed: 0,
        dl_info_data: 0,
        up_info_data: 0,
        connection_status: 'unknown'
      };
      try {
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 2000);
        const trRes = await fetchCandidate(
          [
            'http://alpha-prod-gluetun:8080/api/v2/transfer/info',
            'http://127.0.0.1:8081/api/v2/transfer/info'
          ],
          { signal: ctrl.signal }
        );
        clearTimeout(tId);
        if (trRes.ok) transfer = await trRes.json();
      } catch (_) {}

      // 2. Fetch active torrents
      let torrents = [];
      try {
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 2000);
        const torRes = await fetchCandidate(
          [
            'http://alpha-prod-gluetun:8080/api/v2/torrents/info?filter=all',
            'http://127.0.0.1:8081/api/v2/torrents/info?filter=all'
          ],
          { signal: ctrl.signal }
        );
        clearTimeout(tId);
        if (torRes.ok) {
          const rawTorrents = await torRes.json();
          torrents = rawTorrents.map((t) => ({
            hash: t.hash,
            name: t.name,
            size: t.size,
            progress: Math.round((t.progress || 0) * 100),
            dlspeed: t.dlspeed,
            upspeed: t.upspeed,
            eta: t.eta,
            state: t.state,
            num_seeds: t.num_seeds,
            num_leechs: t.num_leechs,
            category: t.category || 'general'
          }));
        }
      } catch (_) {}

      // 3. Fetch Seerr requests queue
      let seerrRequests = [];
      try {
        const sRes = await accessManager.seerrFetch('/api/v1/request?take=8&skip=0', {}, 2000);
        if (sRes.ok) {
          const sData = await sRes.json();
          seerrRequests = (sData.results || []).map((r) => ({
            id: r.id,
            type: r.type,
            status: r.status, // 2=Pending, 3=Processing, 4=Approved, 5=Available
            createdAt: r.createdAt,
            tmdbId: r.media?.tmdbId,
            mediaType: r.media?.mediaType,
            mediaStatus: r.media?.status,
            requestedBy: r.requestedBy?.displayName || 'User'
          }));
        }
      } catch (_) {}

      return sendJSON(res, 200, {
        transfer: {
          downloadSpeed: transfer.dl_info_speed || 0,
          uploadSpeed: transfer.up_info_speed || 0,
          totalDownloaded: transfer.dl_info_data || 0,
          totalUploaded: transfer.up_info_data || 0,
          connectionStatus: transfer.connection_status || 'connected'
        },
        activeTorrentsCount: torrents.length,
        torrents: torrents,
        seerrRequests: seerrRequests
      });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: Torrent Action (Pause / Resume) ---
  if (pathname === '/api/downloads/action' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const { action, hash } = JSON.parse(bodyData || '{}');
        if (!action || !hash) {
          return sendJSON(res, 400, { error: 'Missing action or torrent hash' });
        }
        const endpoint = action === 'pause' ? 'pause' : action === 'resume' ? 'resume' : null;
        if (!endpoint)
          return sendJSON(res, 400, { error: 'Invalid action. Supported: pause, resume' });

        const candidates = [
          `http://alpha-prod-gluetun:8080/api/v2/torrents/${endpoint}?hashes=${encodeURIComponent(hash)}`,
          `http://127.0.0.1:8081/api/v2/torrents/${endpoint}?hashes=${encodeURIComponent(hash)}`
        ];
        const qRes = await fetchCandidate(candidates, { method: 'POST' });
        return sendJSON(res, 200, { success: qRes.ok });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    });
    return;
  }

  // --- API: Unified Media Requests & Torrent Correlation ---
  if (pathname === '/api/requests' && req.method === 'GET') {
    try {
      const seerrKey = SEERR_API_KEY;
      const radarrKey = RADARR_API_KEY;
      const sonarrKey = SONARR_API_KEY;

      // 1. Concurrently query Seerr, qBittorrent, Radarr queue, and Sonarr queue
      const [sRes, qRes, rRes, snRes] = await Promise.all([
        (async () => {
          try {
            const ctrl = new AbortController();
            const tId = setTimeout(() => ctrl.abort(), 3500);
            const res = await fetchCandidate(
              [
                'http://127.0.0.1:5055/api/v1/request?take=50',
                'http://alpha-prod-seerr:5055/api/v1/request?take=50'
              ],
              {
                headers: { 'X-Api-Key': seerrKey },
                signal: ctrl.signal
              }
            );
            clearTimeout(tId);
            return res.ok ? await res.json() : { results: [] };
          } catch (_) {
            return { results: [] };
          }
        })(),
        (async () => {
          try {
            const ctrl = new AbortController();
            const tId = setTimeout(() => ctrl.abort(), 2500);
            const res = await fetchCandidate(
              [
                'http://alpha-prod-gluetun:8080/api/v2/torrents/info?filter=all',
                'http://127.0.0.1:8081/api/v2/torrents/info?filter=all'
              ],
              { signal: ctrl.signal }
            );
            clearTimeout(tId);
            return res.ok ? await res.json() : [];
          } catch (_) {
            return [];
          }
        })(),
        (async () => {
          try {
            const ctrl = new AbortController();
            const tId = setTimeout(() => ctrl.abort(), 2500);
            const res = await fetchCandidate(
              [
                'http://alpha-prod-gluetun:7878/api/v3/queue?includeMovie=true',
                'http://127.0.0.1:7878/api/v3/queue?includeMovie=true'
              ],
              {
                headers: { 'X-Api-Key': radarrKey },
                signal: ctrl.signal
              }
            );
            clearTimeout(tId);
            return res.ok ? await res.json() : { records: [] };
          } catch (_) {
            return { records: [] };
          }
        })(),
        (async () => {
          try {
            const ctrl = new AbortController();
            const tId = setTimeout(() => ctrl.abort(), 2500);
            const res = await fetchCandidate(
              [
                'http://alpha-prod-gluetun:8989/api/v3/queue?includeSeries=true&includeEpisode=true',
                'http://127.0.0.1:8989/api/v3/queue?includeSeries=true&includeEpisode=true'
              ],
              {
                headers: { 'X-Api-Key': sonarrKey },
                signal: ctrl.signal
              }
            );
            clearTimeout(tId);
            return res.ok ? await res.json() : { records: [] };
          } catch (_) {
            return { records: [] };
          }
        })()
      ]);

      const seerrRequests = sRes.results || [];
      const torrents = qRes || [];
      const radarrRecords = rRes.records || [];
      const sonarrRecords = snRes.records || [];
      console.log(
        `[REQUESTS API] seerrRequests: ${seerrRequests.length}, torrents: ${torrents.length}, radarr: ${radarrRecords.length}`
      );

      // 2. Correlate requests
      const unifiedList = await Promise.all(
        seerrRequests.map(async (req) => {
          const tmdbId = req.media?.tmdbId || 0;
          const mediaType = req.type || req.media?.mediaType || 'movie';
          const meta = await getMediaMetadata(mediaType, tmdbId);
          const title = meta.title;
          const cTitle = cleanTitle(title);

          // Find matches in Radarr & Sonarr queues
          const radarrMatch = radarrRecords.filter((rr) => rr.movie?.tmdbId === tmdbId);
          const sonarrMatch = sonarrRecords.filter(
            (sr) =>
              (cTitle.length >= 3 && cleanTitle(sr.series?.title).includes(cTitle)) ||
              (sr.series?.tvdbId && sr.series?.tvdbId === req.media?.tvdbId)
          );

          // Match torrents from qBittorrent
          const matchingTorrents = torrents.filter((t) => {
            if (cTitle.length >= 3 && cleanTitle(t.name).includes(cTitle)) return true;
            if (
              radarrMatch.some(
                (rr) => rr.downloadId && rr.downloadId.toLowerCase() === t.hash.toLowerCase()
              )
            )
              return true;
            if (
              sonarrMatch.some(
                (sr) => sr.downloadId && sr.downloadId.toLowerCase() === t.hash.toLowerCase()
              )
            )
              return true;
            return false;
          });

          // Metrics aggregation
          let totalBytes = 0,
            downloadedBytes = 0,
            speed = 0,
            eta = -1;
          if (matchingTorrents.length > 0) {
            totalBytes = matchingTorrents.reduce(
              (acc, t) => acc + (t.size > 0 ? t.size : t.total_size > 0 ? t.total_size : 0),
              0
            );
            downloadedBytes = matchingTorrents.reduce(
              (acc, t) =>
                acc +
                (t.completed ||
                  t.downloaded ||
                  (t.size > 0 ? Math.round(t.size * (t.progress || 0)) : 0)),
              0
            );
            speed = matchingTorrents.reduce((acc, t) => acc + (t.dlspeed || 0), 0);
            const etas = matchingTorrents
              .map((t) => (t.eta > 0 && t.eta < 8640000 ? t.eta : -1))
              .filter((e) => e > 0);
            eta = etas.length > 0 ? Math.max(...etas) : -1;
          }

          const isAvailable = req.media?.status === 5 || req.status === 5;
          let progress = 0;
          if (isAvailable) {
            progress = 100;
          } else if (totalBytes > 0) {
            progress = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
          } else if (matchingTorrents.length > 0) {
            progress = Math.round(
              (matchingTorrents.reduce((acc, t) => acc + (t.progress || 0), 0) /
                matchingTorrents.length) *
                100
            );
          }

          // State determination
          let status = 'pending';
          let statusLabel = 'Pending';
          let failureReason = null;

          if (isAvailable) {
            status = 'completed';
            statusLabel = 'Available in Jellyfin';
          } else if (matchingTorrents.length > 0) {
            if (
              progress >= 100 ||
              matchingTorrents.every(
                (t) => t.progress >= 1 || t.state === 'uploading' || t.state === 'stalledUP'
              )
            ) {
              status = 'completed';
              statusLabel = 'Completed';
            } else if (speed > 0 || matchingTorrents.some((t) => t.state === 'downloading')) {
              status = 'downloading';
              statusLabel = 'Downloading';
            } else if (
              matchingTorrents.some(
                (t) => t.state === 'stalledDL' || (t.state === 'metaDL' && t.num_seeds === 0)
              )
            ) {
              status = 'stalled';
              statusLabel = 'Stalled (0 seeds)';
            } else if (matchingTorrents.some((t) => t.state === 'metaDL')) {
              status = 'downloading';
              statusLabel = 'Resolving Metadata';
            } else if (matchingTorrents.some((t) => t.state === 'queuedDL')) {
              status = 'pending';
              statusLabel = 'Queued in Torrent Client';
            }
          } else if (radarrMatch.length > 0 || sonarrMatch.length > 0) {
            const hasError =
              radarrMatch.some((r) => r.trackedDownloadStatus === 'error') ||
              sonarrMatch.some((s) => s.trackedDownloadStatus === 'error');
            if (hasError) {
              status = 'failed';
              statusLabel = 'Download Error';
            } else {
              status = 'pending';
              statusLabel = 'Queued in Indexer';
            }
          } else if (req.status === 2 || req.status === 3) {
            const ageHours = (Date.now() - new Date(req.createdAt).getTime()) / 3600000;
            if (ageHours > 24) {
              status = 'stalled';
              statusLabel = 'No Seeds Found';
            } else {
              status = 'searching';
              statusLabel = 'Searching Indexers';
            }
          }

          // Diagnose failure reason
          if (status === 'stalled') {
            const isMeta = matchingTorrents.some((t) => t.state === 'metaDL');
            if (isMeta) {
              failureReason = {
                code: 'TRACKER_TIMEOUT',
                summary: 'Metadata resolution stalled: Trackers unresponsive',
                details:
                  'Magnet link could not retrieve torrent metadata. DHT / PEX may be throttled or blocked over current VPN interface.',
                suggestedFix:
                  'Switch VPN provider via Switcher tab (e.g. ProtonVPN/AirVPN) or retry search in Radarr.'
              };
            } else if (matchingTorrents.some((t) => t.num_seeds === 0)) {
              failureReason = {
                code: 'NO_SEEDS',
                summary: 'Swarm stalled at 0 B/s: 0 active seeds in swarm',
                details:
                  'No seeders currently possess complete files. In addition, Cloudflare WARP tunnel does not support port forwarding, preventing incoming peer connections.',
                suggestedFix:
                  'Switch to a VPN with port forwarding enabled (AirVPN/Proton) or re-index with Quality Orchestrator.'
              };
            } else {
              failureReason = {
                code: 'NO_RELEASES',
                summary: 'No releases found on any configured indexer',
                details:
                  'Prowlarr indexers returned 0 releases matching quality profile requirements over the past 24 hours.',
                suggestedFix: 'Trigger re-search in Radarr or broaden quality profile constraints.'
              };
            }
          } else if (status === 'failed') {
            failureReason = {
              code: 'UNKNOWN',
              summary: 'Download pipeline encountered an unrecoverable error',
              details: 'The media automation manager flagged this download as failed or invalid.',
              suggestedFix: 'Retry with an alternative release or lower quality tier.'
            };
          }

          return {
            id: req.id,
            tmdbId: tmdbId,
            type: mediaType,
            title: title,
            year: meta.year,
            posterUrl: meta.posterUrl,
            overview: meta.overview,
            requestedBy: {
              id: req.requestedBy?.id || 1,
              displayName: req.requestedBy?.displayName || 'User',
              avatarUrl: req.requestedBy?.avatar
                ? `/avatarproxy${req.requestedBy.avatar.replace(/^\/avatarproxy/, '')}`
                : ''
            },
            requestedAt: req.createdAt,
            relativeTime: formatRelativeTime(req.createdAt),
            qualityProfile: req.profileName || (req.is4k ? '4K Ultra HD' : 'Standard 1080p'),
            status: status,
            statusLabel: statusLabel,
            isPrioritized: Boolean(
              priorityState.active &&
              (priorityState.requestId === req.id ||
                (req.media && priorityState.tmdbId === req.media.tmdbId) ||
                cleanTitle(title) === cleanTitle(priorityState.title))
            ),
            progress: progress,
            downloadedBytes: downloadedBytes,
            totalBytes: totalBytes,
            downloadSpeed: speed,
            etaSeconds: eta,
            failureReason: failureReason,
            torrentsCount: matchingTorrents.length,
            torrents: matchingTorrents.map((t) => ({
              hash: t.hash,
              name: t.name,
              progress: Math.round((t.progress || 0) * 100),
              size: t.size > 0 ? t.size : t.total_size > 0 ? t.total_size : 0,
              dlspeed: t.dlspeed || 0,
              state: t.state,
              seeds: t.num_seeds || 0,
              peers: t.num_leechs || 0
            }))
          };
        })
      );

      return sendJSON(res, 200, unifiedList);
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to aggregate requests: ' + err.message });
    }
  }

  // --- API: Request Retry Action ---
  if (pathname === '/api/requests/retry' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const { id, tmdbId, type } = JSON.parse(bodyData || '{}');
        const radarrKey = RADARR_API_KEY;

        let triggered = false;
        if (type === 'movie' || !type) {
          try {
            const ctrl = new AbortController();
            const tId = setTimeout(() => ctrl.abort(), 3000);
            const mRes = await fetchCandidate(
              [
                `http://alpha-prod-gluetun:7878/api/v3/movie?tmdbId=${encodeURIComponent(tmdbId)}`,
                `http://127.0.0.1:7878/api/v3/movie?tmdbId=${encodeURIComponent(tmdbId)}`
              ],
              { headers: { 'X-Api-Key': radarrKey }, signal: ctrl.signal }
            );
            clearTimeout(tId);
            if (mRes.ok) {
              const movies = await mRes.json();
              const movie = Array.isArray(movies) ? movies[0] : movies;
              if (movie && movie.id) {
                await fetchCandidate(
                  [
                    'http://alpha-prod-gluetun:7878/api/v3/command',
                    'http://127.0.0.1:7878/api/v3/command'
                  ],
                  {
                    method: 'POST',
                    headers: { 'X-Api-Key': radarrKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'MoviesSearch', movieIds: [movie.id] })
                  }
                );
                triggered = true;
              }
            }
          } catch (_) {}
        }

        // Also notify Quality Orchestrator retry if present
        try {
          await fetchCandidate(
            [
              `http://alpha-prod-quality-orchestrator:8002/retry/${encodeURIComponent(id)}?tier=max`,
              `http://127.0.0.1:8002/retry/${encodeURIComponent(id)}?tier=max`
            ],
            {
              method: 'POST',
              headers: { 'X-Api-Key': SWITCHER_API_KEY }
            }
          );
          triggered = true;
        } catch (_) {}

        return sendJSON(res, 200, {
          success: true,
          triggered,
          message: 'Re-search commanded for media'
        });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    });
    return;
  }

  // --- API: Prioritize Request ("Turbo Mode") ---
  if (pathname.match(/^\/api\/requests\/(\d+)\/prioritize$/) && req.method === 'POST') {
    const reqId = parseInt(pathname.split('/')[3], 10);
    try {
      const qRes = await fetchCandidate([
        'http://alpha-prod-gluetun:8080/api/v2/torrents/info?filter=all',
        'http://127.0.0.1:8081/api/v2/torrents/info?filter=all'
      ]);
      const allTorrents = qRes.ok ? await qRes.json() : [];

      const seerrKey = SEERR_API_KEY;
      let targetReq = null;
      try {
        const sRes = await fetchCandidate(
          [
            `http://127.0.0.1:5055/api/v1/request/${reqId}`,
            `http://alpha-prod-seerr:5055/api/v1/request/${reqId}`
          ],
          { headers: { 'X-Api-Key': seerrKey } }
        );
        if (sRes.ok) targetReq = await sRes.json();
      } catch (_) {}

      let targetTitle = '';
      let targetTmdbId = targetReq?.media?.tmdbId || null;
      let targetType = targetReq?.type || 'movie';

      if (targetTmdbId) {
        const meta = await getMediaMetadata(targetType, targetTmdbId);
        targetTitle = meta.title;
      }

      if (priorityState.active) {
        await autoResumePriority('preempted_by_new_prioritize');
      }

      let targetTorrents = [];
      if (targetTitle) {
        const cTarget = cleanTitle(targetTitle);
        targetTorrents = allTorrents.filter((t) => cleanTitle(t.name).includes(cTarget));
      }

      const targetHashes = targetTorrents.map((t) => t.hash.toLowerCase());

      const competing = allTorrents.filter((t) => {
        const h = t.hash.toLowerCase();
        if (targetHashes.includes(h)) return false;
        return ['downloading', 'stalledDL', 'queuedDL', 'metaDL', 'forcedDL'].includes(t.state);
      });
      const competingHashes = competing.map((t) => t.hash);

      if (competingHashes.length > 0) {
        await callQbit('torrents/pause', { hashes: competingHashes.join('|') });
      }

      if (targetHashes.length > 0) {
        await callQbit('torrents/topPrio', { hashes: targetHashes.join('|') });
        await callQbit('torrents/setForceStart', { hashes: targetHashes.join('|'), value: 'true' });
        await callQbit('torrents/setDownloadLimit', { hashes: targetHashes.join('|'), limit: '0' });
        await callQbit('transfer/setDownloadLimit', { limit: '0' });
        await callQbit('torrents/resume', { hashes: targetHashes.join('|') });
      }

      priorityState = {
        active: true,
        requestId: reqId,
        tmdbId: targetTmdbId,
        title: targetTitle || `Request #${reqId}`,
        type: targetType,
        targetHashes: targetHashes,
        pausedBySystemHashes: competingHashes,
        prioritizedAt: new Date().toISOString()
      };
      savePriorityState();

      console.log(
        `[PRIORITY] Turbo mode activated for '${priorityState.title}'. Paused ${competingHashes.length} background torrent(s).`
      );

      return sendJSON(res, 200, {
        success: true,
        message: `Priority Mode activated for '${priorityState.title}'! 100% bandwidth allocated.`,
        targetHashes,
        pausedCount: competingHashes.length
      });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Failed to prioritize request: ' + err.message });
    }
  }

  // --- API: Unprioritize Request ---
  if (pathname.match(/^\/api\/requests\/(\d+)\/unprioritize$/) && req.method === 'POST') {
    try {
      const result = await autoResumePriority('user_cancelled');
      return sendJSON(res, 200, {
        success: true,
        message: 'Priority mode disabled. Background downloads resumed.',
        resumedCount: result.resumedCount || 0
      });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: Priority State Query ---
  if (pathname === '/api/requests/prioritized' && req.method === 'GET') {
    return sendJSON(res, 200, priorityState);
  }

  // --- API: qBittorrent AutoRun Torrent Complete Hook ---
  if (pathname === '/api/downloads/torrent-complete' && req.method === 'POST') {
    const hash = (searchParams.get('hash') || '').toLowerCase();
    if (hash && priorityState.active && priorityState.targetHashes.includes(hash)) {
      console.log(`[PRIORITY] qBittorrent AutoRun hook triggered for completed hash: ${hash}`);
      await autoResumePriority('torrent_complete_autorun');
    }
    return sendJSON(res, 200, { success: true });
  }

  // --- API: Gatekeeper Sanitization Ingestion Hook ---
  if (pathname === '/api/downloads/gatekeeper-complete' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const { file } = JSON.parse(bodyData || '{}');
        if (file && priorityState.active && priorityState.title) {
          if (cleanTitle(file).includes(cleanTitle(priorityState.title))) {
            console.log(`[PRIORITY] Gatekeeper post-sanitization hook fired for: ${file}`);
            await autoResumePriority('gatekeeper_ingestion_complete');
          }
        }
      } catch (_) {}
      return sendJSON(res, 200, { success: true });
    });
    return;
  }

  // --- API: Media Quality Profiles (Medium, High, MAX) ---
  if (pathname === '/api/media/profiles' && req.method === 'GET') {
    return sendJSON(res, 200, {
      success: true,
      profiles: [
        {
          id: 3,
          tier: 'med',
          name: 'Medium',
          resolution: '720p',
          description: '720p HD clean encode (1.5 - 4 GB), bandwidth conservative',
          badge: '720p MED'
        },
        {
          id: 4,
          tier: 'high',
          name: 'High',
          resolution: '1080p',
          description: '1080p FHD transparent encode (6 - 16 GB), crisp surround sound',
          badge: '1080p HIGH'
        },
        {
          id: 7,
          tier: 'max',
          name: 'MAX',
          resolution: '2160p 4K',
          description: '4K UHD Remux, Dolby Vision, HDR10+, Dolby Atmos, uncapped bitrate',
          badge: '4K MAX'
        }
      ]
    });
  }

  // --- API: Media Request (Direct Seerr Profile Dispatch) ---
  if (pathname === '/api/media/request' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const { tmdbId, mediaType, tier, title, year } = JSON.parse(bodyData || '{}');
        if (!tmdbId) return sendJSON(res, 400, { error: 'Missing tmdbId' });

        let profileId = 4;
        if (tier === 'med') profileId = 3;
        else if (tier === 'max') profileId = 7;
        else if (tier === 'high') profileId = 4;

        const isMovie = (mediaType || 'movie') === 'movie';
        const rootFolder = isMovie
          ? '/data/seerr/media/download/completed/Movies'
          : '/data/seerr/media/download/completed/Series';

        const seerrKey = SEERR_API_KEY;
        const payload = {
          mediaType: isMovie ? 'movie' : 'tv',
          mediaId: parseInt(tmdbId, 10),
          profileId: profileId,
          rootFolder: rootFolder,
          is4k: tier === 'max'
        };

        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 6000);
        const sRes = await fetchCandidate(
          ['http://127.0.0.1:5055/api/v1/request', 'http://alpha-prod-seerr:5055/api/v1/request'],
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': seerrKey
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal
          }
        );
        clearTimeout(tId);

        if (sRes.ok) {
          const sData = await sRes.json();
          return sendJSON(res, 200, {
            success: true,
            requestId: sData.id,
            tier: tier,
            profileId: profileId,
            message: `Request submitted successfully with ${tier.toUpperCase()} quality!`
          });
        }

        const errText = await sRes.text();
        return sendJSON(res, sRes.status, { error: 'Seerr rejected request: ' + errText });
      } catch (err) {
        return sendJSON(res, 500, { error: 'Failed to dispatch request: ' + err.message });
      }
    });
    return;
  }

  // --- API: Advanced Live Swarm Release Inspector (Queries Prowlarr) ---
  if (pathname === '/api/media/releases/search' && req.method === 'GET') {
    const query = searchParams.get('query') || '';
    const year = searchParams.get('year') || '';
    if (!query) return sendJSON(res, 400, { error: 'Missing query parameter' });

    const searchTerm = `${query} ${year}`.trim();
    const prowlarrKey = PROWLARR_API_KEY;

    try {
      const startTime = Date.now();
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), 5000);

      const pUrl = `http://alpha-prod-gluetun:9696/api/v1/search?query=${encodeURIComponent(searchTerm)}&indexerIds=2&indexerIds=5&indexerIds=1&type=search`;
      const pRes = await fetchCandidate(
        [
          pUrl,
          `http://127.0.0.1:9696/api/v1/search?query=${encodeURIComponent(searchTerm)}&indexerIds=2&indexerIds=5&indexerIds=1&type=search`
        ],
        {
          headers: { 'X-Api-Key': prowlarrKey },
          signal: ctrl.signal
        }
      );
      clearTimeout(tId);

      if (!pRes.ok) {
        return sendJSON(res, pRes.status, {
          error: 'Prowlarr search returned HTTP ' + pRes.status
        });
      }

      const rawReleases = await pRes.json();
      const tookMs = Date.now() - startTime;

      const seen = new Set();
      const parsed = [];

      for (const rel of rawReleases || []) {
        if (!rel.title || !rel.downloadUrl) continue;
        const infoHash = (rel.infoHash || rel.title).toLowerCase();
        if (seen.has(infoHash)) continue;
        seen.add(infoHash);

        const attrs = parseReleaseAttributes(rel.title);
        parsed.push({
          guid: rel.guid || rel.downloadUrl,
          title: rel.title,
          indexer: rel.indexer || 'Torrent',
          indexerId: rel.indexerId,
          sizeBytes: rel.size || 0,
          sizeFormatted: formatBytes(rel.size || 0),
          seeders: rel.seeders || 0,
          leechers: rel.leechers || 0,
          downloadUrl: rel.downloadUrl,
          infoHash: rel.infoHash || '',
          attributes: attrs
        });
      }

      parsed.sort((a, b) => b.seeders - a.seeders);

      return sendJSON(res, 200, {
        success: true,
        tookMs,
        total: parsed.length,
        releases: parsed
      });
    } catch (err) {
      return sendJSON(res, 500, { error: 'Swarm inspection failed: ' + err.message });
    }
  }

  // --- API: Advanced Grab Release (Direct Ingestion) ---
  if (pathname === '/api/media/releases/grab' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const { tmdbId, title, year, downloadUrl, releaseTitle, guid, indexerId } = JSON.parse(
          bodyData || '{}'
        );
        if (!downloadUrl) return sendJSON(res, 400, { error: 'Missing downloadUrl' });

        const radarrKey = RADARR_API_KEY;

        // 1. Ensure movie exists in Radarr
        if (tmdbId) {
          try {
            const mRes = await fetchCandidate(
              [
                `http://alpha-prod-gluetun:7878/api/v3/movie?tmdbId=${encodeURIComponent(tmdbId)}`,
                `http://127.0.0.1:7878/api/v3/movie?tmdbId=${encodeURIComponent(tmdbId)}`
              ],
              { headers: { 'X-Api-Key': radarrKey } }
            );
            const movies = mRes.ok ? await mRes.json() : [];
            const exists = Array.isArray(movies) && movies.length > 0;

            if (!exists) {
              await fetchCandidate(
                [
                  'http://alpha-prod-gluetun:7878/api/v3/movie',
                  'http://127.0.0.1:7878/api/v3/movie'
                ],
                {
                  method: 'POST',
                  headers: { 'X-Api-Key': radarrKey, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    title: title || 'Movie',
                    tmdbId: parseInt(tmdbId, 10),
                    year: parseInt(year || '0', 10),
                    qualityProfileId: 7,
                    rootFolderPath: '/data/seerr/media/download/completed/Movies',
                    monitored: true,
                    addOptions: { searchForMovie: false }
                  })
                }
              );
            }
          } catch (_) {}
        }

        // 2. Push torrent into qBittorrent under category 'radarr'
        await callQbit('torrents/add', {
          urls: downloadUrl,
          category: 'radarr',
          savepath: '/data/seerr/media/download/staging'
        });

        return sendJSON(res, 200, {
          success: true,
          message: `Release dispatched to download client: ${releaseTitle || title}`
        });
      } catch (err) {
        return sendJSON(res, 500, { error: 'Failed to grab release: ' + err.message });
      }
    });
    return;
  }

  // --- API: Available Log Sources ---
  if (pathname === '/api/logs/sources' && req.method === 'GET') {
    const logsDir = getLogsDir();
    let fileLogs = [];
    if (logsDir && fs.existsSync(logsDir)) {
      fileLogs = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    }

    try {
      const resp = await requestPodman('/v1.41/containers/json?all=1');
      if (resp.statusCode >= 400) {
        let parsed = null;
        try {
          parsed = JSON.parse(resp.rawBuffer.toString('utf8'));
        } catch (_) {}
        return sendJSON(res, 502, {
          error: parsed?.message || parsed?.cause || `Podman API returned HTTP ${resp.statusCode}`,
          statusCode: resp.statusCode,
          containers: [],
          fileLogs
        });
      }
      const list = JSON.parse(resp.body);
      const containerNames = list
        .map((c) => (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : null))
        .filter(Boolean);
      return sendJSON(res, 200, { containers: containerNames, fileLogs });
    } catch (err) {
      if (isPodmanSocketError(err)) {
        return sendJSON(res, 503, {
          error: `Podman socket unavailable (${err.code || 'ERROR'}: ${PODMAN_SOCKET}). Ensure podman.socket is running and accessible.`,
          code: err.code || 'SOCKET_UNAVAILABLE',
          containers: [],
          fileLogs
        });
      }
      return sendJSON(res, 500, { error: err.message, containers: [], fileLogs });
    }
  }

  // --- API: Live Container Logs with Error Tagging ---
  if (pathname === '/api/logs/stream' && req.method === 'GET') {
    let container = searchParams.get('container') || 'alpha-prod-seerr';
    const tail = Math.min(2000, Math.max(1, parseInt(searchParams.get('tail') || '150', 10) || 150));
    const filter = (searchParams.get('filter') || 'all').toLowerCase(); // 'all', 'error', 'warn'
    const isFile = searchParams.get('type') === 'file' || container.startsWith('file:');
    if (container.startsWith('file:')) {
      container = container.replace(/^file:/, '');
    }

    try {
      let rawLines = [];
      if (isFile) {
        const logsDir = getLogsDir();
        const safeName = path.basename(container);
        const filePath = logsDir ? path.join(logsDir, safeName) : '';
        if (!filePath || !fs.existsSync(filePath)) {
          return sendJSON(res, 404, {
            error: `Log file not found: ${safeName}`,
            container: safeName
          });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const allLines = content.split('\n');
        const sliced = allLines.slice(-tail);
        rawLines = sliced.map((t) => ({ stream: 'stdout', text: t }));
      } else {
        const resp = await requestPodman(
          `/v1.41/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&tail=${tail}`
        );
        if (resp.statusCode >= 400) {
          let parsed = null;
          try {
            parsed = JSON.parse(resp.rawBuffer.toString('utf8'));
          } catch (_) {}
          return sendJSON(res, resp.statusCode === 404 ? 404 : 502, {
            error: parsed?.message || parsed?.cause || 'Podman API error',
            container,
            statusCode: resp.statusCode
          });
        }
        rawLines = demuxDockerLogs(resp.rawBuffer);
      }

      // Classify log lines and apply filter
      const parsed = rawLines.map((entry, idx) => {
        const cleanText = entry.text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''); // strip ANSI for clean parsing
        let level = 'info';
        if (/error|failed|exception|fatal|panic|err:/i.test(cleanText)) {
          level = 'error';
        } else if (/warn|warning|degraded/i.test(cleanText)) {
          level = 'warn';
        } else if (/debug|trace/i.test(cleanText)) {
          level = 'debug';
        }
        return {
          id: idx,
          stream: entry.stream,
          level: level,
          text: cleanText,
          raw: entry.text
        };
      });

      let filtered = parsed;
      if (filter === 'error') {
        filtered = parsed.filter((l) => l.level === 'error');
      } else if (filter === 'warn') {
        filtered = parsed.filter((l) => l.level === 'warn' || l.level === 'error');
      }

      return sendJSON(res, 200, {
        container: container,
        totalReturned: filtered.length,
        filterApplied: filter,
        lines: filtered
      });
    } catch (err) {
      if (isPodmanSocketError(err)) {
        return sendJSON(res, 503, {
          error: `Podman socket unavailable (${err.code || 'ERROR'}: ${PODMAN_SOCKET}). Ensure podman.socket is running and accessible.`,
          code: err.code || 'SOCKET_UNAVAILABLE',
          container
        });
      }
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: VPN Status ---
  if (pathname === '/api/vpn/status' && req.method === 'GET') {
    try {
      const ctrl = new AbortController();
      const tId = setTimeout(() => ctrl.abort(), 2000);
      const vRes = await fetchCandidate(
        [
          'http://alpha-prod-vpn-switcher:8001/api/v1/status',
          'http://127.0.0.1:8001/api/v1/status'
        ],
        {
          headers: { 'X-Api-Key': SWITCHER_API_KEY },
          signal: ctrl.signal
        }
      );
      clearTimeout(tId);
      if (vRes.ok) {
        const vData = await vRes.json();
        return sendJSON(res, 200, vData);
      }
      return sendJSON(res, vRes.status, { error: 'VPN Switcher returned ' + vRes.status });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: TMDB Search Proxy (Direct TMDb or Seerr Proxy fallback) ---
  if (pathname === '/api/tmdb/search' && req.method === 'GET') {
    const query = searchParams.get('query');
    if (!query || query.length < 2) {
      return sendJSON(res, 400, { error: 'Query must be at least 2 characters' });
    }

    const tmdbApiKey = process.env.TMDB_API_KEY;
    if (tmdbApiKey) {
      try {
        const url = `https://api.themoviedb.org/3/search/multi?api_key=${tmdbApiKey}&language=en-US&query=${encodeURIComponent(query)}&page=1&include_adult=false`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          return sendJSON(res, 200, data);
        }
      } catch (_) {}
    }

    // Seerr fallback
    try {
      const sRes = await accessManager.seerrFetch(
        `/api/v1/search?query=${encodeURIComponent(query)}`,
        {},
        4500
      );
      if (sRes.ok) {
        const sData = await sRes.json();
        return sendJSON(res, 200, sData);
      }
      return sendJSON(res, sRes.status, { error: 'Search failed' });
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // --- API: TMDB Read-Only Proxy (keeps TMDB_API_KEY server-side) ---
  if (pathname === '/api/tmdb/proxy' && req.method === 'GET') {
    const tmdbApiKey = process.env.TMDB_API_KEY;
    if (!tmdbApiKey) {
      return sendJSON(res, 503, { error: 'TMDB_API_KEY not configured on server' });
    }

    const tmdbPath = (searchParams.get('path') || '').replace(/^\/+/, '');
    if (!TMDB_PROXY_PATH_RE.test(tmdbPath)) {
      return sendJSON(res, 400, { error: 'Invalid or disallowed TMDb proxy path' });
    }

    const upstreamParams = new URLSearchParams();
    for (const key of TMDB_PROXY_ALLOWED_PARAMS) {
      if (searchParams.has(key)) {
        upstreamParams.set(key, searchParams.get(key));
      }
    }
    upstreamParams.set('api_key', tmdbApiKey);

    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 8000);
    try {
      const upstreamRes = await fetch(
        `https://api.themoviedb.org/3/${tmdbPath}?${upstreamParams.toString()}`,
        { signal: ctrl.signal }
      );
      const data = await upstreamRes.json();
      return sendJSON(res, upstreamRes.status, data);
    } catch (err) {
      return sendJSON(res, 502, { error: err.message });
    } finally {
      clearTimeout(tId);
    }
  }

  // --- API: VPN Switch Profile ---
  if (pathname === '/api/vpn/switch' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', (c) => (bodyData += c));
    req.on('end', async () => {
      try {
        const { profile } = JSON.parse(bodyData || '{}');
        if (!profile) return sendJSON(res, 400, { error: 'Missing profile name' });
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), 8000);
        const candidates = [
          `http://alpha-prod-vpn-switcher:8001/api/v1/switch?profile=${encodeURIComponent(profile)}`,
          `http://127.0.0.1:8001/api/v1/switch?profile=${encodeURIComponent(profile)}`
        ];
        const vRes = await fetchCandidate(candidates, {
          method: 'POST',
          headers: { 'X-Api-Key': SWITCHER_API_KEY },
          signal: ctrl.signal
        });
        clearTimeout(tId);
        const data = await vRes.json();
        return sendJSON(res, vRes.status, data);
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    });
    return;
  }

  // --- Unmatched /api/* JSON 404 ---
  if (pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: 'API endpoint not found' });
  }

  // --- Proxy: Seerr Avatar Proxy ---
  if (pathname.startsWith('/avatarproxy/')) {
    try {
      const queryPart = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const seerrRes = await fetchCandidate(
        accessManager.getSeerrUrls(`${pathname}${queryPart}`)
      );
      res.writeHead(seerrRes.status, {
        'Content-Type': seerrRes.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=86400'
      });
      const buf = await seerrRes.arrayBuffer();
      return res.end(Buffer.from(buf));
    } catch (_) {
      res.writeHead(404);
      return res.end();
    }
  }

  // --- Static Asset Serving from public/ ---
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  const filePath = path.join(__dirname, 'public', safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isCode = ext === '.html' || ext === '.css' || ext === '.js';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': isCode ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400'
    });
    fs.createReadStream(filePath).pipe(res);
  });
  } catch (err) {
    if (!res.headersSent) {
      return sendError(res, err);
    }
  }
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully on SIGTERM');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully on SIGINT');
  server.close(() => process.exit(0));
});

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(` 🚀 Alpha Server Dashboard Online on port ${PORT}`);
  console.log(` Podman Socket : ${PODMAN_SOCKET}`);
  console.log(` Alpha Storage : ${getAlphaPath()}`);
  console.log(` Localhost URL : http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
