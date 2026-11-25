/**
 * Jellyfin Login Signup & Access Request Module (dx.bi Theme)
 * Architectural Component: Non-Invasive Login Page Access Request & Status Checker
 *
 * Capabilities:
 *  1. SPA Route Lifecycle: Listens for hashchange, popstate, viewshow, pageshow, and
 *     debounced MutationObserver on #loginPage / .manualLoginForm / #/login.
 *  2. Non-Blocking Injection: Injects #orbit-jf-signup-box cleanly BELOW .manualLoginForm
 *     (never inside Jellyfin's native login form, never intercepting native login submits).
 *  3. Live Status Badge: Automatically checks /api/auth/signup-status when
 *     localStorage.getItem('orbit_jf_signup_token') exists, supporting Pending, Approved
 *     (with one-click username prefill helper), and Declined (+ admin note) states.
 *  4. Frosted dx.bi Modal: Dynamic library options via GET :3000/api/auth/signup-options
 *     (with graceful fallback) and validated submission to POST :3000/api/auth/signup-request.
 */

(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__ORBIT_JELLYFIN_SIGNUP_INITIALIZED__) {
    return;
  }
  window.__ORBIT_JELLYFIN_SIGNUP_INITIALIZED__ = true;

  // --- CONFIGURATION CONSTANTS ---
  const BOX_ID = 'orbit-jf-signup-box';
  const MODAL_ID = 'orbit-jf-signup-modal';
  const STYLES_ID = 'orbit-jf-signup-styles';
  const STATUS_TOKEN_KEY = 'orbit_jf_signup_token';
  const USERNAME_STORAGE_KEY = 'orbit_jf_signup_username';
  const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const FETCH_TIMEOUT_MS = 8000;

  const FALLBACK_LIBRARIES = [
    { id: 'Movies', name: 'Movies' },
    { id: 'TV Shows', name: 'TV Shows' },
    { id: 'Anime', name: 'Anime' },
    { id: 'Music', name: 'Music' }
  ];

  // --- STATE ---
  let reconcileTimer = null;
  let loginPageObserver = null;
  let observedLoginPage = null;
  let cachedOptions = null;
  let optionsPromise = null;
  let activeModalTab = 'signup'; // 'signup' | 'status' | 'success'
  let latestStatusState = null;
  let isCheckingStatus = false;
  let isSubmittingSignup = false;
  let lastCheckedToken = '';

  /**
   * Resolve the Alpha Orbit Dashboard base URL.
   * Preserves window.location.protocol and window.location.hostname on port 3000,
   * unless overridden via window.__ORBIT_DASHBOARD_URL__.
   */
  function getDashboardBaseUrl() {
    if (typeof window.__ORBIT_DASHBOARD_URL__ === 'string') {
      const override = window.__ORBIT_DASHBOARD_URL__.trim().replace(/\/+$/, '');
      if (override) return override;
    }
    const proto = (window.location && window.location.protocol) || 'http:';
    const host = (window.location && window.location.hostname) || 'localhost';
    return `${proto}//${host}:3000`;
  }

  function getStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function setStored(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {}
  }

  function removeStored(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }
      return { response, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- STYLESHEET INJECTION (dx.bi OBSIDIAN PALETTE) ---
  function injectStyles() {
    if (document.getElementById(STYLES_ID)) return;

    const styleEl = document.createElement('style');
    styleEl.id = STYLES_ID;
    styleEl.textContent = `
      :root {
        --orbit-dx-bg: #0b0b0d;
        --orbit-dx-raised: #131317;
        --orbit-dx-surface: #18181d;
        --orbit-dx-surface-2: #212128;
        --orbit-dx-accent: #e50914;
        --orbit-dx-accent-hover: #f40612;
        --orbit-dx-text: #f4f4f5;
        --orbit-dx-text-2: #c4c4cc;
        --orbit-dx-text-3: #8a8a96;
        --orbit-dx-line: rgba(255, 255, 255, 0.12);
        --orbit-dx-line-strong: rgba(255, 255, 255, 0.22);
        --orbit-dx-font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        --orbit-dx-display: "Bebas Neue", "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
      }

      /* ── Login CTA Obsidian Card ── */
      #${BOX_ID} {
        position: relative;
        width: 100%;
        max-width: 100%;
        margin: 22px auto 8px auto;
        padding: 20px 22px;
        border-radius: 14px;
        background: linear-gradient(155deg, rgba(24, 24, 29, 0.96) 0%, rgba(19, 19, 23, 0.98) 100%);
        border: 1px solid var(--orbit-dx-line);
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        color: var(--orbit-dx-text);
        font-family: var(--orbit-dx-font);
        box-sizing: border-box;
        text-align: left;
        overflow: hidden;
      }

      #${BOX_ID}::before {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, var(--orbit-dx-accent) 0%, rgba(229, 9, 20, 0.25) 55%, transparent 100%);
        pointer-events: none;
      }

      .orbit-jf-card-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }

      .orbit-jf-eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: var(--orbit-dx-display);
        font-size: 0.95rem;
        letter-spacing: 0.1em;
        color: var(--orbit-dx-accent);
        line-height: 1;
        margin-bottom: 5px;
      }

      .orbit-jf-card-title {
        margin: 0;
        font-size: 1.08rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--orbit-dx-text);
      }

      .orbit-jf-card-subtitle {
        margin: 4px 0 0 0;
        font-size: 0.86rem;
        line-height: 1.45;
        color: var(--orbit-dx-text-2);
      }

      .orbit-jf-cta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }

      .orbit-jf-btn-accent {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        flex: 1 1 200px;
        min-height: 42px;
        padding: 10px 18px;
        border-radius: 9999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--orbit-dx-accent);
        color: #ffffff;
        font-family: var(--orbit-dx-font);
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(229, 9, 20, 0.35);
        transition: background-color 0.2s ease, transform 0.18s ease, box-shadow 0.2s ease;
      }

      .orbit-jf-btn-accent:hover {
        background: var(--orbit-dx-accent-hover);
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(229, 9, 20, 0.5);
      }

      .orbit-jf-btn-accent:focus-visible,
      .orbit-jf-btn-secondary:focus-visible,
      .orbit-jf-btn-white:focus-visible,
      .orbit-jf-close-btn:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }

      .orbit-jf-btn-secondary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        flex: 0 1 auto;
        min-height: 42px;
        padding: 10px 16px;
        border-radius: 9999px;
        border: 1px solid var(--orbit-dx-line-strong);
        background: var(--orbit-dx-surface-2);
        color: var(--orbit-dx-text);
        font-family: var(--orbit-dx-font);
        font-size: 0.87rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.18s ease;
      }

      .orbit-jf-btn-secondary:hover {
        background: #2b2b33;
        border-color: rgba(255, 255, 255, 0.45);
        transform: translateY(-1px);
      }

      .orbit-jf-btn-white {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 32px;
        padding: 6px 13px;
        border-radius: 9999px;
        border: none;
        background: #ffffff;
        color: #000000;
        font-family: var(--orbit-dx-font);
        font-size: 0.8rem;
        font-weight: 700;
        cursor: pointer;
        transition: background-color 0.18s ease, transform 0.18s ease;
      }

      .orbit-jf-btn-white:hover {
        background: rgba(255, 255, 255, 0.85);
        transform: translateY(-1px);
      }

      /* ── Live Inline Status Badge Area ── */
      .orbit-jf-status-area {
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }

      .orbit-jf-status-area.is-empty {
        display: none;
      }

      .orbit-jf-status-pill {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 10px;
        background: var(--orbit-dx-raised);
        border: 1px solid var(--orbit-dx-line);
        font-size: 0.84rem;
        line-height: 1.4;
      }

      .orbit-jf-status-pill.is-pending {
        border-color: rgba(245, 158, 11, 0.42);
        background: rgba(245, 158, 11, 0.08);
      }

      .orbit-jf-status-pill.is-approved {
        border-color: rgba(16, 185, 129, 0.5);
        background: rgba(16, 185, 129, 0.12);
      }

      .orbit-jf-status-pill.is-declined {
        border-color: rgba(229, 9, 20, 0.55);
        background: rgba(229, 9, 20, 0.12);
      }

      .orbit-jf-status-main {
        display: flex;
        align-items: center;
        gap: 9px;
        flex: 1 1 200px;
        min-width: 0;
      }

      .orbit-jf-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: var(--orbit-dx-text-3);
      }

      .is-pending .orbit-jf-status-dot {
        background: #f59e0b;
        box-shadow: 0 0 8px rgba(245, 158, 11, 0.65);
      }

      .is-approved .orbit-jf-status-dot {
        background: #10b981;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.65);
      }

      .is-declined .orbit-jf-status-dot {
        background: var(--orbit-dx-accent);
        box-shadow: 0 0 8px rgba(229, 9, 20, 0.65);
      }

      .orbit-jf-status-text strong {
        color: var(--orbit-dx-text);
        font-weight: 700;
      }

      .orbit-jf-status-note {
        display: block;
        margin-top: 2px;
        color: var(--orbit-dx-text-2);
        font-size: 0.79rem;
        word-break: break-word;
      }

      .orbit-jf-status-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      .orbit-jf-link-btn {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: var(--orbit-dx-text-2);
        border-radius: 9999px;
        padding: 5px 10px;
        font-family: var(--orbit-dx-font);
        font-size: 0.76rem;
        font-weight: 600;
        cursor: pointer;
        transition: color 0.18s ease, border-color 0.18s ease, background-color 0.18s ease;
      }

      .orbit-jf-link-btn:hover {
        color: #ffffff;
        border-color: rgba(255, 255, 255, 0.4);
        background: rgba(255, 255, 255, 0.08);
      }

      /* ── Frosted dx.bi Modal ── */
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 999999;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(11, 11, 13, 0.84);
        backdrop-filter: blur(22px);
        -webkit-backdrop-filter: blur(22px);
        font-family: var(--orbit-dx-font);
        color: var(--orbit-dx-text);
        box-sizing: border-box;
      }

      #${MODAL_ID}.is-open {
        display: flex;
      }

      .orbit-jf-modal-card {
        position: relative;
        width: min(560px, 100%);
        max-height: min(90vh, 840px);
        display: flex;
        flex-direction: column;
        border-radius: 14px;
        background: linear-gradient(165deg, rgba(24, 24, 29, 0.98) 0%, rgba(11, 11, 13, 0.98) 100%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.88), 0 0 0 1px rgba(255, 255, 255, 0.04);
        overflow: hidden;
        box-sizing: border-box;
      }

      .orbit-jf-modal-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
        padding: 20px 22px 14px 22px;
        background: rgba(19, 19, 23, 0.72);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .orbit-jf-modal-brand {
        font-family: var(--orbit-dx-display);
        font-size: 1.05rem;
        letter-spacing: 0.08em;
        color: var(--orbit-dx-accent);
        line-height: 1;
        margin-bottom: 4px;
      }

      .orbit-jf-modal-title {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: #ffffff;
      }

      .orbit-jf-close-btn {
        width: 34px;
        height: 34px;
        flex-shrink: 0;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: var(--orbit-dx-surface-2);
        color: var(--orbit-dx-text);
        font-size: 1.15rem;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background-color 0.18s ease, border-color 0.18s ease;
      }

      .orbit-jf-close-btn:hover {
        background: rgba(255, 255, 255, 0.16);
        border-color: rgba(255, 255, 255, 0.45);
      }

      .orbit-jf-modal-tabs {
        display: flex;
        gap: 8px;
        padding: 12px 22px 0 22px;
        background: rgba(19, 19, 23, 0.45);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .orbit-jf-tab-btn {
        position: relative;
        padding: 8px 4px 10px 4px;
        margin-right: 12px;
        background: transparent;
        border: none;
        color: var(--orbit-dx-text-3);
        font-family: var(--orbit-dx-font);
        font-size: 0.87rem;
        font-weight: 600;
        cursor: pointer;
        transition: color 0.18s ease;
      }

      .orbit-jf-tab-btn:hover {
        color: var(--orbit-dx-text);
      }

      .orbit-jf-tab-btn.is-active {
        color: #ffffff;
      }

      .orbit-jf-tab-btn.is-active::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: -1px;
        height: 2px;
        background: var(--orbit-dx-accent);
        border-radius: 2px;
      }

      .orbit-jf-modal-body {
        padding: 18px 22px 22px 22px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
      }

      .orbit-jf-form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 13px;
      }

      .orbit-jf-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .orbit-jf-field.is-full {
        grid-column: 1 / -1;
      }

      .orbit-jf-label {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--orbit-dx-text-2);
      }

      .orbit-jf-hint {
        font-size: 0.74rem;
        color: var(--orbit-dx-text-3);
      }

      .orbit-jf-input {
        width: 100%;
        height: 40px;
        padding: 0 12px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: var(--orbit-dx-raised);
        color: var(--orbit-dx-text);
        font-family: var(--orbit-dx-font);
        font-size: 0.89rem;
        box-sizing: border-box;
        transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
      }

      .orbit-jf-input::placeholder {
        color: var(--orbit-dx-text-3);
      }

      .orbit-jf-input:focus {
        outline: none;
        background: var(--orbit-dx-surface-2);
        border-color: rgba(255, 255, 255, 0.65);
        box-shadow: 0 0 0 2px rgba(229, 9, 20, 0.25);
      }

      .orbit-jf-check-group {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .orbit-jf-check-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: var(--orbit-dx-raised);
        color: var(--orbit-dx-text);
        font-size: 0.84rem;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        transition: border-color 0.18s ease, background-color 0.18s ease;
      }

      .orbit-jf-check-pill:hover {
        background: var(--orbit-dx-surface-2);
        border-color: rgba(255, 255, 255, 0.28);
      }

      .orbit-jf-check-pill input[type="checkbox"] {
        accent-color: var(--orbit-dx-accent);
        width: 15px;
        height: 15px;
        margin: 0;
        cursor: pointer;
      }

      .orbit-jf-alert {
        margin-bottom: 14px;
        padding: 11px 13px;
        border-radius: 9px;
        font-size: 0.84rem;
        line-height: 1.45;
      }

      .orbit-jf-alert.is-error {
        background: rgba(229, 9, 20, 0.14);
        border: 1px solid rgba(229, 9, 20, 0.52);
        color: #fecaca;
      }

      .orbit-jf-alert.is-info {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: var(--orbit-dx-text-2);
      }

      .orbit-jf-modal-footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }

      .orbit-jf-submit-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 42px;
        padding: 10px 22px;
        border-radius: 9999px;
        border: none;
        background: var(--orbit-dx-accent);
        color: #ffffff;
        font-family: var(--orbit-dx-font);
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(229, 9, 20, 0.35);
        transition: background-color 0.18s ease, transform 0.18s ease, opacity 0.18s ease;
      }

      .orbit-jf-submit-btn:hover:not(:disabled) {
        background: var(--orbit-dx-accent-hover);
        transform: translateY(-1px);
      }

      .orbit-jf-submit-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .orbit-jf-token-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 14px;
        margin: 12px 0;
        border-radius: 10px;
        background: var(--orbit-dx-bg);
        border: 1px solid rgba(255, 255, 255, 0.16);
      }

      .orbit-jf-token-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.84rem;
        color: #ffffff;
        word-break: break-all;
      }

      @media (max-width: 600px) {
        .orbit-jf-form-grid {
          grid-template-columns: 1fr;
        }
        #${BOX_ID} {
          padding: 16px;
        }
      }
    `;
    document.head.appendChild(styleEl);
  }

  // --- LOGIN ROUTE DETECTION ---
  function getLoginContext() {
    const hash = (window.location.hash || '').toLowerCase();
    const loginPage = document.getElementById('loginPage');
    const manualForm = document.querySelector('#loginPage .manualLoginForm, .manualLoginForm');

    if (!manualForm) {
      return { active: false, loginPage: null, manualForm: null };
    }

    if (loginPage && (loginPage.classList.contains('hide') || loginPage.style.display === 'none')) {
      return { active: false, loginPage, manualForm };
    }

    const parentPage = manualForm.closest('.page, [data-role="page"]');
    if (parentPage && (parentPage.classList.contains('hide') || parentPage.style.display === 'none')) {
      return { active: false, loginPage, manualForm };
    }

    if (
      hash &&
      !hash.includes('login') &&
      /^#\/?(home|details|list|search|movies|tv|music|mypreferences|dashboard|userprofile|video|playback)/i.test(hash)
    ) {
      return { active: false, loginPage, manualForm };
    }

    return { active: true, loginPage, manualForm };
  }

  function cleanupSignupBox() {
    const existing = document.getElementById(BOX_ID);
    if (existing) {
      existing.remove();
    }
    lastCheckedToken = '';
    const modal = document.getElementById(MODAL_ID);
    if (modal && modal.classList.contains('is-open')) {
      closeModal();
    }
  }

  // --- JELLYFIN LOGIN PREFILL HELPER ---
  function setNativeInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function prefillJellyfinLogin(username) {
    if (!username) return;
    const manualForm = document.querySelector('#loginPage .manualLoginForm, .manualLoginForm');
    if (manualForm && manualForm.classList.contains('hide')) {
      const manualBtn = document.querySelector('#loginPage .btnManual, .btnManual');
      if (manualBtn) {
        try { manualBtn.click(); } catch {}
      }
      manualForm.classList.remove('hide');
    }

    const nameInput = document.querySelector(
      '#txtManualName, #loginPage input[type="text"], .manualLoginForm input[type="text"], .manualLoginForm input[autocomplete="username"]'
    );
    const passInput = document.querySelector(
      '#txtManualPassword, #loginPage input[type="password"], .manualLoginForm input[type="password"]'
    );

    if (nameInput) {
      setNativeInputValue(nameInput, username);
    }
    if (passInput) {
      passInput.focus();
    } else if (nameInput) {
      nameInput.focus();
    }
  }

  // --- SIGNUP OPTIONS & STATUS API ---
  function normalizeLibraries(rawData) {
    const list =
      (Array.isArray(rawData) && rawData) ||
      (Array.isArray(rawData?.libraries) && rawData.libraries) ||
      (Array.isArray(rawData?.jellyfinLibraries) && rawData.jellyfinLibraries) ||
      (Array.isArray(rawData?.data?.libraries) && rawData.data.libraries) ||
      null;

    if (!list || list.length === 0) {
      return { libraries: FALLBACK_LIBRARIES, isFallback: true };
    }

    const normalized = list
      .map((entry) => {
        if (typeof entry === 'string') {
          const clean = entry.trim();
          return clean ? { id: clean, name: clean } : null;
        }
        if (entry && typeof entry === 'object') {
          const id = String(entry.id ?? entry.value ?? entry.name ?? entry.label ?? '').trim();
          const name = String(entry.name ?? entry.label ?? entry.title ?? id).trim();
          if (!id || !name) return null;
          return {
            id,
            name,
            defaultSelected: entry.defaultSelected !== false && entry.default !== false
          };
        }
        return null;
      })
      .filter(Boolean);

    if (normalized.length === 0) {
      return { libraries: FALLBACK_LIBRARIES, isFallback: true };
    }
    return { libraries: normalized, isFallback: false };
  }

  async function loadSignupOptions(forceRefresh = false) {
    if (cachedOptions && !forceRefresh) return cachedOptions;
    if (optionsPromise && !forceRefresh) return optionsPromise;

    const url = `${getDashboardBaseUrl()}/api/auth/signup-options`;
    optionsPromise = (async () => {
      try {
        const { response, data } = await fetchJsonWithTimeout(url, { method: 'GET' }, 5000);
        if (!response.ok || !data) {
          cachedOptions = { libraries: FALLBACK_LIBRARIES, isFallback: true };
          return cachedOptions;
        }
        cachedOptions = normalizeLibraries(data);
        return cachedOptions;
      } catch {
        cachedOptions = { libraries: FALLBACK_LIBRARIES, isFallback: true };
        return cachedOptions;
      } finally {
        optionsPromise = null;
      }
    })();

    return optionsPromise;
  }

  function parseStatusPayload(data) {
    const record = data?.request || data?.data || data || {};
    const rawStatus = String(record.status || data?.status || 'pending').toLowerCase();
    let status = 'pending';
    if (rawStatus === 'approved' || rawStatus === 'active' || rawStatus === 'accepted') {
      status = 'approved';
    } else if (rawStatus === 'declined' || rawStatus === 'rejected' || rawStatus === 'denied') {
      status = 'declined';
    }

    return {
      status,
      username: record.username || data?.username || getStored(USERNAME_STORAGE_KEY) || '',
      note: record.adminNote || record.note || record.reason || data?.adminNote || data?.note || data?.reason || '',
      reviewedAt: record.reviewedAt || record.updatedAt || data?.reviewedAt || ''
    };
  }

  async function querySignupStatus(token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) return null;

    isCheckingStatus = true;
    renderBannerStatus();

    const url = `${getDashboardBaseUrl()}/api/auth/signup-status?token=${encodeURIComponent(cleanToken)}`;
    try {
      const { response, data } = await fetchJsonWithTimeout(url, { method: 'GET' });
      if (response.status === 404) {
        latestStatusState = {
          status: 'not_found',
          token: cleanToken,
          note: data?.error || data?.message || 'Request token was not found or has expired.'
        };
        return latestStatusState;
      }
      if (!response.ok) {
        latestStatusState = {
          status: 'error',
          token: cleanToken,
          note: data?.error || data?.message || `Status check returned HTTP ${response.status}.`
        };
        return latestStatusState;
      }
      const parsed = parseStatusPayload(data);
      latestStatusState = { ...parsed, token: cleanToken };
      if (parsed.username) {
        setStored(USERNAME_STORAGE_KEY, parsed.username);
      }
      return latestStatusState;
    } catch {
      latestStatusState = {
        status: 'error',
        token: cleanToken,
        note: `Unable to reach ${getDashboardBaseUrl()} to check status.`
      };
      return latestStatusState;
    } finally {
      isCheckingStatus = false;
      lastCheckedToken = cleanToken;
      renderBannerStatus();
      renderModalStatusResult();
    }
  }

  // --- BANNER RENDERING ---
  function renderBannerStatus() {
    const box = document.getElementById(BOX_ID);
    if (!box) return;
    const area = box.querySelector('.orbit-jf-status-area');
    if (!area) return;

    const storedToken = getStored(STATUS_TOKEN_KEY);
    if (!storedToken) {
      area.classList.add('is-empty');
      area.innerHTML = '';
      return;
    }

    area.classList.remove('is-empty');

    if (isCheckingStatus && (!latestStatusState || latestStatusState.token !== storedToken)) {
      area.innerHTML = `
        <div class="orbit-jf-status-pill is-pending">
          <div class="orbit-jf-status-main">
            <span class="orbit-jf-status-dot"></span>
            <div class="orbit-jf-status-text">
              <strong>Checking access request status...</strong>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const st = latestStatusState || { status: 'pending', token: storedToken };
    const username = st.username || getStored(USERNAME_STORAGE_KEY) || '';
    let pillClass = 'is-pending';
    let headline = 'Pending Admin Review';
    let noteText = username ? `Requested username: ${username}` : 'Your request is awaiting administrator approval.';
    let actionHtml = `
      <button type="button" class="orbit-jf-link-btn" data-orbit-action="refresh-status">Refresh</button>
    `;

    if (st.status === 'approved') {
      pillClass = 'is-approved';
      headline = 'Approved — You can sign in above!';
      noteText = username ? `Account ready for "${username}".` : 'Your Jellyfin account is active.';
      actionHtml = `
        ${username ? `<button type="button" class="orbit-jf-btn-white" data-orbit-action="prefill-username" data-username="${escapeHtml(username)}">Fill Username</button>` : ''}
        <button type="button" class="orbit-jf-link-btn" data-orbit-action="dismiss-status" title="Hide this status banner">Dismiss</button>
      `;
    } else if (st.status === 'declined') {
      pillClass = 'is-declined';
      headline = 'Declined';
      noteText = st.note || 'Your access request was declined by an administrator.';
      actionHtml = `
        <button type="button" class="orbit-jf-link-btn" data-orbit-action="dismiss-status">Clear</button>
      `;
    } else if (st.status === 'not_found') {
      pillClass = 'is-declined';
      headline = 'Request Token Not Found';
      noteText = st.note || 'Token may have expired or been cleared.';
      actionHtml = `
        <button type="button" class="orbit-jf-link-btn" data-orbit-action="dismiss-status">Clear</button>
      `;
    } else if (st.status === 'error') {
      pillClass = 'is-pending';
      headline = 'Saved Request Token';
      noteText = st.note || 'Could not reach dashboard right now.';
    }

    area.innerHTML = `
      <div class="orbit-jf-status-pill ${pillClass}">
        <div class="orbit-jf-status-main">
          <span class="orbit-jf-status-dot"></span>
          <div class="orbit-jf-status-text">
            <strong>${escapeHtml(headline)}</strong>
            ${noteText ? `<span class="orbit-jf-status-note">${escapeHtml(noteText)}</span>` : ''}
          </div>
        </div>
        <div class="orbit-jf-status-actions">${actionHtml}</div>
      </div>
    `;
  }

  function injectSignupBox(manualForm) {
    if (!manualForm) return;
    const existing = document.getElementById(BOX_ID);
    if (existing) {
      if (existing.previousElementSibling === manualForm) {
        renderBannerStatus();
        return;
      }
      existing.remove();
    }

    const box = document.createElement('section');
    box.id = BOX_ID;
    box.setAttribute('aria-label', 'Alpha Orbit Access Request');
    box.innerHTML = `
      <div class="orbit-jf-card-top">
        <div>
          <div class="orbit-jf-eyebrow">ALPHA ORBIT · DX.BI</div>
          <h3 class="orbit-jf-card-title">Need a Jellyfin Cinema Account?</h3>
          <p class="orbit-jf-card-subtitle">Request personal streaming and Seerr media access. Approvals take effect immediately.</p>
        </div>
      </div>
      <div class="orbit-jf-cta-row">
        <button type="button" class="orbit-jf-btn-accent" data-orbit-action="open-signup">
          Request Access / Sign Up
        </button>
        <button type="button" class="orbit-jf-btn-secondary" data-orbit-action="open-status">
          Check Request Status
        </button>
      </div>
      <div class="orbit-jf-status-area is-empty"></div>
    `;

    box.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-orbit-action]');
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();

      const action = btn.getAttribute('data-orbit-action');
      if (action === 'open-signup') {
        openModal('signup');
      } else if (action === 'open-status') {
        openModal('status');
      } else if (action === 'refresh-status') {
        const token = getStored(STATUS_TOKEN_KEY);
        if (token) querySignupStatus(token);
      } else if (action === 'prefill-username') {
        const user = btn.getAttribute('data-username') || latestStatusState?.username || getStored(USERNAME_STORAGE_KEY) || '';
        prefillJellyfinLogin(user);
      } else if (action === 'dismiss-status') {
        removeStored(STATUS_TOKEN_KEY);
        latestStatusState = null;
        lastCheckedToken = '';
        renderBannerStatus();
      }
    });

    manualForm.insertAdjacentElement('afterend', box);
    renderBannerStatus();

    const storedToken = getStored(STATUS_TOKEN_KEY);
    if (storedToken && storedToken !== lastCheckedToken && !isCheckingStatus) {
      querySignupStatus(storedToken);
    }
  }

  // --- MODAL MANAGEMENT ---
  function ensureModalExists() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'orbitJfModalTitle');

    modal.innerHTML = `
      <div class="orbit-jf-modal-card">
        <div class="orbit-jf-modal-header">
          <div>
            <div class="orbit-jf-modal-brand">DX.BI ACCESS GATEWAY</div>
            <h2 class="orbit-jf-modal-title" id="orbitJfModalTitle">Request Alpha Orbit Access</h2>
          </div>
          <button type="button" class="orbit-jf-close-btn" data-orbit-modal="close" aria-label="Close modal">✕</button>
        </div>

        <div class="orbit-jf-modal-tabs">
          <button type="button" class="orbit-jf-tab-btn is-active" data-orbit-tab="signup">Request Access</button>
          <button type="button" class="orbit-jf-tab-btn" data-orbit-tab="status">Check Status</button>
        </div>

        <div class="orbit-jf-modal-body">
          <!-- Signup View -->
          <div id="orbit-jf-panel-signup">
            <div id="orbit-jf-form-error" class="orbit-jf-alert is-error" role="alert" style="display:none;"></div>
            <form id="orbit-jf-signup-form" novalidate>
              <div class="orbit-jf-form-grid">
                <div class="orbit-jf-field">
                  <label class="orbit-jf-label" for="orbitJfFullName">Full Name *</label>
                  <input class="orbit-jf-input" id="orbitJfFullName" name="fullName" type="text" maxlength="80" autocomplete="name" placeholder="Alex Rivera" required>
                </div>

                <div class="orbit-jf-field">
                  <label class="orbit-jf-label" for="orbitJfUsername">Desired Username *</label>
                  <input class="orbit-jf-input" id="orbitJfUsername" name="username" type="text" maxlength="32" autocomplete="username" placeholder="alex.rivera" required>
                  <span class="orbit-jf-hint">3–32 characters: letters, numbers, . _ -</span>
                </div>

                <div class="orbit-jf-field is-full">
                  <label class="orbit-jf-label" for="orbitJfEmail">Email Address *</label>
                  <input class="orbit-jf-input" id="orbitJfEmail" name="email" type="email" maxlength="120" autocomplete="email" placeholder="alex@example.com" required>
                </div>

                <div class="orbit-jf-field">
                  <label class="orbit-jf-label" for="orbitJfPassword">Password *</label>
                  <input class="orbit-jf-input" id="orbitJfPassword" name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Min. 8 characters" required>
                </div>

                <div class="orbit-jf-field">
                  <label class="orbit-jf-label" for="orbitJfConfirmPassword">Confirm Password *</label>
                  <input class="orbit-jf-input" id="orbitJfConfirmPassword" name="confirmPassword" type="password" minlength="8" autocomplete="new-password" placeholder="Repeat password" required>
                </div>

                <div class="orbit-jf-field is-full">
                  <span class="orbit-jf-label">Access Requested *</span>
                  <div class="orbit-jf-check-group">
                    <label class="orbit-jf-check-pill">
                      <input type="checkbox" id="orbitJfAccessJellyfin" name="accessJellyfin" checked>
                      <span>Jellyfin Cinema Access</span>
                    </label>
                    <label class="orbit-jf-check-pill">
                      <input type="checkbox" id="orbitJfAccessSeerr" name="accessSeerr" checked>
                      <span>Seerr Media Requests</span>
                    </label>
                  </div>
                </div>

                <div class="orbit-jf-field is-full" id="orbit-jf-libraries-field">
                  <span class="orbit-jf-label">Libraries</span>
                  <div class="orbit-jf-check-group" id="orbit-jf-libraries-list">
                    <span class="orbit-jf-hint">Loading available libraries...</span>
                  </div>
                </div>

                <div class="orbit-jf-field is-full">
                  <label class="orbit-jf-label" for="orbitJfDeviceNote">Device / Note</label>
                  <input class="orbit-jf-input" id="orbitJfDeviceNote" name="deviceNote" type="text" maxlength="200" placeholder="Apple TV 4K / Living room — invited by ...">
                </div>
              </div>

              <div class="orbit-jf-modal-footer">
                <button type="button" class="orbit-jf-btn-secondary" data-orbit-modal="close">Cancel</button>
                <button type="submit" class="orbit-jf-submit-btn" id="orbit-jf-submit-btn">Submit Access Request</button>
              </div>
            </form>
          </div>

          <!-- Status View -->
          <div id="orbit-jf-panel-status" style="display:none;">
            <div class="orbit-jf-field" style="margin-bottom: 12px;">
              <label class="orbit-jf-label" for="orbitJfStatusTokenInput">Request Status Token</label>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <input class="orbit-jf-input" id="orbitJfStatusTokenInput" type="text" placeholder="Paste your signup status token" style="flex:1 1 240px;">
                <button type="button" class="orbit-jf-submit-btn" id="orbit-jf-status-lookup-btn" style="min-height:40px; padding:0 18px;">Check Status</button>
              </div>
            </div>
            <div id="orbit-jf-modal-status-result"></div>
          </div>

          <!-- Confirmation View -->
          <div id="orbit-jf-panel-success" style="display:none;">
            <div class="orbit-jf-alert is-info" style="border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.10); color: #f4f4f5;">
              <strong>Request submitted for admin review!</strong>
              <div style="margin-top:4px; color:#c4c4cc;">Your status token has been saved in this browser so you can track approval right from the login screen.</div>
            </div>
            <div class="orbit-jf-label" style="margin-top:10px;">Your Status Token</div>
            <div class="orbit-jf-token-box">
              <code class="orbit-jf-token-code" id="orbit-jf-success-token"></code>
              <button type="button" class="orbit-jf-btn-white" id="orbit-jf-copy-token-btn">Copy</button>
            </div>
            <div class="orbit-jf-modal-footer">
              <button type="button" class="orbit-jf-btn-secondary" id="orbit-jf-success-status-btn">View Live Status</button>
              <button type="button" class="orbit-jf-btn-white" style="min-height:40px; padding:0 20px; font-size:0.9rem;" data-orbit-modal="close">Done</button>
            </div>
          </div>
        </div>
      </div>
    `;

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal();
        return;
      }
      const closeBtn = event.target.closest('[data-orbit-modal="close"]');
      if (closeBtn) {
        event.preventDefault();
        closeModal();
        return;
      }
      const tabBtn = event.target.closest('[data-orbit-tab]');
      if (tabBtn) {
        event.preventDefault();
        switchModalTab(tabBtn.getAttribute('data-orbit-tab'));
      }
    });

    modal.querySelector('#orbit-jf-signup-form').addEventListener('submit', handleSignupSubmit);

    modal.querySelector('#orbit-jf-status-lookup-btn').addEventListener('click', () => {
      const tokenInput = modal.querySelector('#orbitJfStatusTokenInput');
      const token = (tokenInput?.value || '').trim();
      if (!token) {
        renderModalStatusMessage('Please enter a request status token.', 'error');
        return;
      }
      setStored(STATUS_TOKEN_KEY, token);
      querySignupStatus(token);
    });

    modal.querySelector('#orbit-jf-copy-token-btn').addEventListener('click', async () => {
      const tokenEl = modal.querySelector('#orbit-jf-success-token');
      const copyBtn = modal.querySelector('#orbit-jf-copy-token-btn');
      const token = tokenEl?.textContent?.trim() || '';
      if (!token) return;
      try {
        await navigator.clipboard.writeText(token);
        if (copyBtn) copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          if (copyBtn) copyBtn.textContent = 'Copy';
        }, 1600);
      } catch {}
    });

    modal.querySelector('#orbit-jf-success-status-btn').addEventListener('click', () => {
      switchModalTab('status');
    });

    modal.querySelector('#orbitJfAccessJellyfin').addEventListener('change', (e) => {
      const libsField = modal.querySelector('#orbit-jf-libraries-field');
      if (libsField) {
        libsField.style.opacity = e.target.checked ? '1' : '0.45';
      }
    });

    document.body.appendChild(modal);
    return modal;
  }

  function switchModalTab(tab) {
    activeModalTab = tab;
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    const titleEl = modal.querySelector('#orbitJfModalTitle');
    const signupPanel = modal.querySelector('#orbit-jf-panel-signup');
    const statusPanel = modal.querySelector('#orbit-jf-panel-status');
    const successPanel = modal.querySelector('#orbit-jf-panel-success');

    modal.querySelectorAll('.orbit-jf-tab-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-orbit-tab') === tab);
    });

    signupPanel.style.display = tab === 'signup' ? 'block' : 'none';
    statusPanel.style.display = tab === 'status' ? 'block' : 'none';
    successPanel.style.display = tab === 'success' ? 'block' : 'none';

    if (titleEl) {
      if (tab === 'status') titleEl.textContent = 'Check Request Status';
      else if (tab === 'success') titleEl.textContent = 'Access Request Submitted';
      else titleEl.textContent = 'Request Alpha Orbit Access';
    }

    if (tab === 'status') {
      const tokenInput = modal.querySelector('#orbitJfStatusTokenInput');
      const saved = getStored(STATUS_TOKEN_KEY) || '';
      if (tokenInput && !tokenInput.value && saved) {
        tokenInput.value = saved;
      }
      if (saved && (saved !== lastCheckedToken || !latestStatusState)) {
        querySignupStatus(saved);
      } else {
        renderModalStatusResult();
      }
    }
  }

  function renderLibraryOptions(result) {
    const container = document.getElementById('orbit-jf-libraries-list');
    if (!container) return;

    const { libraries } = result || { libraries: FALLBACK_LIBRARIES };
    container.innerHTML = libraries
      .map((lib) => {
        const checkedAttr = lib.defaultSelected !== false ? 'checked' : '';
        return `
          <label class="orbit-jf-check-pill">
            <input type="checkbox" name="libraries" value="${escapeHtml(lib.id)}" ${checkedAttr}>
            <span>${escapeHtml(lib.name)}</span>
          </label>
        `;
      })
      .join('');
  }

  function showFormError(message) {
    const errEl = document.getElementById('orbit-jf-form-error');
    if (!errEl) return;
    if (!message) {
      errEl.style.display = 'none';
      errEl.textContent = '';
      return;
    }
    errEl.textContent = message;
    errEl.style.display = 'block';
  }

  function renderModalStatusMessage(msg, type = 'info') {
    const box = document.getElementById('orbit-jf-modal-status-result');
    if (!box) return;
    box.innerHTML = `<div class="orbit-jf-alert ${type === 'error' ? 'is-error' : 'is-info'}">${escapeHtml(msg)}</div>`;
  }

  function renderModalStatusResult() {
    const box = document.getElementById('orbit-jf-modal-status-result');
    if (!box) return;

    if (isCheckingStatus) {
      renderModalStatusMessage('Checking request status with Alpha Orbit...', 'info');
      return;
    }

    const st = latestStatusState;
    if (!st) {
      const saved = getStored(STATUS_TOKEN_KEY);
      if (!saved) {
        renderModalStatusMessage('Enter your status token above to check pending, approved, or declined status.', 'info');
      }
      return;
    }

    if (st.status === 'not_found' || st.status === 'error') {
      renderModalStatusMessage(st.note || 'Could not find a request matching that token.', 'error');
      return;
    }

    let pillClass = 'is-pending';
    let label = 'Pending Admin Review';
    if (st.status === 'approved') {
      pillClass = 'is-approved';
      label = 'Approved — You can sign in above!';
    } else if (st.status === 'declined') {
      pillClass = 'is-declined';
      label = 'Declined';
    }

    const usernameRow = st.username ? `<div class="orbit-jf-status-note">Username: <strong>${escapeHtml(st.username)}</strong></div>` : '';
    const noteRow = st.note ? `<div class="orbit-jf-status-note">Note: ${escapeHtml(st.note)}</div>` : '';
    const prefillBtn =
      st.status === 'approved' && st.username
        ? `<div class="orbit-jf-status-actions"><button type="button" class="orbit-jf-btn-white" id="orbit-jf-modal-prefill-btn">Prefill Username &amp; Sign In</button></div>`
        : '';

    box.innerHTML = `
      <div class="orbit-jf-status-pill ${pillClass}">
        <div class="orbit-jf-status-main">
          <span class="orbit-jf-status-dot"></span>
          <div class="orbit-jf-status-text">
            <strong>${escapeHtml(label)}</strong>
            ${usernameRow}
            ${noteRow}
          </div>
        </div>
        ${prefillBtn}
      </div>
    `;

    const prefillEl = box.querySelector('#orbit-jf-modal-prefill-btn');
    if (prefillEl) {
      prefillEl.addEventListener('click', () => {
        prefillJellyfinLogin(st.username);
        closeModal();
      });
    }
  }

  async function openModal(initialTab = 'signup') {
    const modal = ensureModalExists();
    showFormError('');
    modal.classList.add('is-open');
    switchModalTab(initialTab);

    if (initialTab === 'signup') {
      const optionsResult = await loadSignupOptions();
      renderLibraryOptions(optionsResult);
      const firstInput = modal.querySelector('#orbitJfFullName');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 40);
      }
    }
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.remove('is-open');
  }

  // --- FORM VALIDATION & SUBMISSION ---
  async function handleSignupSubmit(event) {
    event.preventDefault();
    if (isSubmittingSignup) return;

    const form = event.currentTarget;
    const fullName = (form.fullName?.value || '').trim();
    const username = (form.username?.value || '').trim();
    const email = (form.email?.value || '').trim();
    const password = form.password?.value || '';
    const confirmPassword = form.confirmPassword?.value || '';
    const jellyfin = Boolean(form.accessJellyfin?.checked);
    const seerr = Boolean(form.accessSeerr?.checked);
    const deviceNote = (form.deviceNote?.value || '').trim();
    const libraries = Array.from(form.querySelectorAll('input[name="libraries"]:checked')).map((el) => el.value);

    if (!fullName) {
      showFormError('Please enter your full name.');
      return;
    }
    if (!USERNAME_PATTERN.test(username)) {
      showFormError('Username must be 3–32 characters and contain only letters, numbers, dots (.), underscores (_), or hyphens (-).');
      return;
    }
    if (!EMAIL_PATTERN.test(email)) {
      showFormError('Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      showFormError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      showFormError('Passwords do not match. Please re-enter them.');
      return;
    }
    if (!jellyfin && !seerr) {
      showFormError('Please select at least one requested access option (Jellyfin or Seerr).');
      return;
    }

    showFormError('');
    isSubmittingSignup = true;
    const submitBtn = document.getElementById('orbit-jf-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting Request...';
    }

    const payload = {
      fullName,
      username,
      email,
      password,
      requestedAccess: {
        jellyfin,
        seerr,
        libraries,
        deviceNote
      }
    };

    const endpoint = `${getDashboardBaseUrl()}/api/auth/signup-request`;
    try {
      const { response, data } = await fetchJsonWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 201 || response.ok) {
        const statusToken = String(
          data?.statusToken || data?.token || data?.request?.statusToken || data?.data?.statusToken || ''
        ).trim();

        setStored(USERNAME_STORAGE_KEY, username);
        if (statusToken) {
          setStored(STATUS_TOKEN_KEY, statusToken);
          latestStatusState = {
            status: 'pending',
            token: statusToken,
            username,
            note: 'Submitted and awaiting administrator review.'
          };
          lastCheckedToken = '';
        }

        renderBannerStatus();

        const tokenDisplay = document.getElementById('orbit-jf-success-token');
        if (tokenDisplay) {
          tokenDisplay.textContent = statusToken || 'Saved — check dashboard status';
        }
        const statusTokenInput = document.getElementById('orbitJfStatusTokenInput');
        if (statusTokenInput && statusToken) {
          statusTokenInput.value = statusToken;
        }
        form.reset();
        switchModalTab('success');
        return;
      }

      const serverMsg = data?.error || data?.message || data?.detail || '';
      if (response.status === 400) {
        showFormError(serverMsg || 'Please check your form details and try again.');
      } else if (response.status === 409) {
        showFormError(serverMsg || 'An account or pending request with that username or email already exists.');
      } else if (response.status === 429) {
        showFormError(serverMsg || 'Too many signup requests from this device. Please wait a bit before trying again.');
      } else {
        showFormError(serverMsg || `Request failed with HTTP ${response.status}. Please try again.`);
      }
    } catch {
      showFormError(`Unable to reach Alpha Orbit authentication service (${getDashboardBaseUrl()}). Verify your connection or VPN and retry.`);
    } finally {
      isSubmittingSignup = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Access Request';
      }
    }
  }

  // --- LIFECYCLE & OBSERVER ORCHESTRATION ---
  function attachLoginPageObserver(loginPage) {
    if (!loginPage || observedLoginPage === loginPage) return;
    if (loginPageObserver) {
      loginPageObserver.disconnect();
    }
    observedLoginPage = loginPage;
    loginPageObserver = new MutationObserver(() => scheduleReconcile());
    loginPageObserver.observe(loginPage, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  function reconcile() {
    injectStyles();
    const ctx = getLoginContext();
    if (ctx.loginPage) {
      attachLoginPageObserver(ctx.loginPage);
    }

    if (!ctx.active) {
      cleanupSignupBox();
      return;
    }

    injectSignupBox(ctx.manualForm);
  }

  function scheduleReconcile() {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, 100);
  }

  function registerListeners() {
    window.addEventListener('hashchange', scheduleReconcile);
    window.addEventListener('popstate', scheduleReconcile);
    document.addEventListener('viewshow', scheduleReconcile, { capture: true });
    document.addEventListener('pageshow', scheduleReconcile, { capture: true });
    document.addEventListener('viewhide', scheduleReconcile, { capture: true });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const modal = document.getElementById(MODAL_ID);
        if (modal && modal.classList.contains('is-open')) {
          closeModal();
        }
      }
    });

    const rootTarget = document.body || document.documentElement;
    const domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          scheduleReconcile();
          break;
        }
      }
    });
    domObserver.observe(rootTarget, { childList: true, subtree: true });
  }

  function init() {
    injectStyles();
    registerListeners();
    reconcile();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.OrbitJellyfinSignup = {
    getDashboardBaseUrl,
    openModal,
    closeModal,
    refreshStatus: () => querySignupStatus(getStored(STATUS_TOKEN_KEY))
  };
})();
