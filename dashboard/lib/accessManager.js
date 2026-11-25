const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'orbit_admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 5;
const JELLYFIN_INFO_CACHE_TTL_MS = 15 * 1000;

const JELLYFIN_CLIENT_AUTH =
  'MediaBrowser Client="OrbitAdmin", Device="Dashboard", DeviceId="orbit-dashboard", Version="1.0.0"';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  /**
   * Structured HTTP error carrying statusCode for route handlers.
   * @param {number} statusCode
   * @param {string} message
   */
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function dedupeUrls(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'string') continue;
    const normalized = item.trim().replace(/\/+$/, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isDirWritable(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch (_) {}
  fs.renameSync(tmpPath, filePath);
}

function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const cookies = {};
  if (!header || typeof header !== 'string') return cookies;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const rawVal = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(rawVal);
    } catch (_) {
      cookies[key] = rawVal;
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  if (!req) return false;
  const forwarded = req.headers && req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim().toLowerCase();
    if (first === 'https') return true;
  }
  return Boolean(req.socket && req.socket.encrypted);
}

function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''), 'utf8')
    .digest('hex');
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create an Access & Authentication manager backed by Node built-ins.
 * @param {object|Function} configOrGetter Static config object or function returning current env/config
 */
function createAccessManager(configOrGetter = () => process.env) {
  let configProvider = configOrGetter;
  const rateLimitMap = new Map();
  const inFlightApprovals = new Set();
  let writeChain = Promise.resolve();
  let cachedJellyfinInfo = { reachable: false, setupRequired: false, checkedAt: 0 };

  function configure(nextConfigOrGetter) {
    if (nextConfigOrGetter) {
      configProvider = nextConfigOrGetter;
    }
  }

  function getEnv(key) {
    const cfg = typeof configProvider === 'function' ? configProvider() : configProvider || {};
    if (cfg && cfg[key] !== undefined && cfg[key] !== null && String(cfg[key]).length > 0) {
      return String(cfg[key]);
    }
    const envVal = process.env[key];
    return envVal !== undefined && envVal !== null ? String(envVal) : '';
  }

  function resolveDataDir() {
    const configured = getEnv('DASHBOARD_DATA_DIR').trim();
    if (configured) return configured;

    const dataDashboard = '/data/dashboard';
    if (isDirWritable(dataDashboard) || isDirWritable('/data')) {
      return dataDashboard;
    }

    return path.join(__dirname, '..', 'data');
  }

  function ensureDataDir() {
    const dir = resolveDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(dir, 0o700);
    } catch (_) {}
    return dir;
  }

  function getStorePath() {
    return path.join(ensureDataDir(), 'access-requests.json');
  }

  function getMasterKey() {
    const encSecret = getEnv('DASHBOARD_ENC_SECRET');
    if (encSecret) {
      return crypto
        .createHmac('sha256', 'orbit-dashboard-enc-v1')
        .update(encSecret, 'utf8')
        .digest();
    }

    const jfKey = getEnv('JELLYFIN_API_KEY');
    const swKey = getEnv('SWITCHER_API_KEY');
    if (jfKey || swKey) {
      return crypto
        .createHmac('sha256', 'orbit-dashboard-enc-v1')
        .update(`${jfKey}:${swKey}`, 'utf8')
        .digest();
    }

    const keyPath = path.join(ensureDataDir(), '.enc.key');
    try {
      if (fs.existsSync(keyPath)) {
        const hex = fs.readFileSync(keyPath, 'utf8').trim();
        const existing = Buffer.from(hex, 'hex');
        if (existing.length === 32) return existing;
      }
    } catch (_) {}

    const generated = crypto.randomBytes(32);
    atomicWriteFile(keyPath, generated.toString('hex') + '\n', 0o600);
    return generated;
  }

  function getSessionSigningKey() {
    return crypto
      .createHmac('sha256', getMasterKey())
      .update('orbit-admin-session-v1', 'utf8')
      .digest();
  }

  function encryptSecret(plaintext) {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertext.toString('hex')
    };
  }

  function decryptSecret(enc) {
    if (!enc || !enc.iv || !enc.tag || !enc.ciphertext) {
      throw new HttpError(400, 'Encrypted credential payload is missing or corrupted');
    }
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(enc.ciphertext, 'hex')),
      decipher.final()
    ]);
    return plain.toString('utf8');
  }

  function readStore() {
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) {
      return { version: 1, requests: [] };
    }
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      if (Array.isArray(parsed)) {
        return { version: 1, requests: parsed };
      }
      return {
        version: parsed.version || 1,
        requests: Array.isArray(parsed.requests) ? parsed.requests : []
      };
    } catch (err) {
      throw new HttpError(500, `Failed to read access request store: ${err.message}`);
    }
  }

  function writeStore(store) {
    const storePath = getStorePath();
    atomicWriteFile(storePath, JSON.stringify(store, null, 2), 0o600);
  }

  function withStoreLock(taskFn) {
    const next = writeChain.then(() => taskFn());
    writeChain = next.catch(() => {});
    return next;
  }

  function getJellyfinBaseUrls() {
    return dedupeUrls([
      getEnv('JELLYFIN_URL'),
      getEnv('JELLYFIN_INTERNAL_URL'),
      'http://127.0.0.1:8096',
      'http://alpha-prod-jellyfin:8096',
      'http://alpha-prod-tailscale:8096'
    ]);
  }

  function getJellyfinUrls(apiPath = '') {
    const cleanPath = apiPath ? (apiPath.startsWith('/') ? apiPath : `/${apiPath}`) : '';
    return getJellyfinBaseUrls().map((base) => `${base}${cleanPath}`);
  }

  function getSeerrBaseUrls() {
    return dedupeUrls([
      getEnv('SEERR_URL'),
      'http://127.0.0.1:5055',
      'http://alpha-prod-seerr:5055'
    ]);
  }

  function getSeerrUrls(apiPath = '') {
    const cleanPath = apiPath ? (apiPath.startsWith('/') ? apiPath : `/${apiPath}`) : '';
    return getSeerrBaseUrls().map((base) => `${base}${cleanPath}`);
  }

  function jellyfinHeaders(includeToken = true, extra = {}) {
    const apiKey = getEnv('JELLYFIN_API_KEY');
    const authValue =
      includeToken && apiKey ? `${JELLYFIN_CLIENT_AUTH}, Token="${apiKey}"` : JELLYFIN_CLIENT_AUTH;
    return {
      Accept: 'application/json',
      Authorization: authValue,
      ...extra
    };
  }

  function seerrHeaders(extra = {}) {
    return {
      Accept: 'application/json',
      'X-Api-Key': getEnv('SEERR_API_KEY'),
      ...extra
    };
  }

  async function requestServiceCandidate(urls, options = {}, timeoutMs = 4500) {
    let lastError = null;
    for (const url of urls) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
      }
    }
    throw lastError || new Error('All service candidates unreachable');
  }

  async function jellyfinFetch(apiPath, options = {}, timeoutMs = 4500) {
    const includeToken = options.includeToken !== undefined ? options.includeToken : true;
    const headers = jellyfinHeaders(includeToken, options.headers || {});
    return requestServiceCandidate(getJellyfinUrls(apiPath), { ...options, headers }, timeoutMs);
  }

  async function seerrFetch(apiPath, options = {}, timeoutMs = 4500) {
    const headers = seerrHeaders(options.headers || {});
    return requestServiceCandidate(getSeerrUrls(apiPath), { ...options, headers }, timeoutMs);
  }

  async function parseResponseBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  // ============================================================================
  // SESSION AUTHENTICATION
  // ============================================================================

  function signSessionToken({ username, userId }) {
    const now = Date.now();
    const payload = {
      u: username,
      id: userId || '',
      admin: true,
      iat: now,
      exp: now + SESSION_TTL_MS
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto
      .createHmac('sha256', getSessionSigningKey())
      .update(payloadB64, 'utf8')
      .digest('base64url');
    return `${payloadB64}.${sig}`;
  }

  function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const [payloadB64, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getSessionSigningKey())
      .update(payloadB64, 'utf8')
      .digest('base64url');

    if (!safeEqualString(sig, expectedSig)) return null;

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (
        !payload ||
        payload.admin !== true ||
        typeof payload.u !== 'string' ||
        !payload.u ||
        typeof payload.exp !== 'number' ||
        Date.now() >= payload.exp
      ) {
        return null;
      }
      return {
        username: payload.u,
        userId: payload.id || '',
        isAdmin: true,
        issuedAt: payload.iat,
        expiresAt: payload.exp
      };
    } catch (_) {
      return null;
    }
  }

  function verifySession(req) {
    const cookies = parseCookies(req);
    return verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  }

  function buildSessionCookie(token, req) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      `Max-Age=${maxAgeSec}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (isHttpsRequest(req)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  function clearSessionCookie(req) {
    const parts = [
      `${SESSION_COOKIE_NAME}=`,
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Path=/',
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (isHttpsRequest(req)) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  async function getJellyfinReachability() {
    const now = Date.now();
    if (now - cachedJellyfinInfo.checkedAt < JELLYFIN_INFO_CACHE_TTL_MS) {
      return cachedJellyfinInfo;
    }
    try {
      const res = await jellyfinFetch(
        '/System/Info/Public',
        { method: 'GET', includeToken: false },
        1800
      );
      if (res.ok) {
        const info = await res.json();
        cachedJellyfinInfo = {
          reachable: true,
          setupRequired: info && info.StartupWizardCompleted === false,
          checkedAt: now
        };
        return cachedJellyfinInfo;
      }
    } catch (_) {}
    cachedJellyfinInfo = {
      reachable: false,
      setupRequired: false,
      checkedAt: now
    };
    return cachedJellyfinInfo;
  }

  async function handleAuthLogin({ username, password }) {
    const user = String(username || '').trim();
    const pass = String(password || '');
    if (!user || !pass) {
      throw new HttpError(400, 'Username and password are required');
    }

    let res;
    try {
      res = await jellyfinFetch(
        '/Users/AuthenticateByName',
        {
          method: 'POST',
          includeToken: false,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Username: user, Pw: pass })
        },
        6000
      );
    } catch (_) {
      throw new HttpError(503, 'Jellyfin authentication service is currently unreachable');
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new HttpError(401, 'Invalid Jellyfin username or password');
    }
    if (!res.ok) {
      throw new HttpError(502, `Jellyfin authentication failed with HTTP ${res.status}`);
    }

    const data = await res.json();
    const jfUser = data && data.User;
    if (!jfUser || !jfUser.Policy || jfUser.Policy.IsAdministrator !== true) {
      throw new HttpError(
        403,
        'Jellyfin administrator privileges are required to access Orbit Dashboard'
      );
    }
    if (jfUser.Policy.IsDisabled === true) {
      throw new HttpError(403, 'This Jellyfin administrator account is disabled');
    }

    const session = {
      authenticated: true,
      isAdmin: true,
      username: jfUser.Name,
      userId: jfUser.Id
    };
    const token = signSessionToken({ username: jfUser.Name, userId: jfUser.Id });
    return { token, session };
  }

  async function getAuthStatus(req) {
    const authDisabled = getEnv('DASHBOARD_AUTH_DISABLED') === 'true';
    const session = verifySession(req);
    const jfInfo = await getJellyfinReachability();

    if (authDisabled) {
      return {
        authenticated: true,
        isAdmin: true,
        username: session ? session.username : 'admin',
        userId: session ? session.userId : '',
        authDisabled: true,
        setupRequired: jfInfo.setupRequired,
        jellyfinReachable: jfInfo.reachable
      };
    }

    if (session) {
      return {
        authenticated: true,
        isAdmin: true,
        username: session.username,
        userId: session.userId,
        setupRequired: jfInfo.setupRequired,
        jellyfinReachable: jfInfo.reachable
      };
    }

    return {
      authenticated: false,
      isAdmin: false,
      username: null,
      userId: null,
      setupRequired: jfInfo.setupRequired,
      jellyfinReachable: jfInfo.reachable
    };
  }

  // ============================================================================
  // LIBRARIES, SIGNUP & NOTIFICATIONS
  // ============================================================================

  async function fetchJellyfinLibraries() {
    const apiKey = getEnv('JELLYFIN_API_KEY');
    if (!apiKey) {
      return { libraries: [], reachable: false, warning: 'JELLYFIN_API_KEY is not configured' };
    }
    try {
      const res = await jellyfinFetch('/Library/VirtualFolders', { method: 'GET' }, 3500);
      if (!res.ok) {
        return {
          libraries: [],
          reachable: false,
          warning: `Jellyfin returned HTTP ${res.status} for VirtualFolders`
        };
      }
      const folders = await res.json();
      const libraries = (Array.isArray(folders) ? folders : [])
        .map((f) => ({
          id: String(f.ItemId || f.Guid || f.Name || ''),
          name: String(f.Name || 'Library'),
          collectionType: String(f.CollectionType || 'mixed')
        }))
        .filter((lib) => lib.id);
      return { libraries, reachable: true, warning: null };
    } catch (err) {
      return {
        libraries: [],
        reachable: false,
        warning: err.message || 'Jellyfin unreachable'
      };
    }
  }

  async function getSignupOptions() {
    const { libraries } = await fetchJellyfinLibraries();
    return { availableLibraries: libraries };
  }

  async function getLibraries() {
    return fetchJellyfinLibraries();
  }

  function sanitizeRequest(record) {
    if (!record) return null;
    const { encryptedPassword, statusToken, statusTokenHash, ...rest } = record;
    return {
      ...rest,
      hasStoredPassword: Boolean(encryptedPassword),
      jellyfinProvisioned: Boolean(record.jellyfinUserId),
      seerrProvisioned: Boolean(record.seerrUserId)
    };
  }

  function checkAndRecordRateLimit(clientIp) {
    const ip = String(clientIp || 'unknown');
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;

    // Periodic pruning of stale IPs to keep memory bounded
    if (rateLimitMap.size > 500) {
      for (const [k, stamps] of rateLimitMap.entries()) {
        const fresh = stamps.filter((t) => t > cutoff);
        if (fresh.length === 0) rateLimitMap.delete(k);
        else rateLimitMap.set(k, fresh);
      }
    }

    const recent = (rateLimitMap.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      rateLimitMap.set(ip, recent);
      throw new HttpError(
        429,
        'Rate limit exceeded: maximum 5 access requests per hour per IP address'
      );
    }
    recent.push(now);
    rateLimitMap.set(ip, recent);
  }

  function sendNtfySignupNotification(record) {
    const topic = (getEnv('NTFY_TOPIC') || 'alpha-prod-alerts').trim();
    if (!topic) return;

    const configuredUrl = getEnv('NTFY_URL').trim();
    const ntfyCandidates = configuredUrl
      ? dedupeUrls([
          configuredUrl,
          'http://alpha-prod-ntfy:80',
          'http://127.0.0.1:8003',
          'http://127.0.0.1:8088'
        ])
      : dedupeUrls(['http://alpha-prod-ntfy:80', 'http://127.0.0.1:8003', 'http://127.0.0.1:8088']);

    const urls = ntfyCandidates.map((base) => `${base}/${encodeURIComponent(topic)}`);
    const services = [];
    if (record.requestedAccess.jellyfin) services.push('Jellyfin');
    if (record.requestedAccess.seerr) services.push('Seerr');

    const body = [
      `Name: ${record.fullName}`,
      `Username: ${record.username}`,
      `Email: ${record.email}`,
      `Services: ${services.join(', ') || 'None'}`,
      `Note: ${record.requestedAccess.deviceNote || 'None'}`
    ].join('\n');

    const headers = {
      Title: 'New Orbit Access Request',
      Priority: 'high',
      Tags: 'key,bust_in_silhouette',
      'Content-Type': 'text/plain; charset=utf-8'
    };
    const token = getEnv('NTFY_TOKEN').trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    setImmediate(() => {
      requestServiceCandidate(urls, { method: 'POST', headers, body }, 2500).catch(() => {});
    });
  }

  async function createSignupRequest(payload = {}, clientIp = 'unknown') {
    checkAndRecordRateLimit(clientIp);

    const fullName = String(payload.fullName || payload.name || '').trim();
    const username = String(payload.username || '').trim();
    const email = String(payload.email || '').trim();
    const password = String(payload.password || '');

    if (fullName.length < 2 || fullName.length > 80) {
      throw new HttpError(400, 'Full name must be between 2 and 80 characters');
    }
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(
        400,
        'Username must be 3-32 characters using only letters, numbers, dots, underscores, or hyphens'
      );
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      throw new HttpError(400, 'Please provide a valid email address');
    }
    if (password.length < 8 || password.length > 128) {
      throw new HttpError(400, 'Password must be between 8 and 128 characters');
    }

    const rawAccess =
      payload.requestedAccess && typeof payload.requestedAccess === 'object'
        ? payload.requestedAccess
        : {};
    const rawLibraries = Array.isArray(rawAccess.libraries)
      ? rawAccess.libraries
      : Array.isArray(payload.libraries)
        ? payload.libraries
        : [];
    const requestedAccess = {
      jellyfin:
        rawAccess.jellyfin !== undefined
          ? Boolean(rawAccess.jellyfin)
          : payload.jellyfin !== undefined
            ? Boolean(payload.jellyfin)
            : true,
      seerr: rawAccess.seerr !== undefined ? Boolean(rawAccess.seerr) : Boolean(payload.seerr),
      libraries: rawLibraries
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 50),
      deviceNote: String(rawAccess.deviceNote || payload.deviceNote || payload.note || '')
        .trim()
        .slice(0, 300)
    };

    // Check existing Jellyfin users if API key is available
    const apiKey = getEnv('JELLYFIN_API_KEY');
    if (apiKey) {
      try {
        const jfRes = await jellyfinFetch('/Users', { method: 'GET' }, 3000);
        if (jfRes.ok) {
          const users = await jfRes.json();
          const lowerUser = username.toLowerCase();
          if (
            Array.isArray(users) &&
            users.some((u) => u && u.Name && u.Name.toLowerCase() === lowerUser)
          ) {
            throw new HttpError(409, 'This username is already registered in Jellyfin');
          }
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
      }
    }

    const statusToken = crypto.randomBytes(24).toString('hex');
    const record = {
      id: `req_${crypto.randomUUID()}`,
      statusTokenHash: hashToken(statusToken),
      fullName,
      username,
      email,
      encryptedPassword: encryptSecret(password),
      requestedAccess,
      submittedAt: new Date().toISOString(),
      clientIp: String(clientIp || 'unknown'),
      status: 'pending'
    };

    await withStoreLock(() => {
      const store = readStore();
      const lowerUser = username.toLowerCase();
      const duplicatePending = store.requests.some(
        (r) => r.status === 'pending' && r.username && r.username.toLowerCase() === lowerUser
      );
      if (duplicatePending) {
        throw new HttpError(409, 'A pending access request already exists for this username');
      }
      store.requests.push(record);
      writeStore(store);
    });

    sendNtfySignupNotification(record);

    return {
      request: sanitizeRequest(record),
      statusToken
    };
  }

  function getSignupStatus(token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      throw new HttpError(400, 'Missing status token');
    }
    const tokenHash = hashToken(cleanToken);
    const store = readStore();
    const match = store.requests.find(
      (r) =>
        (r.statusTokenHash && safeEqualString(r.statusTokenHash, tokenHash)) ||
        (r.statusToken && safeEqualString(r.statusToken, cleanToken))
    );
    if (!match) {
      throw new HttpError(404, 'Access request not found for provided token');
    }
    return {
      id: match.id,
      fullName: match.fullName,
      username: match.username,
      email: match.email,
      status: match.status,
      requestedAccess: match.requestedAccess,
      submittedAt: match.submittedAt,
      reviewedAt: match.reviewedAt || null,
      decisionNote: match.decisionNote || '',
      jellyfinProvisioned: Boolean(match.jellyfinUserId),
      seerrProvisioned: Boolean(match.seerrUserId),
      warnings: Array.isArray(match.warnings) ? match.warnings : []
    };
  }

  // ============================================================================
  // ADMIN REQUEST APPROVAL / REJECTION & PROVISIONING
  // ============================================================================

  function listAccessRequests() {
    const store = readStore();
    const pending = [];
    const history = [];
    let approved = 0;
    let rejected = 0;

    for (const r of store.requests) {
      const clean = sanitizeRequest(r);
      if (r.status === 'pending') {
        pending.push(clean);
      } else {
        history.push(clean);
        if (r.status === 'approved') approved++;
        else if (r.status === 'rejected') rejected++;
      }
    }

    pending.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    history.sort(
      (a, b) =>
        new Date(b.reviewedAt || b.submittedAt).getTime() -
        new Date(a.reviewedAt || a.submittedAt).getTime()
    );

    return {
      pending,
      history,
      counts: {
        pending: pending.length,
        approved,
        rejected
      }
    };
  }

  async function findJellyfinUserByUsername(username) {
    const res = await jellyfinFetch('/Users', { method: 'GET' }, 4500);
    if (!res.ok) {
      throw new HttpError(502, `Failed to query Jellyfin users (HTTP ${res.status})`);
    }
    const users = await res.json();
    const target = String(username || '').toLowerCase();
    return (Array.isArray(users) ? users : []).find(
      (u) => u && u.Name && u.Name.toLowerCase() === target
    );
  }

  async function provisionJellyfinAccount(username, password, opts) {
    if (!getEnv('JELLYFIN_API_KEY')) {
      throw new HttpError(503, 'JELLYFIN_API_KEY is not configured on dashboard server');
    }

    let createdFresh = false;
    let jfUser = null;
    let createRes;
    try {
      createRes = await jellyfinFetch(
        '/Users/New',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Name: username, Password: password })
        },
        6000
      );
    } catch (err) {
      throw new HttpError(503, `Jellyfin unreachable during user creation: ${err.message}`);
    }

    if (createRes.ok) {
      jfUser = await createRes.json();
      createdFresh = true;
    } else if (createRes.status === 400 || createRes.status === 409) {
      const existing = await findJellyfinUserByUsername(username).catch(() => null);
      if (existing) {
        if (existing.Policy && existing.Policy.IsAdministrator) {
          throw new HttpError(409, `Jellyfin administrator '${username}' already exists`);
        }
        if (!opts.allowExistingUser) {
          throw new HttpError(409, `Jellyfin user '${username}' already exists`);
        }
        jfUser = existing;
      } else {
        const body = await parseResponseBody(createRes);
        const detail = typeof body === 'string' ? body : body?.title || body?.message || '';
        throw new HttpError(400, `Jellyfin rejected user creation${detail ? `: ${detail}` : ''}`);
      }
    } else {
      throw new HttpError(502, `Jellyfin user creation failed with HTTP ${createRes.status}`);
    }

    if (!jfUser || !jfUser.Id) {
      throw new HttpError(502, 'Jellyfin returned user object without Id');
    }

    // Fetch complete current policy before updating
    let currentPolicy = jfUser.Policy || {};
    try {
      const userRes = await jellyfinFetch(
        `/Users/${encodeURIComponent(jfUser.Id)}`,
        { method: 'GET' },
        4500
      );
      if (userRes.ok) {
        const fullUser = await userRes.json();
        if (fullUser && fullUser.Policy) currentPolicy = fullUser.Policy;
      }
    } catch (_) {}

    const nextPolicy = {
      ...currentPolicy,
      IsAdministrator: false,
      IsDisabled: false,
      EnableContentDeletion: false,
      EnableRemoteAccess: true,
      EnableAllFolders: Boolean(opts.enableAllLibraries),
      EnabledFolders: opts.enableAllLibraries ? [] : opts.enabledFolderIds,
      MaxActiveSessions: opts.maxConcurrentStreams
    };

    try {
      const polRes = await jellyfinFetch(
        `/Users/${encodeURIComponent(jfUser.Id)}/Policy`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextPolicy)
        },
        5000
      );
      if (!polRes.ok) {
        const errBody = await parseResponseBody(polRes);
        throw new Error(
          `HTTP ${polRes.status} ${typeof errBody === 'string' ? errBody : ''}`.trim()
        );
      }
    } catch (err) {
      if (createdFresh) {
        // Best-effort rollback so failed policy setup doesn't strand an unconfigured user
        await jellyfinFetch(
          `/Users/${encodeURIComponent(jfUser.Id)}`,
          { method: 'DELETE' },
          3000
        ).catch(() => {});
      }
      throw new HttpError(502, `Failed to apply Jellyfin user policy: ${err.message}`);
    }

    return jfUser;
  }

  async function findSeerrUser(jellyfinUserId, username) {
    const res = await seerrFetch('/api/v1/user?take=100', { method: 'GET' }, 4500);
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data && data.results) ? data.results : [];
    const targetName = String(username || '').toLowerCase();
    return (
      list.find((u) => u && u.jellyfinUserId && u.jellyfinUserId === jellyfinUserId) ||
      list.find(
        (u) =>
          u &&
          ((u.jellyfinUsername && u.jellyfinUsername.toLowerCase() === targetName) ||
            (u.username && u.username.toLowerCase() === targetName))
      ) ||
      null
    );
  }

  async function provisionSeerrAccount(jfUserId, username, seerrAutoApprove) {
    if (!getEnv('SEERR_API_KEY')) {
      return { seerrUserId: null, warning: 'SEERR_API_KEY not configured; skipped Seerr import' };
    }
    if (!jfUserId) {
      return { seerrUserId: null, warning: 'No Jellyfin user ID available for Seerr import' };
    }

    let seerrUser = null;
    try {
      const importRes = await seerrFetch(
        '/api/v1/user/import-from-jellyfin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jellyfinUserIds: [jfUserId] })
        },
        6000
      );

      if (importRes.ok) {
        const imported = await importRes.json();
        if (Array.isArray(imported) && imported.length > 0) {
          seerrUser = imported.find((u) => u && u.jellyfinUserId === jfUserId) || imported[0];
        }
      } else {
        const errBody = await parseResponseBody(importRes);
        // Check if user already existed in Seerr before failing
        seerrUser = await findSeerrUser(jfUserId, username).catch(() => null);
        if (!seerrUser) {
          return {
            seerrUserId: null,
            warning: `Seerr import returned HTTP ${importRes.status}${typeof errBody === 'string' && errBody ? `: ${errBody}` : ''}`
          };
        }
      }

      if (!seerrUser) {
        seerrUser = await findSeerrUser(jfUserId, username).catch(() => null);
      }
      if (!seerrUser || !seerrUser.id) {
        return {
          seerrUserId: null,
          warning: 'Seerr import succeeded but user record could not be located'
        };
      }

      // 32 = REQUEST permission, 128 = AUTO_APPROVE permission
      const permissions = 32 | (seerrAutoApprove ? 128 : 0);
      const permRes = await seerrFetch(
        `/api/v1/user/${encodeURIComponent(seerrUser.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions })
        },
        5000
      );
      if (!permRes.ok) {
        return {
          seerrUserId: seerrUser.id,
          warning: `Imported user into Seerr (id=${seerrUser.id}) but permission update returned HTTP ${permRes.status}`
        };
      }
      return { seerrUserId: seerrUser.id, warning: null };
    } catch (err) {
      return {
        seerrUserId: seerrUser?.id || null,
        warning: `Seerr provisioning error: ${err.message}`
      };
    }
  }

  async function approveRequest(id, options = {}, adminUsername = 'admin') {
    const reqId = String(id || '').trim();
    if (!reqId) throw new HttpError(400, 'Missing request ID');
    if (inFlightApprovals.has(reqId)) {
      throw new HttpError(409, 'Approval already in progress for this request');
    }

    inFlightApprovals.add(reqId);
    try {
      const storeSnapshot = readStore();
      const target = storeSnapshot.requests.find((r) => r.id === reqId);
      if (!target) throw new HttpError(404, 'Access request not found');
      if (target.status !== 'pending') {
        throw new HttpError(409, `Access request has already been ${target.status}`);
      }

      const grantJellyfin =
        options.grantJellyfin !== undefined
          ? Boolean(options.grantJellyfin)
          : target.requestedAccess?.jellyfin !== false;
      const grantSeerr =
        options.grantSeerr !== undefined
          ? Boolean(options.grantSeerr)
          : Boolean(target.requestedAccess?.seerr);
      const enableAllLibraries =
        options.enableAllLibraries !== undefined ? Boolean(options.enableAllLibraries) : true;
      const enabledFolderIds = Array.isArray(options.enabledFolderIds)
        ? options.enabledFolderIds.map((x) => String(x).trim()).filter(Boolean)
        : [];
      const parsedStreams = Number(options.maxConcurrentStreams);
      const maxConcurrentStreams =
        options.maxConcurrentStreams !== undefined &&
        options.maxConcurrentStreams !== '' &&
        Number.isFinite(parsedStreams)
          ? Math.max(0, Math.floor(parsedStreams))
          : 2;
      const seerrAutoApprove = Boolean(options.seerrAutoApprove);
      const decisionNote = String(options.decisionNote || '')
        .trim()
        .slice(0, 500);
      const passwordOverride = String(options.passwordOverride || '');

      let password = '';
      if (passwordOverride) {
        if (passwordOverride.length < 8 || passwordOverride.length > 128) {
          throw new HttpError(400, 'Password override must be between 8 and 128 characters');
        }
        password = passwordOverride;
      } else if (target.encryptedPassword) {
        password = decryptSecret(target.encryptedPassword);
      } else {
        throw new HttpError(400, 'No stored password available; provide passwordOverride');
      }

      let jfUser = null;
      if (grantJellyfin) {
        jfUser = await provisionJellyfinAccount(target.username, password, {
          enableAllLibraries,
          enabledFolderIds,
          maxConcurrentStreams,
          allowExistingUser: Boolean(options.allowExistingUser)
        });
      }

      const warnings = [];
      let seerrUserId = null;
      let seerrProvisionError = null;

      if (grantSeerr) {
        let jfIdForSeerr = jfUser ? jfUser.Id : null;
        if (!jfIdForSeerr && getEnv('JELLYFIN_API_KEY')) {
          const existingJf = await findJellyfinUserByUsername(target.username).catch(() => null);
          jfIdForSeerr = existingJf ? existingJf.Id : null;
        }
        const seerrOutcome = await provisionSeerrAccount(
          jfIdForSeerr,
          target.username,
          seerrAutoApprove
        );
        seerrUserId = seerrOutcome.seerrUserId;
        if (seerrOutcome.warning) {
          seerrProvisionError = seerrOutcome.warning;
          warnings.push(seerrOutcome.warning);
        }
      }

      const grantedOptions = {
        grantJellyfin,
        grantSeerr,
        enableAllLibraries,
        enabledFolderIds: enableAllLibraries ? [] : enabledFolderIds,
        maxConcurrentStreams,
        seerrAutoApprove
      };

      let updatedRecord = null;
      await withStoreLock(() => {
        const store = readStore();
        const rec = store.requests.find((r) => r.id === reqId);
        if (!rec) throw new HttpError(404, 'Access request disappeared during approval');
        if (rec.status !== 'pending') {
          throw new HttpError(409, `Access request has already been ${rec.status}`);
        }
        delete rec.encryptedPassword;
        rec.status = 'approved';
        rec.reviewedAt = new Date().toISOString();
        rec.reviewedBy = adminUsername || 'admin';
        rec.decisionNote = decisionNote;
        rec.jellyfinUserId = jfUser ? jfUser.Id : null;
        rec.seerrUserId = seerrUserId;
        rec.seerrProvisionError = seerrProvisionError;
        rec.warnings = warnings;
        rec.grantedOptions = grantedOptions;
        writeStore(store);
        updatedRecord = sanitizeRequest(rec);
      });

      return {
        request: updatedRecord,
        jellyfinUserId: updatedRecord.jellyfinUserId,
        seerrUserId: updatedRecord.seerrUserId,
        warnings
      };
    } finally {
      inFlightApprovals.delete(reqId);
    }
  }

  async function rejectRequest(id, note = '', adminUsername = 'admin') {
    const reqId = String(id || '').trim();
    if (!reqId) throw new HttpError(400, 'Missing request ID');

    let updatedRecord = null;
    await withStoreLock(() => {
      const store = readStore();
      const rec = store.requests.find((r) => r.id === reqId);
      if (!rec) throw new HttpError(404, 'Access request not found');
      if (rec.status !== 'pending') {
        throw new HttpError(409, `Access request has already been ${rec.status}`);
      }
      delete rec.encryptedPassword;
      rec.status = 'rejected';
      rec.decisionNote = String(note || '')
        .trim()
        .slice(0, 500);
      rec.reviewedAt = new Date().toISOString();
      rec.reviewedBy = adminUsername || 'admin';
      writeStore(store);
      updatedRecord = sanitizeRequest(rec);
    });

    return { request: updatedRecord };
  }

  // ============================================================================
  // DIRECTORY USER MANAGEMENT
  // ============================================================================

  async function listDirectoryUsers() {
    if (!getEnv('JELLYFIN_API_KEY')) {
      throw new HttpError(503, 'JELLYFIN_API_KEY is not configured on dashboard server');
    }

    const seerrKey = getEnv('SEERR_API_KEY');
    const [jfResult, seerrResult] = await Promise.allSettled([
      jellyfinFetch('/Users', { method: 'GET' }, 4500),
      seerrKey
        ? seerrFetch('/api/v1/user?take=100', { method: 'GET' }, 4500)
        : Promise.resolve(null)
    ]);

    if (jfResult.status !== 'fulfilled' || !jfResult.value.ok) {
      const code = jfResult.status === 'fulfilled' ? jfResult.value.status : 'unreachable';
      throw new HttpError(502, `Failed to load Jellyfin users (${code})`);
    }

    const jfUsers = await jfResult.value.json();
    let seerrUsers = [];
    let seerrReachable = false;

    if (seerrResult.status === 'fulfilled' && seerrResult.value && seerrResult.value.ok) {
      seerrReachable = true;
      const seerrData = await seerrResult.value.json();
      seerrUsers = Array.isArray(seerrData && seerrData.results) ? seerrData.results : [];
    }

    const seerrByJfId = new Map();
    const seerrByUsername = new Map();
    for (const su of seerrUsers) {
      if (!su) continue;
      if (su.jellyfinUserId) seerrByJfId.set(su.jellyfinUserId, su);
      const uname = (su.jellyfinUsername || su.username || '').toLowerCase();
      if (uname) seerrByUsername.set(uname, su);
    }

    const users = (Array.isArray(jfUsers) ? jfUsers : []).map((u) => {
      const policy = u.Policy || {};
      const matchedSeerr =
        seerrByJfId.get(u.Id) || seerrByUsername.get(String(u.Name || '').toLowerCase()) || null;

      return {
        id: u.Id,
        username: u.Name,
        isAdmin: Boolean(policy.IsAdministrator),
        isDisabled: Boolean(policy.IsDisabled),
        enableAllFolders: Boolean(policy.EnableAllFolders),
        enabledFolders: Array.isArray(policy.EnabledFolders) ? policy.EnabledFolders : [],
        maxActiveSessions: policy.MaxActiveSessions ?? 0,
        lastLoginDate: u.LastLoginDate || null,
        lastActivityDate: u.LastActivityDate || null,
        hasPassword: Boolean(u.HasPassword),
        seerrUser: matchedSeerr
          ? {
              id: matchedSeerr.id,
              email: matchedSeerr.email || '',
              displayName: matchedSeerr.displayName || '',
              permissions: matchedSeerr.permissions ?? 0,
              requestCount: matchedSeerr.requestCount ?? 0,
              userType: matchedSeerr.userType || null
            }
          : null
      };
    });

    return { users, jellyfinReachable: true, seerrReachable };
  }

  function isSelfUser(jfUser, actor = {}) {
    if (!jfUser || !actor) return false;
    if (actor.userId && jfUser.Id && jfUser.Id === actor.userId) return true;
    if (
      actor.username &&
      jfUser.Name &&
      jfUser.Name.toLowerCase() === String(actor.username).toLowerCase()
    ) {
      return true;
    }
    return false;
  }

  async function toggleUser(jellyfinId, disabled, actor = {}) {
    const id = String(jellyfinId || '').trim();
    if (!id) throw new HttpError(400, 'Missing Jellyfin user ID');
    if (!getEnv('JELLYFIN_API_KEY')) {
      throw new HttpError(503, 'JELLYFIN_API_KEY is not configured on dashboard server');
    }

    let userRes;
    try {
      userRes = await jellyfinFetch(`/Users/${encodeURIComponent(id)}`, { method: 'GET' }, 4500);
    } catch (err) {
      throw new HttpError(503, `Jellyfin unreachable: ${err.message}`);
    }
    if (userRes.status === 404) throw new HttpError(404, 'Jellyfin user not found');
    if (!userRes.ok) throw new HttpError(502, `Failed to load user (HTTP ${userRes.status})`);

    const jfUser = await userRes.json();
    const nextDisabled =
      disabled !== undefined
        ? Boolean(disabled)
        : !Boolean(jfUser.Policy && jfUser.Policy.IsDisabled);

    if (
      nextDisabled &&
      (isSelfUser(jfUser, actor) || (jfUser.Policy && jfUser.Policy.IsAdministrator))
    ) {
      throw new HttpError(403, 'Cannot disable an administrator or your own active account');
    }

    const nextPolicy = {
      ...(jfUser.Policy || {}),
      IsDisabled: nextDisabled
    };

    const polRes = await jellyfinFetch(
      `/Users/${encodeURIComponent(id)}/Policy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextPolicy)
      },
      5000
    );
    if (!polRes.ok) {
      throw new HttpError(502, `Failed to update user policy (HTTP ${polRes.status})`);
    }

    return {
      success: true,
      id: jfUser.Id,
      username: jfUser.Name,
      isDisabled: nextDisabled
    };
  }

  async function deleteUser(jellyfinId, actor = {}) {
    const id = String(jellyfinId || '').trim();
    if (!id) throw new HttpError(400, 'Missing Jellyfin user ID');
    if (!getEnv('JELLYFIN_API_KEY')) {
      throw new HttpError(503, 'JELLYFIN_API_KEY is not configured on dashboard server');
    }

    let userRes;
    try {
      userRes = await jellyfinFetch(`/Users/${encodeURIComponent(id)}`, { method: 'GET' }, 4500);
    } catch (err) {
      throw new HttpError(503, `Jellyfin unreachable: ${err.message}`);
    }
    if (userRes.status === 404) throw new HttpError(404, 'Jellyfin user not found');
    if (!userRes.ok) throw new HttpError(502, `Failed to load user (HTTP ${userRes.status})`);

    const jfUser = await userRes.json();
    if (isSelfUser(jfUser, actor) || (jfUser.Policy && jfUser.Policy.IsAdministrator)) {
      throw new HttpError(403, 'Refusing to delete an administrator or your own active account');
    }

    let seerrDeleted = false;
    let seerrWarning = null;
    if (getEnv('SEERR_API_KEY')) {
      try {
        const seerrUser = await findSeerrUser(jfUser.Id, jfUser.Name);
        if (seerrUser && seerrUser.id) {
          const delSeerrRes = await seerrFetch(
            `/api/v1/user/${encodeURIComponent(seerrUser.id)}`,
            { method: 'DELETE' },
            5000
          );
          if (delSeerrRes.ok || delSeerrRes.status === 404) {
            seerrDeleted = delSeerrRes.ok;
          } else {
            seerrWarning = `Seerr user deletion returned HTTP ${delSeerrRes.status}`;
          }
        }
      } catch (err) {
        seerrWarning = `Seerr user deletion error: ${err.message}`;
      }
    }

    const delJfRes = await jellyfinFetch(
      `/Users/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      5000
    );
    if (!delJfRes.ok) {
      throw new HttpError(502, `Failed to delete Jellyfin user (HTTP ${delJfRes.status})`);
    }

    return {
      success: true,
      id: jfUser.Id,
      username: jfUser.Name,
      seerrDeleted,
      warning: seerrWarning
    };
  }

  return {
    SESSION_COOKIE_NAME,
    HttpError,
    configure,
    resolveDataDir,
    getJellyfinBaseUrls,
    getJellyfinUrls,
    getSeerrBaseUrls,
    getSeerrUrls,
    jellyfinHeaders,
    seerrHeaders,
    jellyfinFetch,
    seerrFetch,
    handleAuthLogin,
    verifySession,
    getAuthStatus,
    buildSessionCookie,
    clearSessionCookie,
    getSignupOptions,
    createSignupRequest,
    getSignupStatus,
    listAccessRequests,
    getLibraries,
    approveRequest,
    rejectRequest,
    listDirectoryUsers,
    toggleUser,
    deleteUser
  };
}

const defaultManager = createAccessManager();

module.exports = {
  ...defaultManager,
  createAccessManager,
  HttpError,
  SESSION_COOKIE_NAME
};
