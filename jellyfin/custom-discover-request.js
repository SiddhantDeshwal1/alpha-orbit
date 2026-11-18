/**
 * Jellyfin Discovery & Request UI Extension Module
 * Architectural Component: In-Jellyfin Discovery & Request Overlay for Random Movies
 *
 * Capabilities:
 *  1. Navigation Interceptor & Button Injections:
 *     - "🎲 Surprise Me" button injected into Jellyfin's header (.skinHeader / .headerRight) near Search.
 *     - "✨ Discover & Request" entry injected into the sidebar navigation drawer (.mainDrawer-scrollContainer).
 *     - Search page recommendation card ("Can't find what you're looking for? Surprise Me").
 *  2. Discovery Modal Component (#jellyfinDiscoverModal):
 *     - Matte #141414 backdrop with 16px frosted glass blur and fluid spring animation.
 *     - 16:9 high-resolution backdrop poster with multi-stop dark vignette.
 *     - Movie Title (SF Pro Rounded bold), Release Year, Runtime, Genres, Rating pill badge (⭐ 7.8/10).
 *     - Full synopsis, Director, and Cast overview.
 *  3. Interactive Controls:
 *     - [ 🎲 Roll Another ]: Smooth crossfade to another high-rated random candidate.
 *     - [ ▶ Watch Trailer ]: Embeds clean YouTube player inside 16:9 preview container.
 *     - [ 📥 Request to Watch ]: Prominent Netflix Red button dispatching request to Seerr via
 *       Jellyfin Enhanced proxy endpoint (with fallback cascade to direct Seerr API).
 *     - Close button ✕ and Esc key listener.
 *  4. Multi-Tier High-Rated Movie Resolver:
 *     - Random page generator across Seerr / JellyfinEnhanced proxy discover/movies.
 *     - Filters strictly for voteAverage >= 7.0 and voteCount >= 100.
 *     - Multi-tier fallback cascade: JellyfinEnhanced discover -> JellyfinEnhanced trending -> Direct Seerr -> Direct TMDB.
 *     - TMDB video & credits enrichment for runtime, director, cast, and trailers.
 *  5. Toast Notifications:
 *     - Glassmorphism animated notification system for status and download confirmations.
 */

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.__JELLYFIN_DISCOVER_REQUEST_INITIALIZED__) {
    console.log('[DiscoverRequest] Module already initialized, skipping duplicate execution.');
    return;
  }
  window.__JELLYFIN_DISCOVER_REQUEST_INITIALIZED__ = true;

  // --- CONFIGURATION CONSTANTS ---
  const TMDB_PUBLIC_API_KEY = 'f090bb54758cabf231fb605d3e3e0468';
  const SEERR_INTERNAL_PROXY = '/JellyfinEnhanced/jellyseerr';
  const SEERR_DIRECT_API = 'http://127.0.0.1:5055/api/v1';
  const SEERR_API_KEY = '';
  const MIN_VOTE_AVERAGE = 7.0;
  const MIN_VOTE_COUNT = 100;
  const MAX_RANDOM_PAGE = 30;

  const MODAL_ID = 'jellyfinDiscoverModal';
  const TOAST_ID = 'jellyfinDiscoverToast';
  const STYLES_ID = 'jellyfinDiscoverStyles';
  const HEADER_BTN_ID = 'jellyfinDiscoverHeaderBtn';
  const DRAWER_BTN_ID = 'jellyfinDiscoverDrawerBtn';
  const SEARCH_CARD_ID = 'jellyfinDiscoverSearchCard';

  // TMDB Genre Map Fallback
  const GENRE_MAP = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
    99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
    27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
    10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
  };

  // --- STATE MANAGEMENT ---
  const state = {
    isOpen: false,
    isLoading: false,
    isTrailerOpen: false,
    candidatePool: [],
    seenMovieIds: new Set(),
    currentCandidate: null,
    inFlightFetch: null,
    requestedMovieIds: new Set()
  };

  // --- SVG ICONS ---
  const ICONS = {
    dice: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" ry="4"></rect><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"></circle><circle cx="15.5" cy="8.5" r="1.5" fill="currentColor"></circle><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"></circle><circle cx="8.5" cy="15.5" r="1.5" fill="currentColor"></circle><circle cx="12" cy="12" r="1.5" fill="currentColor"></circle></svg>`,
    sparkles: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path></svg>`,
    play: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`,
    download: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
    check: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    refresh: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>`,
    star: `<svg viewBox="0 0 24 24" width="15" height="15" fill="#F5C518" stroke="#F5C518" stroke-width="1" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
  };

  // --- STYLES INJECTION ---
  function injectStyles() {
    if (document.getElementById(STYLES_ID)) return;

    const css = `
      /* Font Definition & Variables */
      :root {
        --jdr-font: -apple-system, BlinkMacSystemFont, "SF Pro Rounded", "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        --jdr-bg: #141416;
        --jdr-card-bg: rgba(22, 22, 26, 0.94);
        --jdr-netflix-red: #E50914;
        --jdr-netflix-hover: #F40612;
        --jdr-gold: #F5C518;
      }

      /* Header "Surprise Me" Button */
      #${HEADER_BTN_ID} {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 38px;
        padding: 0 14px;
        margin: 0 6px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 9999px;
        color: #FFFFFF;
        font-family: var(--jdr-font);
        font-size: 13.5px;
        font-weight: 600;
        letter-spacing: 0.2px;
        cursor: pointer;
        outline: none;
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        vertical-align: middle;
        user-select: none;
        z-index: 10;
      }
      #${HEADER_BTN_ID}:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: rgba(255, 255, 255, 0.35);
        transform: scale(1.04);
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35), 0 0 12px rgba(255, 255, 255, 0.15);
      }
      #${HEADER_BTN_ID}:active {
        transform: scale(0.97);
      }
      #${HEADER_BTN_ID} svg {
        transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #${HEADER_BTN_ID}:hover svg {
        transform: rotate(45deg);
      }

      /* Drawer "Discover & Request" Item */
      #${DRAWER_BTN_ID} {
        display: flex;
        align-items: center;
        gap: 16px;
        width: calc(100% - 24px);
        margin: 6px 12px;
        padding: 12px 18px;
        border-radius: 12px;
        background: linear-gradient(90deg, rgba(229, 9, 20, 0.12) 0%, rgba(255, 255, 255, 0.03) 100%);
        border: 1px solid rgba(229, 9, 20, 0.3);
        color: #FFFFFF;
        font-family: var(--jdr-font);
        font-size: 15px;
        font-weight: 600;
        text-align: left;
        cursor: pointer;
        outline: none;
        text-decoration: none;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        box-sizing: border-box;
      }
      #${DRAWER_BTN_ID}:hover {
        background: linear-gradient(90deg, rgba(229, 9, 20, 0.22) 0%, rgba(255, 255, 255, 0.08) 100%);
        border-color: rgba(229, 9, 20, 0.6);
        transform: translateX(4px);
      }
      #${DRAWER_BTN_ID} .jdr-drawer-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: rgba(229, 9, 20, 0.2);
        color: var(--jdr-netflix-red);
      }

      /* Search Page Recommendation Card */
      #${SEARCH_CARD_ID} {
        position: relative;
        margin: 20px auto 30px auto;
        max-width: 900px;
        width: calc(100% - 32px);
        padding: 20px 24px;
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(30, 30, 38, 0.85) 0%, rgba(18, 18, 22, 0.95) 100%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        box-sizing: border-box;
        z-index: 5;
      }
      .jdr-search-content {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .jdr-search-tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-family: var(--jdr-font);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--jdr-netflix-red);
      }
      .jdr-search-title {
        font-family: var(--jdr-font);
        font-size: 18px;
        font-weight: 700;
        color: #FFFFFF;
        margin: 0;
      }
      .jdr-search-subtitle {
        font-family: var(--jdr-font);
        font-size: 13.5px;
        color: rgba(255, 255, 255, 0.65);
        margin: 0;
      }
      .jdr-search-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding: 0 20px;
        background: var(--jdr-netflix-red);
        border: none;
        border-radius: 10px;
        color: #FFFFFF;
        font-family: var(--jdr-font);
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        flex-shrink: 0;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: 0 4px 16px rgba(229, 9, 20, 0.4);
      }
      .jdr-search-btn:hover {
        background: var(--jdr-netflix-hover);
        transform: translateY(-2px);
        box-shadow: 0 6px 22px rgba(229, 9, 20, 0.6);
      }

      /* Discovery Modal Overlay */
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(10, 10, 12, 0.82);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1);
        padding: 16px;
        box-sizing: border-box;
      }
      #${MODAL_ID}.jdr-active {
        opacity: 1;
        pointer-events: auto;
      }

      /* Modal Dialog Window */
      .jdr-modal-card {
        position: relative;
        width: min(880px, 95vw);
        max-height: min(92vh, 860px);
        background: var(--jdr-card-bg);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        box-shadow: 0 32px 80px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.06);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transform: scale(0.95) translateY(14px);
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        box-sizing: border-box;
      }
      #${MODAL_ID}.jdr-active .jdr-modal-card {
        transform: scale(1) translateY(0);
      }

      /* Modal Close Button */
      .jdr-close-btn {
        position: absolute;
        top: 16px;
        right: 16px;
        z-index: 20;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #FFFFFF;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        transition: all 0.2s ease;
      }
      .jdr-close-btn:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.4);
        transform: rotate(90deg);
      }

      /* 16:9 Media Preview Area */
      .jdr-media-container {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        max-height: 400px;
        background: #0D0D10;
        overflow: hidden;
        flex-shrink: 0;
      }
      .jdr-backdrop-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center 25%;
        display: block;
        transition: opacity 0.35s ease, transform 0.8s ease;
      }
      .jdr-media-vignette {
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(20,20,24,0.1) 40%, rgba(22,22,26,0.85) 85%, var(--jdr-card-bg) 100%);
        pointer-events: none;
      }

      /* Trailer Container */
      .jdr-trailer-wrapper {
        position: absolute;
        inset: 0;
        z-index: 10;
        background: #000000;
        display: none;
      }
      .jdr-trailer-wrapper.jdr-active {
        display: block;
      }
      .jdr-trailer-iframe {
        width: 100%;
        height: 100%;
        border: none;
      }

      /* Rating Pill Badge */
      .jdr-rating-badge {
        position: absolute;
        bottom: 16px;
        left: 24px;
        z-index: 12;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        border-radius: 9999px;
        background: rgba(0, 0, 0, 0.65);
        border: 1px solid rgba(245, 197, 24, 0.45);
        color: var(--jdr-gold);
        font-family: var(--jdr-font);
        font-size: 13.5px;
        font-weight: 700;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }

      /* Modal Body Details */
      .jdr-details-body {
        padding: 20px 28px 24px 28px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 16px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
      }
      .jdr-details-header {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .jdr-title {
        font-family: var(--jdr-font);
        font-size: 28px;
        font-weight: 800;
        color: #FFFFFF;
        line-height: 1.2;
        margin: 0;
        letter-spacing: -0.4px;
      }
      .jdr-meta-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        font-family: var(--jdr-font);
        font-size: 13.5px;
        color: rgba(255, 255, 255, 0.7);
      }
      .jdr-meta-item {
        display: inline-flex;
        align-items: center;
      }
      .jdr-meta-bullet {
        margin: 0 2px;
        color: rgba(255, 255, 255, 0.35);
      }
      .jdr-genres-container {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 2px;
      }
      .jdr-genre-pill {
        display: inline-flex;
        align-items: center;
        padding: 3px 10px;
        border-radius: 9999px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: rgba(255, 255, 255, 0.85);
        font-family: var(--jdr-font);
        font-size: 12px;
        font-weight: 500;
      }

      /* Synopsis */
      .jdr-synopsis {
        font-family: var(--jdr-font);
        font-size: 14.5px;
        line-height: 1.6;
        color: rgba(255, 255, 255, 0.85);
        margin: 0;
        max-height: 96px;
        overflow-y: auto;
      }

      /* Credits (Director & Cast) */
      .jdr-credits-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        column-gap: 12px;
        row-gap: 6px;
        font-family: var(--jdr-font);
        font-size: 13px;
        line-height: 1.45;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        padding-top: 12px;
      }
      .jdr-credits-label {
        font-weight: 600;
        color: rgba(255, 255, 255, 0.45);
      }
      .jdr-credits-val {
        color: rgba(255, 255, 255, 0.9);
      }

      /* Action Controls Bar */
      .jdr-actions-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      .jdr-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        height: 44px;
        padding: 0 20px;
        border-radius: 10px;
        font-family: var(--jdr-font);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        outline: none;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
        box-sizing: border-box;
      }
      .jdr-btn-primary {
        background: var(--jdr-netflix-red);
        border: none;
        color: #FFFFFF;
        box-shadow: 0 4px 18px rgba(229, 9, 20, 0.45);
      }
      .jdr-btn-primary:hover:not(:disabled) {
        background: var(--jdr-netflix-hover);
        transform: translateY(-2px);
        box-shadow: 0 6px 24px rgba(229, 9, 20, 0.65);
      }
      .jdr-btn-primary:disabled {
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.45);
        box-shadow: none;
        cursor: not-allowed;
      }
      .jdr-btn-primary.jdr-requested {
        background: rgba(46, 125, 50, 0.25);
        border: 1px solid rgba(76, 175, 80, 0.5);
        color: #81C784;
      }
      .jdr-btn-secondary {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #FFFFFF;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }
      .jdr-btn-secondary:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.16);
        border-color: rgba(255, 255, 255, 0.35);
        transform: translateY(-2px);
      }
      .jdr-btn-secondary:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Toast Notification */
      #${TOAST_ID} {
        position: fixed;
        bottom: 28px;
        right: 28px;
        z-index: 1000000;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: 440px;
        padding: 14px 20px;
        border-radius: 14px;
        background: rgba(24, 24, 28, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #FFFFFF;
        font-family: var(--jdr-font);
        font-size: 13.5px;
        line-height: 1.45;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        transform: translateY(30px) scale(0.95);
        opacity: 0;
        pointer-events: none;
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #${TOAST_ID}.jdr-toast-active {
        transform: translateY(0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }
      .jdr-toast-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgba(76, 175, 80, 0.2);
        color: #81C784;
      }

      /* Mobile Responsive Tweaks */
      @media (max-width: 768px) {
        #${HEADER_BTN_ID} span {
          display: none;
        }
        #${HEADER_BTN_ID} {
          padding: 0 10px;
        }
        .jdr-title {
          font-size: 22px;
        }
        .jdr-details-body {
          padding: 16px;
        }
        .jdr-actions-bar {
          flex-direction: column;
        }
        .jdr-actions-bar .jdr-btn {
          width: 100%;
        }
      }
    `;

    const styleEl = document.createElement('style');
    styleEl.id = STYLES_ID;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  // --- JELLYFIN AUTH RESOLUTION ---
  function getJellyfinAuth() {
    let serverAddress = '';
    let token = '';
    let userId = '';

    // 1. ApiClient (Global Jellyfin Web API Client)
    if (window.ApiClient) {
      try {
        if (typeof window.ApiClient.serverAddress === 'function') {
          serverAddress = window.ApiClient.serverAddress();
        }
        if (typeof window.ApiClient.accessToken === 'function') {
          token = window.ApiClient.accessToken();
        }
        if (!token && window.ApiClient._serverInfo && window.ApiClient._serverInfo.AccessToken) {
          token = window.ApiClient._serverInfo.AccessToken;
        }
        if (typeof window.ApiClient.getCurrentUserId === 'function') {
          userId = window.ApiClient.getCurrentUserId();
        }
      } catch (err) {
        console.warn('[DiscoverRequest] Error reading window.ApiClient:', err);
      }
    }

    // 2. LocalStorage Fallback
    if (!token || !userId) {
      try {
        const credsStr = localStorage.getItem('jellyfin_credentials');
        if (credsStr) {
          const creds = JSON.parse(credsStr);
          if (creds && creds.Servers && creds.Servers.length > 0) {
            const s = creds.Servers[0];
            if (!serverAddress) serverAddress = s.ManualAddress || s.Address || '';
            if (!token) token = s.AccessToken || '';
            if (!userId) userId = s.UserId || '';
          }
        }
      } catch {}
    }

    if (!token) {
      try { token = localStorage.getItem('token') || ''; } catch {}
    }
    if (!userId) {
      try { userId = localStorage.getItem('userId') || ''; } catch {}
    }

    // 3. Fallback to Window Origin
    if (!serverAddress) {
      serverAddress = window.location.origin;
    }
    serverAddress = serverAddress.replace(/\/+$/, '');

    return { serverAddress, token, userId };
  }

  function getAuthHeaders(token) {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['X-Emby-Token'] = token;
      if (window.ApiClient && typeof window.ApiClient.appName === 'function') {
        try {
          headers['Authorization'] = `MediaBrowser Client="${window.ApiClient.appName()}", Device="${window.ApiClient.deviceName()}", DeviceId="${window.ApiClient.deviceId()}", Version="${window.ApiClient.appVersion()}", Token="${token}"`;
        } catch {}
      } else {
        headers['Authorization'] = `MediaBrowser Client="Jellyfin Web", Device="Browser", DeviceId="discover-request", Version="12.2.0", Token="${token}"`;
      }
    }
    return headers;
  }

  // --- TOAST NOTIFICATIONS ---
  let toastTimer = null;
  function showToast(message, iconSvg = ICONS.check) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }

    toast.innerHTML = `
      <div class="jdr-toast-icon">${iconSvg}</div>
      <div class="jdr-toast-msg">${message}</div>
    `;

    toast.classList.add('jdr-toast-active');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('jdr-toast-active');
    }, 4500);

    // Also trigger native Jellyfin/JE toast if available
    if (window.JE && typeof window.JE.toast === 'function') {
      try { window.JE.toast(message, 4500); } catch {}
    }
  }

  // --- DISCOVERY API RESOLVER (4-Tier Cascade) ---
  async function fetchDiscoverCandidates(randomPage = 1) {
    const { serverAddress, token } = getJellyfinAuth();
    const headers = getAuthHeaders(token);

    // Tier 1: Jellyfin Enhanced Seerr Discover Proxy Endpoint
    try {
      const url = `${serverAddress}${SEERR_INTERNAL_PROXY}/discover/movies?page=${randomPage}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(4500) });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.results) && data.results.length > 0) {
          return filterCandidates(data.results);
        }
      }
    } catch (e) {
      console.debug('[DiscoverRequest] Tier 1 JellyfinEnhanced proxy failed, falling back:', e.message);
    }

    // Tier 2: Jellyfin Enhanced Seerr Trending Proxy Endpoint
    try {
      const url = `${serverAddress}${SEERR_INTERNAL_PROXY}/discover/trending?page=${randomPage}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(4500) });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.results) && data.results.length > 0) {
          return filterCandidates(data.results);
        }
      }
    } catch (e) {
      console.debug('[DiscoverRequest] Tier 2 Trending proxy failed, falling back:', e.message);
    }

    // Tier 3: Direct Seerr Endpoint (Localhost / Tailscale loopback)
    try {
      const url = `${SEERR_DIRECT_API}/discover/movies?page=${randomPage}`;
      const res = await fetch(url, {
        headers: {
          'X-Api-Key': SEERR_API_KEY,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.results) && data.results.length > 0) {
          return filterCandidates(data.results);
        }
      }
    } catch (e) {
      console.debug('[DiscoverRequest] Tier 3 Direct Seerr failed, falling back to TMDB:', e.message);
    }

    // Tier 4: Public TMDB Discover API
    try {
      const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_PUBLIC_API_KEY}&sort_by=vote_average.desc&vote_count.gte=${MIN_VOTE_COUNT}&vote_average.gte=${MIN_VOTE_AVERAGE}&page=${randomPage}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.results) && data.results.length > 0) {
          return filterCandidates(data.results);
        }
      }
    } catch (e) {
      console.error('[DiscoverRequest] All discovery tiers failed:', e);
    }

    return [];
  }

  function filterCandidates(movies) {
    return movies.filter(m => {
      const voteAvg = m.voteAverage || m.vote_average || 0;
      const voteCnt = m.voteCount || m.vote_count || 0;
      const hasBackdrop = Boolean(m.backdropPath || m.backdrop_path);
      const hasTitle = Boolean(m.title || m.name);
      return voteAvg >= MIN_VOTE_AVERAGE && voteCnt >= MIN_VOTE_COUNT && hasBackdrop && hasTitle;
    }).map(m => ({
      id: m.id,
      title: m.title || m.name || 'Unknown Title',
      overview: m.overview || 'No synopsis available.',
      releaseDate: m.releaseDate || m.release_date || '',
      voteAverage: m.voteAverage || m.vote_average || 0,
      voteCount: m.voteCount || m.vote_count || 0,
      backdropPath: m.backdropPath || m.backdrop_path,
      posterPath: m.posterPath || m.poster_path,
      genreIds: m.genreIds || m.genre_ids || [],
      mediaInfo: m.mediaInfo || null
    }));
  }

  // Enrich movie details with TMDB (Director, Cast, Runtime, YouTube Trailer)
  async function enrichMovieDetails(movie) {
    if (movie._enriched) return movie;

    try {
      const url = `https://api.themoviedb.org/3/movie/${movie.id}?api_key=${TMDB_PUBLIC_API_KEY}&append_to_response=credits,videos`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
      if (res.ok) {
        const details = await res.json();

        // Runtime
        if (details.runtime) {
          const hrs = Math.floor(details.runtime / 60);
          const mins = details.runtime % 60;
          movie.runtime = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        }

        // Genres
        if (Array.isArray(details.genres) && details.genres.length > 0) {
          movie.genres = details.genres.map(g => g.name);
        }

        // Director & Cast
        if (details.credits) {
          if (Array.isArray(details.credits.crew)) {
            const dir = details.credits.crew.find(c => c.job === 'Director');
            if (dir) movie.director = dir.name;
          }
          if (Array.isArray(details.credits.cast)) {
            movie.cast = details.credits.cast.slice(0, 4).map(c => c.name).join(', ');
          }
        }

        // Trailer Key
        if (details.videos && Array.isArray(details.videos.results)) {
          const trailer = details.videos.results.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                          details.videos.results.find(v => v.site === 'YouTube');
          if (trailer) movie.trailerKey = trailer.key;
        }

        movie._enriched = true;
      }
    } catch (err) {
      console.debug('[DiscoverRequest] Could not enrich movie details from TMDB:', err.message);
    }

    // Fallbacks if TMDB details missed
    if (!movie.genres || movie.genres.length === 0) {
      movie.genres = (movie.genreIds || []).map(id => GENRE_MAP[id]).filter(Boolean);
      if (movie.genres.length === 0) movie.genres = ['Feature Film'];
    }
    if (!movie.runtime) movie.runtime = 'Standard Feature';
    if (!movie.director) movie.director = 'Not Listed';
    if (!movie.cast) movie.cast = 'Ensemble Cast';

    return movie;
  }

  // --- SEERR REQUEST DISPATCHER ---
  async function dispatchSeerrRequest(tmdbId) {
    const { serverAddress, token } = getJellyfinAuth();
    const headers = getAuthHeaders(token);
    const body = JSON.stringify({ mediaId: tmdbId, mediaType: 'movie' });

    // Tier 1: Dispatch through Jellyfin Enhanced Proxy
    try {
      const url = `${serverAddress}${SEERR_INTERNAL_PROXY}/request`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        return { success: true, via: 'proxy' };
      }
      const errData = await res.json().catch(() => null);
      if (errData && errData.message && errData.message.includes('already exists')) {
        return { success: true, alreadyExists: true, via: 'proxy' };
      }
    } catch (err) {
      console.warn('[DiscoverRequest] Proxy request failed, attempting direct Seerr:', err);
    }

    // Tier 2: Dispatch directly to Seerr API
    try {
      const url = `${SEERR_DIRECT_API}/request`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': SEERR_API_KEY
        },
        body,
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        return { success: true, via: 'direct' };
      }
      const errData = await res.json().catch(() => null);
      if (errData && errData.message && errData.message.includes('already exists')) {
        return { success: true, alreadyExists: true, via: 'direct' };
      }
    } catch (err) {
      console.error('[DiscoverRequest] Direct Seerr request failed:', err);
    }

    return { success: false };
  }

  // --- MODAL COMPONENT DOM & LOGIC ---
  function createModalDOM() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'jdrModalTitle');

    modal.innerHTML = `
      <div class="jdr-modal-card">
        <button class="jdr-close-btn" id="jdrCloseBtn" title="Close (Esc)">${ICONS.close}</button>

        <!-- 16:9 Media Preview -->
        <div class="jdr-media-container" id="jdrMediaWrapper">
          <img class="jdr-backdrop-img" id="jdrBackdropImg" alt="Movie Backdrop" src="" />
          <div class="jdr-media-vignette"></div>

          <!-- YouTube Trailer Container -->
          <div class="jdr-trailer-wrapper" id="jdrTrailerWrapper">
            <iframe class="jdr-trailer-iframe" id="jdrTrailerIframe" allow="autoplay; encrypted-media" allowfullscreen></iframe>
          </div>

          <!-- Rating Pill Badge -->
          <div class="jdr-rating-badge" id="jdrRatingBadge">
            ${ICONS.star} <span id="jdrRatingVal">8.5</span> <span style="opacity: 0.6; font-size: 11px;">/ 10</span>
          </div>
        </div>

        <!-- Details Body -->
        <div class="jdr-details-body">
          <div class="jdr-details-header">
            <h2 class="jdr-title" id="jdrModalTitle">Loading discovery candidate...</h2>
            <div class="jdr-meta-row">
              <span class="jdr-meta-item" id="jdrYear">2024</span>
              <span class="jdr-meta-bullet">•</span>
              <span class="jdr-meta-item" id="jdrRuntime">2h 15m</span>
              <span class="jdr-meta-bullet">•</span>
              <span class="jdr-meta-item" id="jdrVoteCount" style="opacity: 0.6;">(12,400 votes)</span>
            </div>
            <div class="jdr-genres-container" id="jdrGenresContainer"></div>
          </div>

          <!-- Synopsis -->
          <p class="jdr-synopsis" id="jdrSynopsis">Fetching recommendation...</p>

          <!-- Director & Cast -->
          <div class="jdr-credits-grid">
            <span class="jdr-credits-label">Director:</span>
            <span class="jdr-credits-val" id="jdrDirector">—</span>
            <span class="jdr-credits-label">Cast:</span>
            <span class="jdr-credits-val" id="jdrCast">—</span>
          </div>

          <!-- Actions Bar -->
          <div class="jdr-actions-bar">
            <button class="jdr-btn jdr-btn-primary" id="jdrRequestBtn">
              ${ICONS.download} <span>Request to Watch</span>
            </button>
            <button class="jdr-btn jdr-btn-secondary" id="jdrTrailerBtn">
              ${ICONS.play} <span>Watch Trailer</span>
            </button>
            <button class="jdr-btn jdr-btn-secondary" id="jdrRollBtn">
              ${ICONS.dice} <span>Roll Another</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event Listeners
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDiscoverModal();
    });

    document.getElementById('jdrCloseBtn').addEventListener('click', closeDiscoverModal);
    document.getElementById('jdrRollBtn').addEventListener('click', () => rollNextCandidate());
    document.getElementById('jdrTrailerBtn').addEventListener('click', () => toggleTrailer());
    document.getElementById('jdrRequestBtn').addEventListener('click', () => handleRequest());

    // Esc Key Listener
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.isOpen) {
        closeDiscoverModal();
      }
    });

    return modal;
  }

  // Open & Close Modal
  async function openDiscoverModal() {
    createModalDOM();
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    state.isOpen = true;
    modal.classList.add('jdr-active');
    document.body.style.overflow = 'hidden';

    // If no candidate ready, fetch and roll
    if (!state.currentCandidate) {
      await rollNextCandidate();
    } else {
      renderCandidate(state.currentCandidate);
    }
  }

  function closeDiscoverModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    state.isOpen = false;
    modal.classList.remove('jdr-active');
    document.body.style.overflow = '';

    // Stop and unload running trailer
    unloadTrailer();
  }

  function unloadTrailer() {
    state.isTrailerOpen = false;
    const wrapper = document.getElementById('jdrTrailerWrapper');
    const iframe = document.getElementById('jdrTrailerIframe');
    const trailerBtn = document.getElementById('jdrTrailerBtn');
    if (wrapper) wrapper.classList.remove('jdr-active');
    if (iframe) iframe.src = 'about:blank';
    if (trailerBtn) {
      trailerBtn.innerHTML = `${ICONS.play} <span>Watch Trailer</span>`;
    }
  }

  function toggleTrailer() {
    if (!state.currentCandidate) return;

    if (state.isTrailerOpen) {
      unloadTrailer();
      return;
    }

    const wrapper = document.getElementById('jdrTrailerWrapper');
    const iframe = document.getElementById('jdrTrailerIframe');
    const trailerBtn = document.getElementById('jdrTrailerBtn');

    if (!state.currentCandidate.trailerKey) {
      showToast('No official trailer found for this title.', ICONS.close);
      return;
    }

    state.isTrailerOpen = true;
    iframe.src = `https://www.youtube-nocookie.com/embed/${state.currentCandidate.trailerKey}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1`;
    wrapper.classList.add('jdr-active');
    trailerBtn.innerHTML = `${ICONS.close} <span>Stop Trailer</span>`;
  }

  async function rollNextCandidate() {
    unloadTrailer();

    const rollBtn = document.getElementById('jdrRollBtn');
    if (rollBtn) {
      rollBtn.disabled = true;
      rollBtn.innerHTML = `${ICONS.refresh} <span>Rolling...</span>`;
    }

    // If pool is running low, replenish asynchronously
    if (state.candidatePool.length < 5 && !state.inFlightFetch) {
      replenishCandidatePool();
    }

    // Pop from candidate pool
    let nextCandidate = null;
    while (state.candidatePool.length > 0) {
      const candidate = state.candidatePool.shift();
      if (!state.seenMovieIds.has(candidate.id)) {
        state.seenMovieIds.add(candidate.id);
        nextCandidate = candidate;
        break;
      }
    }

    // If pool was empty, wait for replenishment
    if (!nextCandidate) {
      await replenishCandidatePool();
      if (state.candidatePool.length > 0) {
        nextCandidate = state.candidatePool.shift();
        if (nextCandidate) state.seenMovieIds.add(nextCandidate.id);
      }
    }

    if (nextCandidate) {
      // Enrich candidate with TMDB details
      state.currentCandidate = await enrichMovieDetails(nextCandidate);
      renderCandidate(state.currentCandidate);
    } else {
      showToast('No more new candidates available right now. Try rolling again!', ICONS.dice);
    }

    if (rollBtn) {
      rollBtn.disabled = false;
      rollBtn.innerHTML = `${ICONS.dice} <span>Roll Another</span>`;
    }
  }

  async function replenishCandidatePool() {
    if (state.inFlightFetch) return state.inFlightFetch;

    state.inFlightFetch = (async () => {
      try {
        const randomPage = Math.floor(Math.random() * MAX_RANDOM_PAGE) + 1;
        const candidates = await fetchDiscoverCandidates(randomPage);
        for (const c of candidates) {
          if (!state.seenMovieIds.has(c.id)) {
            state.candidatePool.push(c);
          }
        }
      } catch (err) {
        console.warn('[DiscoverRequest] Pool replenishment failed:', err);
      } finally {
        state.inFlightFetch = null;
      }
    })();

    return state.inFlightFetch;
  }

  function renderCandidate(movie) {
    if (!movie) return;

    // Backdrop Image
    const backdropImg = document.getElementById('jdrBackdropImg');
    if (backdropImg) {
      backdropImg.style.opacity = '0';
      const imgUrl = `https://image.tmdb.org/t/p/w1280${movie.backdropPath}`;
      backdropImg.src = imgUrl;
      backdropImg.onload = () => { backdropImg.style.opacity = '1'; };
    }

    // Title & Rating
    const titleEl = document.getElementById('jdrModalTitle');
    const ratingValEl = document.getElementById('jdrRatingVal');
    if (titleEl) titleEl.textContent = movie.title;
    if (ratingValEl) ratingValEl.textContent = Number(movie.voteAverage).toFixed(1);

    // Meta: Year, Runtime, Vote Count
    const yearEl = document.getElementById('jdrYear');
    const runtimeEl = document.getElementById('jdrRuntime');
    const voteCountEl = document.getElementById('jdrVoteCount');
    if (yearEl) yearEl.textContent = movie.releaseDate ? movie.releaseDate.split('-')[0] : 'N/A';
    if (runtimeEl) runtimeEl.textContent = movie.runtime || 'Standard Feature';
    if (voteCountEl) voteCountEl.textContent = `(${Number(movie.voteCount).toLocaleString()} votes)`;

    // Genres Pills
    const genresContainer = document.getElementById('jdrGenresContainer');
    if (genresContainer) {
      genresContainer.innerHTML = '';
      (movie.genres || []).forEach(genre => {
        const pill = document.createElement('span');
        pill.className = 'jdr-genre-pill';
        pill.textContent = genre;
        genresContainer.appendChild(pill);
      });
    }

    // Synopsis
    const synopsisEl = document.getElementById('jdrSynopsis');
    if (synopsisEl) synopsisEl.textContent = movie.overview || 'No synopsis provided.';

    // Director & Cast
    const dirEl = document.getElementById('jdrDirector');
    const castEl = document.getElementById('jdrCast');
    if (dirEl) dirEl.textContent = movie.director || 'Not listed';
    if (castEl) castEl.textContent = movie.cast || 'Ensemble cast';

    // Trailer Button Status
    const trailerBtn = document.getElementById('jdrTrailerBtn');
    if (trailerBtn) {
      trailerBtn.disabled = !movie.trailerKey;
      trailerBtn.title = movie.trailerKey ? 'Watch official YouTube trailer' : 'No trailer available for this movie';
    }

    // Request Button Status
    updateRequestButtonState(movie);
  }

  function updateRequestButtonState(movie) {
    const requestBtn = document.getElementById('jdrRequestBtn');
    if (!requestBtn) return;

    const isRequested = state.requestedMovieIds.has(movie.id) ||
                        (movie.mediaInfo && (movie.mediaInfo.status === 2 || movie.mediaInfo.status === 3));
    const isAvailable = movie.mediaInfo && movie.mediaInfo.status === 5;

    if (isAvailable) {
      requestBtn.className = 'jdr-btn jdr-btn-primary jdr-requested';
      requestBtn.disabled = true;
      requestBtn.innerHTML = `${ICONS.check} <span>Available in Library</span>`;
    } else if (isRequested) {
      requestBtn.className = 'jdr-btn jdr-btn-primary jdr-requested';
      requestBtn.disabled = true;
      requestBtn.innerHTML = `${ICONS.check} <span>Request Placed — Downloading...</span>`;
    } else {
      requestBtn.className = 'jdr-btn jdr-btn-primary';
      requestBtn.disabled = false;
      requestBtn.innerHTML = `${ICONS.download} <span>Request to Watch</span>`;
    }
  }

  async function handleRequest() {
    const movie = state.currentCandidate;
    if (!movie) return;

    const requestBtn = document.getElementById('jdrRequestBtn');
    if (requestBtn) {
      requestBtn.disabled = true;
      requestBtn.innerHTML = `${ICONS.refresh} <span>Submitting Request...</span>`;
    }

    const res = await dispatchSeerrRequest(movie.id);

    if (res.success) {
      state.requestedMovieIds.add(movie.id);
      updateRequestButtonState(movie);
      showToast('Request submitted! Download will start automatically and appear in Jellyfin when complete.');
    } else {
      if (requestBtn) {
        requestBtn.disabled = false;
        requestBtn.innerHTML = `${ICONS.download} <span>Request to Watch</span>`;
      }
      showToast('Could not submit request. Please ensure Jellyfin or Seerr is accessible.', ICONS.close);
    }
  }

  // --- DOM BUTTON INJECTIONS ---

  // 1. Inject Header "🎲 Surprise Me" Button
  function injectHeaderButton() {
    if (document.getElementById(HEADER_BTN_ID)) return;

    // Select header button tray or header right container
    const headerRight = document.querySelector('.skinHeader .headerRight') ||
                        document.querySelector('.headerRight') ||
                        document.querySelector('.MuiToolbar-root');
    if (!headerRight) return;

    const btn = document.createElement('button');
    btn.id = HEADER_BTN_ID;
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', 'Surprise Me: Discover & request random top-rated movies');
    btn.innerHTML = `${ICONS.dice} <span>Surprise Me</span>`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDiscoverModal();
    });

    // Locate the search button to inject near it
    const searchBtn = headerRight.querySelector('.headerButtonSearch, button[data-action="search"], a[href*="search"], button[aria-label*="Search"]');
    if (searchBtn && searchBtn.parentNode === headerRight) {
      headerRight.insertBefore(btn, searchBtn);
    } else {
      headerRight.prepend(btn);
    }
  }

  // 2. Inject Sidebar Drawer "✨ Discover & Request" Entry
  function injectDrawerButton() {
    if (document.getElementById(DRAWER_BTN_ID)) return;

    const drawerNav = document.querySelector('.mainDrawer-scrollContainer') ||
                      document.querySelector('.mainDrawer .scrollContainer') ||
                      document.querySelector('.drawerList') ||
                      document.querySelector('.MuiDrawer-paper .MuiList-root');
    if (!drawerNav) return;

    const item = document.createElement('a');
    item.id = DRAWER_BTN_ID;
    item.href = 'javascript:void(0);';
    item.setAttribute('role', 'button');
    item.innerHTML = `
      <div class="jdr-drawer-icon">${ICONS.sparkles}</div>
      <div class="jdr-drawer-text">Discover & Request</div>
    `;

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Close native drawer if open
      if (window.Emby && window.Emby.Page && typeof window.Emby.Page.closeMainDrawer === 'function') {
        try { window.Emby.Page.closeMainDrawer(); } catch {}
      }
      const backdrop = document.querySelector('.mainDrawer-backdrop');
      if (backdrop) backdrop.click();

      openDiscoverModal();
    });

    // Prepend or insert after the first item (typically Home)
    const firstItem = drawerNav.querySelector('.navDrawer-item, .mainDrawerButton, a, button');
    if (firstItem && firstItem.nextSibling) {
      drawerNav.insertBefore(item, firstItem.nextSibling);
    } else {
      drawerNav.appendChild(item);
    }
  }

  // 3. Inject Search View Recommendation Card
  function injectSearchCard() {
    const isSearchPage = window.location.hash.includes('search') ||
                         window.location.pathname.includes('search') ||
                         document.querySelector('.searchPage, .searchViewContainer');
    if (!isSearchPage) {
      const existing = document.getElementById(SEARCH_CARD_ID);
      if (existing) existing.remove();
      return;
    }

    if (document.getElementById(SEARCH_CARD_ID)) return;

    const searchTarget = document.querySelector('.searchPage, .searchViewContainer, .searchResults, #searchPage');
    if (!searchTarget) return;

    const card = document.createElement('div');
    card.id = SEARCH_CARD_ID;
    card.innerHTML = `
      <div class="jdr-search-content">
        <span class="jdr-search-tag">${ICONS.sparkles} Powered by AI & TMDB</span>
        <h3 class="jdr-search-title">Looking for something new to watch?</h3>
        <p class="jdr-search-subtitle">Discover top-rated movies with instant download requests & trailers.</p>
      </div>
      <button class="jdr-search-btn" id="jdrSearchCardBtn">
        ${ICONS.dice} <span>Surprise Me</span>
      </button>
    `;

    card.querySelector('#jdrSearchCardBtn').addEventListener('click', (e) => {
      e.preventDefault();
      openDiscoverModal();
    });

    searchTarget.prepend(card);
  }

  // --- RECONCILIATION & MUTATION OBSERVER ---
  let reconcileTimer = null;
  function reconcileUI() {
    injectStyles();
    injectHeaderButton();
    injectDrawerButton();
    injectSearchCard();
  }

  function scheduleReconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcileUI, 120);
  }

  // Observe DOM additions
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        scheduleReconcile();
        break;
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Navigation Event Listeners
  window.addEventListener('popstate', scheduleReconcile);
  window.addEventListener('hashchange', scheduleReconcile);
  document.addEventListener('viewshow', scheduleReconcile);
  document.addEventListener('pageshow', scheduleReconcile);

  // Initial startup trigger
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reconcileUI);
  } else {
    reconcileUI();
  }

  // Pre-seed the candidate pool in background
  setTimeout(replenishCandidatePool, 800);

  // Expose global API
  window.JellyfinDiscover = {
    open: openDiscoverModal,
    close: closeDiscoverModal,
    roll: rollNextCandidate,
    request: handleRequest,
    toggleTrailer
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.JellyfinDiscover;
  }

  console.log('[DiscoverRequest] In-Jellyfin Discovery & Request UI extension loaded successfully.');
})();
