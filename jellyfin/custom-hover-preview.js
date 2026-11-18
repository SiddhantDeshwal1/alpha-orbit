/**
 * Jellyfin Card Hover Video Preview Module
 * Architectural Component: Singleton Floating Portal Overlay with 5-Tier "Trailers First" Cascade
 *
 * Capabilities:
 *  1. Singleton Floating Portal (#jellyfin-hover-preview-portal):
 *     - Mounted directly to document.body to bypass rail overflow clipping.
 *     - Teleports and dynamically scales (1.18x) over hovered cards with smart boundary clamping.
 *     - Strictly one preview player exists in memory at any time.
 *  2. Intent & Velocity Filter:
 *     - Velocity filter: pointer velocity > 0.8 px/ms cancels intent (skimming/scrolling).
 *     - Strict dwell timer: 2000ms (2.0s) stationary hover required before triggering preview.
 *     - Pointer departure (mouseleave/pointerleave) or velocity > 0.8 px/ms cancels timer immediately.
 *  3. Strict 5-Tier Fallback Cascade ("Trailers First" Mandate):
 *     - Tier 1: Local H.264 trailer (/Items/{id}/LocalTrailers -> stream.mp4?static=true) -> HTML5 <video> autoplay loop.
 *     - Tier 2: Jellyfin Metadata item.RemoteTrailers (YouTube embed with hd1080 viewport).
 *     - Tier 3: TMDb API Resolution (multi-language search & video lookup for TV & Movies).
 *     - Tier 4: Trickplay sprite canvas scrub (visual fallback ONLY if no trailer exists).
 *     - Tier 5: Ken Burns poster zoom (subtle cinematic CSS pan/zoom fail-safe baseline).
 *  4. Audio Safety & Speaker Toggle:
 *     - Strict muted startup (isMuted = true, mute=1) on all previews.
 *     - Interactive glassmorphic speaker toggle (.hover-preview-mute-btn) allows unmuting.
 *     - Smooth 250ms volume ramp when unmuted.
 *     - Global Audio Coordinator integration (window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__).
 *  5. CPU & Memory Optimization:
 *     - Instantly aborts fetches, unloads video buffers, destroys iframes, clears canvas intervals on teardown.
 *     - Never streams full movie files for previews.
 */

(function () {
  'use strict';

  // Guard against duplicate script injection
  if (typeof window === 'undefined') return;
  if (window.__JELLYFIN_HOVER_PREVIEW_INITIALIZED__) {
    console.log('[HoverPreview] Module already initialized, skipping duplicate execution.');
    return;
  }
  window.__JELLYFIN_HOVER_PREVIEW_INITIALIZED__ = true;

  // --- CONFIGURATION CONSTANTS ---
  const VELOCITY_THRESHOLD = 0.8; // px / ms
  const DWELL_DELAY_MS = 2000; // exact 2000ms / 2.0s hover intent dwell
  const DEFAULT_VOLUME = 0.40; // 40% volume
  const AUDIO_RAMP_DURATION_MS = 250; // ms
  const TRICKPLAY_FPS = 4; // 4 frames per second
  const TRICKPLAY_INTERVAL_MS = 1000 / TRICKPLAY_FPS; // 250ms
  const TMDB_PUBLIC_API_KEY = 'f090bb54758cabf231fb605d3e3e0468';

  const STORAGE_KEY_MUTED = 'jellyfin_hover_preview_muted';

  const PORTAL_ID = 'jellyfin-hover-preview-portal';
  const STYLES_ID = 'jellyfin-hover-preview-styles';

  // SVG Icons for Glassmorphism Speaker Button
  const ICON_SPEAKER_UNMUTED = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
    </svg>
  `;

  const ICON_SPEAKER_MUTED = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
    </svg>
  `;

  // --- STATE MANAGEMENT ---
  let portalElement = null;
  let isPortalActive = false;
  let currentActiveCard = null;
  let currentActiveItemId = null;
  let currentAbortController = null;
  let portalHideTimer = null;

  // Intent & Velocity Tracker
  let candidateCard = null;
  let candidateItemId = null;
  let dwellTimer = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let lastPointerTime = 0;

  // Active Players / Animators
  let currentActiveVideo = null;
  let currentActiveIframe = null;
  let activeTrickplayTimer = null;
  let activeTrickplayAnimFrame = null;
  let activeTrickplayImg = null;
  let audioRampTimer = null;
  let currentIsMuted = true; // Hover preview starts strictly muted

  // Safe localStorage access helpers
  function getStoredMuted() {
    try {
      return localStorage.getItem(STORAGE_KEY_MUTED);
    } catch {
      return null;
    }
  }

  function setStoredMuted(isMuted) {
    try {
      localStorage.setItem(STORAGE_KEY_MUTED, isMuted ? 'true' : 'false');
    } catch {}
  }

  // --- STYLESHEET INJECTION ---
  function injectModuleStyles() {
    if (document.getElementById(STYLES_ID)) return;

    const styleEl = document.createElement('style');
    styleEl.id = STYLES_ID;
    styleEl.textContent = `
      /* ── Singleton Floating Preview Portal ── */
      #${PORTAL_ID} {
        position: fixed;
        z-index: 99999;
        background-color: #141414;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.95), 0 0 0 1px rgba(255, 255, 255, 0.14);
        cursor: pointer;
        pointer-events: none;
        opacity: 0;
        transform: scale(0.96) translateZ(0);
        transition: transform 0.26s cubic-bezier(0.165, 0.84, 0.44, 1.0),
                    opacity 0.22s ease,
                    box-shadow 0.26s ease;
        will-change: transform, opacity;
        box-sizing: border-box;
      }

      #${PORTAL_ID}.active {
        opacity: 1;
        pointer-events: auto;
        transform: scale(1.18) translateZ(0);
      }

      /* Inner media layout */
      .hover-preview-inner {
        position: relative;
        width: 100%;
        height: 100%;
        background-color: #141414;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
      }

      .hover-preview-media-container {
        position: absolute;
        inset: 0;
        overflow: hidden;
        background-color: #141414;
        z-index: 1;
      }

      /* Media types */
      .hover-preview-video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .hover-preview-canvas {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        image-rendering: -webkit-optimize-contrast;
      }

      .hover-preview-iframe {
        width: 100%;
        height: 100%;
        border: none;
        pointer-events: none;
        display: block;
      }

      .hover-preview-kenburns {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        animation: hoverKenBurns 10s ease-in-out infinite alternate;
        will-change: transform;
      }

      @keyframes hoverKenBurns {
        0% { transform: scale(1.0) translate(0%, 0%); }
        50% { transform: scale(1.14) translate(-2%, -2%); }
        100% { transform: scale(1.07) translate(2%, -1%); }
      }

      /* Vignette Overlay for Title Legibility */
      .hover-preview-vignette {
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(0,0,0,0.2) 0%, transparent 40%, rgba(20,20,20,0.92) 100%);
        z-index: 2;
        pointer-events: none;
      }

      /* Floating Glassmorphic Speaker Button */
      .hover-preview-mute-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.25);
        background: rgba(20, 20, 20, 0.65);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        color: #FFFFFF;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        z-index: 5;
        transition: background-color 0.2s ease, transform 0.15s ease, border-color 0.2s ease;
      }

      .hover-preview-mute-btn:hover {
        background: rgba(229, 9, 20, 0.85);
        border-color: #E50914;
        transform: scale(1.08);
      }

      .hover-preview-mute-btn.hidden {
        display: none !important;
      }

      /* Bottom Info & Netflix Typography */
      .hover-preview-info {
        position: relative;
        padding: 10px 12px;
        z-index: 4;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .hover-preview-title {
        color: #FFFFFF;
        font-family: "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 0.95rem;
        font-weight: 700;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.85);
      }

      .hover-preview-badges {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 0.72rem;
        font-weight: 600;
      }

      .hover-preview-badge {
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.15);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        color: rgba(255, 255, 255, 0.9);
      }

      .hover-preview-badge.tier {
        background: rgba(229, 9, 20, 0.85);
        color: #FFFFFF;
        font-size: 0.65rem;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .hover-preview-badge.rating {
        border: 1px solid rgba(255, 255, 255, 0.35);
        background: transparent;
      }
    `;

    document.head.appendChild(styleEl);
  }

  // --- SINGLETON PORTAL CREATION ---
  function ensurePortalExists() {
    if (portalElement && document.getElementById(PORTAL_ID)) {
      return portalElement;
    }

    portalElement = document.getElementById(PORTAL_ID);
    if (!portalElement) {
      portalElement = document.createElement('div');
      portalElement.id = PORTAL_ID;
      portalElement.innerHTML = `
        <div class="hover-preview-inner">
          <div class="hover-preview-media-container"></div>
          <div class="hover-preview-vignette"></div>
          <button class="hover-preview-mute-btn" title="Toggle Sound" aria-label="Toggle Sound">
            ${ICON_SPEAKER_MUTED}
          </button>
          <div class="hover-preview-info">
            <div class="hover-preview-title"></div>
            <div class="hover-preview-badges">
              <span class="hover-preview-badge tier">PREVIEW</span>
              <span class="hover-preview-badge year" style="display: none;"></span>
              <span class="hover-preview-badge rating" style="display: none;"></span>
              <span class="hover-preview-badge stars" style="display: none;"></span>
            </div>
          </div>
        </div>
      `;

      // Attach singleton directly to body to bypass rail overflow clipping
      document.body.appendChild(portalElement);
    }

    // Attach Portal Event Listeners
    const muteBtn = portalElement.querySelector('.hover-preview-mute-btn');
    if (muteBtn && !muteBtn._bound) {
      muteBtn._bound = true;
      muteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleAudioMute();
      });
    }

    // Clicking the portal navigates to the item
    if (!portalElement._clickBound) {
      portalElement._clickBound = true;
      portalElement.addEventListener('click', (e) => {
        if (e.target.closest('.hover-preview-mute-btn')) return;
        if (currentActiveItemId) {
          const itemId = currentActiveItemId;
          closePreview();
          navigateToItem(itemId);
        }
      });
    }

    // Mouseleave from portal triggers teardown
    if (!portalElement._leaveBound) {
      portalElement._leaveBound = true;
      portalElement.addEventListener('mouseleave', (e) => {
        const related = e.relatedTarget;
        if (currentActiveCard && related && currentActiveCard.contains(related)) {
          return;
        }
        closePreview();
      });
    }

    return portalElement;
  }

  // --- JELLYFIN AUTHENTICATION & API UTILITIES ---
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
        if (typeof window.ApiClient.getCurrentUserId === 'function') {
          userId = window.ApiClient.getCurrentUserId();
        }
      } catch {}
    }

    // 2. LocalStorage Fallback (Session persistence)
    if (!token || !userId) {
      try {
        const credsStr = localStorage.getItem('jellyfin_credentials');
        if (credsStr) {
          const creds = JSON.parse(credsStr);
          if (creds.Servers && creds.Servers.length > 0) {
            const s = creds.Servers[0];
            if (!serverAddress) serverAddress = s.ManualAddress || s.Address || '';
            if (!token) token = s.AccessToken || '';
            if (!userId) userId = s.UserId || '';
          }
        }
      } catch {}
    }

    if (!token) {
      try {
        token = localStorage.getItem('token') || '';
      } catch {}
    }

    if (!userId) {
      try {
        userId = localStorage.getItem('userId') || '';
      } catch {}
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
      'Accept': 'application/json'
    };
    if (token) {
      headers['X-Emby-Token'] = token;
      if (window.ApiClient && typeof window.ApiClient.appName === 'function') {
        try {
          headers['Authorization'] = `MediaBrowser Client="${window.ApiClient.appName()}", Device="${window.ApiClient.deviceName()}", DeviceId="${window.ApiClient.deviceId()}", Version="${window.ApiClient.appVersion()}", Token="${token}"`;
        } catch {}
      } else {
        headers['Authorization'] = `MediaBrowser Client="Jellyfin Web", Device="Browser", DeviceId="hover-preview", Version="12.2.0", Token="${token}"`;
      }
    }
    return headers;
  }

  function navigateToItem(itemId) {
    if (window.Emby?.Page && typeof window.Emby.Page.showItem === 'function') {
      window.Emby.Page.showItem(itemId);
    } else {
      window.location.hash = `#/details?id=${itemId}`;
    }
  }

  function extractItemId(element) {
    if (!element) return null;
    const card = element.closest('.card, .cardBox, [data-id], .cardScalable');
    if (!card) return null;

    let id =
      card.dataset.id ||
      card.getAttribute('data-id') ||
      card.dataset.itemId ||
      card.getAttribute('data-itemid') ||
      card.querySelector('[data-id]')?.getAttribute('data-id') ||
      card.closest('[data-id]')?.getAttribute('data-id');

    if (!id) {
      const link = card.querySelector('a[href*="id="]') || (card.tagName === 'A' ? card : null);
      if (link?.href) {
        const match = link.href.match(/[?&]id=([a-f0-9-]+)/i);
        if (match) id = match[1];
      }
    }
    return id;
  }

  function extractYouTubeId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return match ? match[1] : null;
  }

  // --- METADATA POPULATION ---
  function populateCardInfoFromDOM(card) {
    if (!portalElement) return;

    const titleEl = portalElement.querySelector('.hover-preview-title');
    const yearBadge = portalElement.querySelector('.hover-preview-badge.year');
    const ratingBadge = portalElement.querySelector('.hover-preview-badge.rating');
    const starsBadge = portalElement.querySelector('.hover-preview-badge.stars');

    // Extract title from card DOM
    const rawTitle =
      card.querySelector('.cardText-first')?.textContent ||
      card.querySelector('.cardTextTitle')?.textContent ||
      card.querySelector('.cardItemTitle')?.textContent ||
      card.getAttribute('data-itemname') ||
      card.getAttribute('aria-label') ||
      '';

    if (titleEl) {
      titleEl.textContent = rawTitle.trim();
    }

    // Extract year from card secondary text
    const rawSubtext = card.querySelector('.cardText-secondary')?.textContent || '';
    const yearMatch = rawSubtext.match(/\b(19\d\d|20\d\d)\b/);
    if (yearBadge) {
      if (yearMatch) {
        yearBadge.textContent = yearMatch[1];
        yearBadge.style.display = 'inline-block';
      } else {
        yearBadge.style.display = 'none';
      }
    }

    if (ratingBadge) ratingBadge.style.display = 'none';
    if (starsBadge) starsBadge.style.display = 'none';
  }

  function updateMetadataFromItem(item) {
    if (!portalElement || !item) return;

    const titleEl = portalElement.querySelector('.hover-preview-title');
    const yearBadge = portalElement.querySelector('.hover-preview-badge.year');
    const ratingBadge = portalElement.querySelector('.hover-preview-badge.rating');
    const starsBadge = portalElement.querySelector('.hover-preview-badge.stars');

    if (titleEl && item.Name) {
      titleEl.textContent = item.Name;
    }

    if (yearBadge) {
      const year = item.ProductionYear || (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : null);
      if (year) {
        yearBadge.textContent = year;
        yearBadge.style.display = 'inline-block';
      }
    }

    if (ratingBadge) {
      if (item.OfficialRating) {
        ratingBadge.textContent = item.OfficialRating;
        ratingBadge.style.display = 'inline-block';
      } else {
        ratingBadge.style.display = 'none';
      }
    }

    if (starsBadge) {
      if (item.CommunityRating) {
        starsBadge.textContent = `★ ${item.CommunityRating.toFixed(1)}`;
        starsBadge.style.display = 'inline-block';
      } else {
        starsBadge.style.display = 'none';
      }
    }
  }

  function updateTierBadge(text) {
    if (!portalElement) return;
    const tierBadge = portalElement.querySelector('.hover-preview-badge.tier');
    if (tierBadge) {
      tierBadge.textContent = text;
    }
  }

  // --- AUDIO & SPEAKER BUTTON CONTROLS ---
  function isMutedConfigured() {
    // Hover preview starts strictly muted (muted=true, mute=1)
    if (currentIsMuted) {
      return true;
    }
    // If another audio source currently holds the audio lock, stay muted to prevent clashes
    if (window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ && window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'hover') {
      return true;
    }
    return false;
  }

  // --- GLOBAL AUDIO COORDINATOR INTEGRATION ---
  function acquireAudioLock() {
    try {
      window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ = 'hover';
      if (typeof window.__JELLYFIN_AUDIO_LOCK__ === 'object' && window.__JELLYFIN_AUDIO_LOCK__ !== null) {
        if (typeof window.__JELLYFIN_AUDIO_LOCK__.acquire === 'function') {
          window.__JELLYFIN_AUDIO_LOCK__.acquire('hover');
        } else if (typeof window.__JELLYFIN_AUDIO_LOCK__.setLock === 'function') {
          window.__JELLYFIN_AUDIO_LOCK__.setLock('hover');
        } else if (typeof window.__JELLYFIN_AUDIO_LOCK__.requestLock === 'function') {
          window.__JELLYFIN_AUDIO_LOCK__.requestLock('hover');
        }
      } else {
        window.__JELLYFIN_AUDIO_LOCK__ = 'hover';
      }
      window.dispatchEvent(new CustomEvent('jellyfin-audio-lock-acquired', { detail: { source: 'hover' } }));
    } catch {}
  }

  function releaseAudioLock() {
    try {
      if (window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hover') {
        window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ = null;
        if (typeof window.__JELLYFIN_AUDIO_LOCK__ === 'object' && window.__JELLYFIN_AUDIO_LOCK__ !== null) {
          if (typeof window.__JELLYFIN_AUDIO_LOCK__.release === 'function') {
            window.__JELLYFIN_AUDIO_LOCK__.release('hover');
          } else if (typeof window.__JELLYFIN_AUDIO_LOCK__.releaseLock === 'function') {
            window.__JELLYFIN_AUDIO_LOCK__.releaseLock('hover');
          }
        } else if (window.__JELLYFIN_AUDIO_LOCK__ === 'hover' || window.__JELLYFIN_AUDIO_LOCK__ === true) {
          window.__JELLYFIN_AUDIO_LOCK__ = null;
        }
        window.dispatchEvent(new CustomEvent('jellyfin-audio-lock-released', { detail: { source: 'hover' } }));
      }
    } catch {}
  }

  function updateMuteButtonState(isMuted, isVisible = true) {
    if (!portalElement) return;
    const btn = portalElement.querySelector('.hover-preview-mute-btn');
    if (!btn) return;

    if (!isVisible) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');

    btn.innerHTML = isMuted ? ICON_SPEAKER_MUTED : ICON_SPEAKER_UNMUTED;
    btn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
    btn.title = isMuted ? 'Unmute' : 'Mute';
  }

  function rampVolume(video, targetVolume, durationMs) {
    if (!video) return;
    if (audioRampTimer) {
      cancelAnimationFrame(audioRampTimer);
      audioRampTimer = null;
    }

    try {
      video.muted = false;
      video.volume = 0;
    } catch {}

    const startVolume = 0;
    const startTime = performance.now();

    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const nextVol = Math.max(0, Math.min(1, startVolume + (targetVolume - startVolume) * progress));
      try {
        video.volume = nextVol;
      } catch {}

      if (progress < 1 && !video.paused) {
        audioRampTimer = requestAnimationFrame(tick);
      } else {
        try {
          video.volume = targetVolume;
        } catch {}
        audioRampTimer = null;
      }
    }
    audioRampTimer = requestAnimationFrame(tick);
  }

  function toggleAudioMute() {
    currentIsMuted = !currentIsMuted;

    if (!currentIsMuted) {
      acquireAudioLock();
    } else {
      releaseAudioLock();
    }

    setStoredMuted(currentIsMuted);
    updateMuteButtonState(currentIsMuted, true);

    // Tier 1 HTML5 Video Sound
    if (currentActiveVideo) {
      if (currentIsMuted) {
        if (audioRampTimer) {
          cancelAnimationFrame(audioRampTimer);
          audioRampTimer = null;
        }
        try {
          currentActiveVideo.muted = true;
          currentActiveVideo.volume = 0;
        } catch {}
      } else {
        rampVolume(currentActiveVideo, DEFAULT_VOLUME, AUDIO_RAMP_DURATION_MS);
      }
    }

    // Tier 2 & Tier 3 YouTube Iframe Sound
    if (currentActiveIframe?.contentWindow) {
      try {
        if (currentIsMuted) {
          currentActiveIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'mute' }), '*');
        } else {
          currentActiveIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'unMute' }), '*');
          currentActiveIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [DEFAULT_VOLUME * 100] }), '*');
        }
      } catch {}
    }
  }

  // --- MEDIA SWAPPER HELPER ---
  function replaceMedia(element) {
    if (!portalElement) return;
    const container = portalElement.querySelector('.hover-preview-media-container');
    if (!container) return;

    container.innerHTML = '';
    container.appendChild(element);
  }

  // --- 4-TIER FALLBACK CASCADE (ZERO-TRANSCODE MANDATE) ---

  // Tier 4: Ken Burns Poster Zoom (Instant Fallback & Pre-display)
  function mountKenBurnsTier(itemId, serverAddress, token) {
    const backdropUrl = `${serverAddress}/Items/${itemId}/Images/Backdrop/0?maxWidth=800&api_key=${token}`;
    const posterUrl = `${serverAddress}/Items/${itemId}/Images/Primary?maxWidth=600&api_key=${token}`;

    const img = document.createElement('img');
    img.className = 'hover-preview-kenburns';
    img.alt = 'Preview';
    img.src = backdropUrl;
    img.onerror = () => {
      img.onerror = null; // Guard against infinite error loop if poster also 404s
      img.src = posterUrl;
    };

    replaceMedia(img);
    updateTierBadge('PREVIEW');
    updateMuteButtonState(true, false); // Hide mute button on static image
  }

  // Tier 1: Local H.264 Trailer Direct Stream (Never stream full movie files)
  async function fetchLocalTrailer(itemId, userId, serverAddress, token, abortSignal) {
    const primaryUrl = userId
      ? `${serverAddress}/Users/${userId}/Items/${itemId}/LocalTrailers`
      : `${serverAddress}/Items/${itemId}/LocalTrailers`;

    try {
      const res = await fetch(primaryUrl, {
        signal: abortSignal,
        headers: getAuthHeaders(token)
      });
      if (res.ok) {
        const trailers = await res.json();
        const trailerList = Array.isArray(trailers) ? trailers : (trailers?.Items || []);
        if (trailerList.length > 0) {
          const trailer = trailerList[0];
          // Guard: Never stream full movie files for previews, only valid dedicated trailer media
          if (trailer.Id && trailer.Id !== itemId) {
            const mediaSourceId = (trailer.MediaSources && trailer.MediaSources[0])
              ? trailer.MediaSources[0].Id
              : trailer.Id;

            return {
              id: trailer.Id,
              url: `${serverAddress}/Videos/${trailer.Id}/stream.mp4?mediaSourceId=${mediaSourceId}&api_key=${token}&static=true`
            };
          }
        }
      }
    } catch {}

    // Fallback: If Item is Episode or Season, query parent Series for trailer
    try {
      const itemDetailUrl = `${serverAddress}/Items/${itemId}?Fields=SeriesId,SeasonId,Type`;
      const detailRes = await fetch(itemDetailUrl, { signal: abortSignal, headers: getAuthHeaders(token) });
      if (detailRes.ok) {
        const itemInfo = await detailRes.json();
        const fallbackId = itemInfo.SeriesId || itemInfo.SeasonId;
        if (fallbackId && fallbackId !== itemId) {
          const fbUrl = userId
            ? `${serverAddress}/Users/${userId}/Items/${fallbackId}/LocalTrailers`
            : `${serverAddress}/Items/${fallbackId}/LocalTrailers`;
          const fbRes = await fetch(fbUrl, { signal: abortSignal, headers: getAuthHeaders(token) });
          if (fbRes.ok) {
            const fbTrailers = await fbRes.json();
            const fbList = Array.isArray(fbTrailers) ? fbTrailers : (fbTrailers?.Items || []);
            if (fbList.length > 0) {
              const tr = fbList[0];
              // Guard: Ensure dedicated trailer ID, never full series or episode item
              if (tr.Id && tr.Id !== itemId && tr.Id !== fallbackId) {
                const msId = (tr.MediaSources && tr.MediaSources[0]) ? tr.MediaSources[0].Id : tr.Id;
                return {
                  id: tr.Id,
                  url: `${serverAddress}/Videos/${tr.Id}/stream.mp4?mediaSourceId=${msId}&api_key=${token}&static=true`
                };
              }
            }
          }
        }
      }
    } catch {}

    return null;
  }

  function mountVideoTier(videoUrl, abortSignal) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.className = 'hover-preview-video';
      video.playsInline = true;
      video.loop = true;
      video.preload = 'auto';

      // Audio Safety: Hover preview starts strictly muted
      video.muted = true;
      video.volume = 0;

      let resolved = false;
      const safeResolve = (val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      };

      video.oncanplay = () => {
        if (abortSignal.aborted) {
          safeResolve(false);
          return;
        }

        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              if (abortSignal.aborted) {
                video.pause();
                safeResolve(false);
                return;
              }

              currentActiveVideo = video;
              replaceMedia(video);
              updateTierBadge('LOCAL TRAILER');
              updateMuteButtonState(true, true);
              safeResolve(true);
            })
            .catch(() => {
              video.muted = true;
              video.play()
                .then(() => {
                  if (abortSignal.aborted) {
                    video.pause();
                    safeResolve(false);
                    return;
                  }
                  currentActiveVideo = video;
                  replaceMedia(video);
                  updateTierBadge('LOCAL TRAILER');
                  updateMuteButtonState(true, true);
                  safeResolve(true);
                })
                .catch(() => safeResolve(false));
            });
        }
      };

      video.onerror = () => safeResolve(false);
      video.src = videoUrl;
    });
  }

  // Tier 4: Trickplay Sprite Canvas Animation (Visual fallback ONLY if no trailer exists)
  function mountTrickplayTier(itemId, serverAddress, token, abortSignal) {
    return new Promise((resolve) => {
      const imgUrl = `${serverAddress}/Videos/${itemId}/Trickplay/320/0.jpg?api_key=${token}`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      activeTrickplayImg = img;

      let resolved = false;
      const safeResolve = (val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
        }
      };

      img.onload = async () => {
        if (abortSignal.aborted) {
          safeResolve(false);
          return;
        }
        if (img.naturalWidth === 0 || img.naturalHeight === 0) {
          safeResolve(false);
          return;
        }

        let tileWidth = 320;
        let tileHeight = Math.round((tileWidth * 9) / 16);
        let cols = Math.max(1, Math.floor(img.naturalWidth / tileWidth));
        let rows = Math.max(1, Math.floor(img.naturalHeight / tileHeight));
        let totalTiles = cols * rows;

        // Query trickplay manifest for exact tile dimensions if available
        try {
          const manifestUrl = `${serverAddress}/Videos/${itemId}/Trickplay/320/GetManifest?api_key=${token}`;
          const mResp = await fetch(manifestUrl, { signal: abortSignal, headers: getAuthHeaders(token) });
          if (mResp.ok) {
            const manifest = await mResp.json();
            if (manifest.TileWidth) tileWidth = manifest.TileWidth;
            if (manifest.TileHeight) tileHeight = manifest.TileHeight;
            if (manifest.ThumbnailCount) totalTiles = manifest.ThumbnailCount;
            cols = Math.max(1, Math.floor(img.naturalWidth / tileWidth));
            rows = Math.max(1, Math.floor(img.naturalHeight / tileHeight));
          }
        } catch {}

        if (abortSignal.aborted) {
          safeResolve(false);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.className = 'hover-preview-canvas';
        canvas.width = tileWidth;
        canvas.height = tileHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          safeResolve(false);
          return;
        }

        let currentFrame = 0;
        function renderFrame(idx) {
          const c = idx % cols;
          const r = Math.floor(idx / cols);
          const sx = c * tileWidth;
          const sy = r * tileHeight;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, sx, sy, tileWidth, tileHeight, 0, 0, canvas.width, canvas.height);
        }

        // Render first frame immediately
        renderFrame(0);
        replaceMedia(canvas);
        updateTierBadge('TRICKPLAY');
        updateMuteButtonState(true, false); // Trickplay is visual-only

        // Animated scrub at 4 FPS (250ms interval)
        activeTrickplayTimer = setInterval(() => {
          if (abortSignal.aborted) {
            if (activeTrickplayTimer) {
              clearInterval(activeTrickplayTimer);
              activeTrickplayTimer = null;
            }
            return;
          }
          currentFrame = (currentFrame + 1) % totalTiles;
          renderFrame(currentFrame);
        }, TRICKPLAY_INTERVAL_MS);

        safeResolve(true);
      };

      img.onerror = () => safeResolve(false);
      img.src = imgUrl;
    });
  }

  // --- YOUTUBE EMBED TIER (TIER 2 & TIER 3) ---
  function mountYouTubeTier(ytId, card, abortSignal, tierBadge = 'TRAILER') {
    return new Promise((resolve) => {
      if (abortSignal.aborted) {
        resolve(false);
        return;
      }

      const hostOrigin = (window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : (window.location.protocol + '//' + window.location.host);

      const iframe = document.createElement('iframe');
      iframe.className = 'hover-preview-iframe';
      // Set explicit 1920x1080 attributes as mandated
      iframe.setAttribute('width', '1920');
      iframe.setAttribute('height', '1080');
      iframe.setAttribute('allow', 'autoplay; encrypted-media');
      iframe.setAttribute('allowfullscreen', 'false');

      // Embed URL with strictly muted (mute=1), &vq=hd1080, and origin parameter
      iframe.src = `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${ytId}&modestbranding=1&rel=0&playsinline=1&enablejsapi=1&vq=hd1080&origin=${encodeURIComponent(hostOrigin)}`;

      // Quality & Viewport Configuration for Portrait Cards:
      // In portrait cards (cardRect.height > cardRect.width), size iframe dynamically:
      // width = Math.ceil(height * 16 / 9)px, centered with transform: translate(-50%, -50%), preventing black bars
      const rect = card ? card.getBoundingClientRect() : (portalElement ? portalElement.getBoundingClientRect() : null);
      if (rect && rect.height > rect.width) {
        const height = rect.height;
        const dynamicWidth = Math.ceil((height * 16) / 9);
        iframe.style.position = 'absolute';
        iframe.style.top = '50%';
        iframe.style.left = '50%';
        iframe.style.height = `${height}px`;
        iframe.style.width = `${dynamicWidth}px`;
        iframe.style.maxWidth = 'none';
        iframe.style.transform = 'translate(-50%, -50%)';
      } else {
        iframe.style.position = 'absolute';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.transform = 'none';
      }

      currentActiveIframe = iframe;
      replaceMedia(iframe);
      updateTierBadge(tierBadge);
      updateMuteButtonState(true, true); // Hover preview starts strictly muted

      if (abortSignal.aborted) {
        resolve(false);
        return;
      }

      resolve(true);
    });
  }

  // --- ITEM DETAILS & REMOTE TRAILER RESOLVER (TIER 2) ---
  async function fetchItemDetails(itemId, serverAddress, token, abortSignal) {
    try {
      const itemUrl = `${serverAddress}/Items/${itemId}?Fields=RemoteTrailers,Overview,Genres,ProductionYear,PremiereDate,OfficialRating,CommunityRating,ProviderIds,Type,SeriesId,SeasonId,MediaSources`;
      const res = await fetch(itemUrl, {
        signal: abortSignal,
        headers: getAuthHeaders(token)
      });
      if (res.ok) {
        const item = await res.json();
        // If Episode or Season has no trailers / provider ids, check parent Series
        if (item && (!item.RemoteTrailers || item.RemoteTrailers.length === 0) && (!item.ProviderIds?.Tmdb && !item.ProviderIds?.tmdb)) {
          const parentId = item.SeriesId;
          if (parentId && parentId !== itemId) {
            try {
              const pUrl = `${serverAddress}/Items/${parentId}?Fields=RemoteTrailers,ProviderIds,Type,ProductionYear`;
              const pRes = await fetch(pUrl, { signal: abortSignal, headers: getAuthHeaders(token) });
              if (pRes.ok) {
                const parentItem = await pRes.json();
                if (parentItem) {
                  if (!item.RemoteTrailers || item.RemoteTrailers.length === 0) {
                    item.RemoteTrailers = parentItem.RemoteTrailers;
                  }
                  if (!item.ProviderIds?.Tmdb && !item.ProviderIds?.tmdb) {
                    item.ProviderIds = { ...(item.ProviderIds || {}), ...(parentItem.ProviderIds || {}) };
                  }
                  if (!item.SeriesName && parentItem.Name) {
                    item.SeriesName = parentItem.Name;
                  }
                }
              }
            } catch {}
          }
        }
        return item;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
    return null;
  }

  function resolveRemoteTrailerYtId(item) {
    if (!item || !item.RemoteTrailers || !Array.isArray(item.RemoteTrailers) || item.RemoteTrailers.length === 0) {
      return null;
    }
    for (const trailer of item.RemoteTrailers) {
      const trailerUrl = typeof trailer === 'string' ? trailer : (trailer?.Url || '');
      const ytId = extractYouTubeId(trailerUrl);
      if (ytId) return ytId;
    }
    return null;
  }

  // --- TMDB API RESOLVER (TIER 3) ---
  async function fetchTmdbTrailer(tmdbId, itemType, abortSignal) {
    if (!tmdbId) return null;
    const isTv = itemType === 'Series' || itemType === 'Season' || itemType === 'Episode';
    const primaryType = isTv ? 'tv' : 'movie';
    const secondaryType = isTv ? 'movie' : 'tv';

    const tryFetchVideos = async (type) => {
      try {
        const url = `https://api.themoviedb.org/3/${type}/${encodeURIComponent(tmdbId)}/videos?api_key=${TMDB_PUBLIC_API_KEY}&include_video_language=hi,en,ko,ja,es,fr,null`;
        const res = await fetch(url, { signal: abortSignal });
        if (!res.ok) return null;
        const data = await res.json();
        const results = data?.results;
        if (!Array.isArray(results) || results.length === 0) return null;

        const ytVideos = results.filter((v) => v.site === 'YouTube' && v.key);
        if (ytVideos.length === 0) return null;

        // Rank priority: Official Trailer > Trailer > Official Teaser > Teaser > Other YouTube
        ytVideos.sort((a, b) => {
          const score = (v) => {
            let s = 0;
            if (v.type === 'Trailer') s += 80;
            else if (v.type === 'Teaser') s += 50;
            else if (v.type === 'Clip') s += 30;
            else s += 20;
            if (v.official) s += 20;
            if (v.iso_639_1 === 'en' || v.iso_639_1 === 'hi') s += 5;
            return s;
          };
          return score(b) - score(a);
        });

        return ytVideos[0].key;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        return null;
      }
    };

    let key = await tryFetchVideos(primaryType);
    if (!key) {
      key = await tryFetchVideos(secondaryType);
    }
    return key;
  }

  async function searchTmdb(title, year, itemType, abortSignal) {
    if (!title) return null;
    const isTv = itemType === 'Series' || itemType === 'Season' || itemType === 'Episode';
    const searchTypes = isTv ? ['tv', 'movie'] : ['movie', 'tv'];

    for (const type of searchTypes) {
      try {
        const yearParam = year ? (type === 'tv' ? `&first_air_date_year=${encodeURIComponent(year)}` : `&year=${encodeURIComponent(year)}`) : '';
        let url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_PUBLIC_API_KEY}&query=${encodeURIComponent(title)}${yearParam}`;
        let res = await fetch(url, { signal: abortSignal });
        if (res.ok) {
          let data = await res.json();
          if (data?.results?.length > 0) {
            return { id: data.results[0].id, type: type };
          }
        }
        // Fallback without year if year search had no match
        if (year) {
          url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_PUBLIC_API_KEY}&query=${encodeURIComponent(title)}`;
          res = await fetch(url, { signal: abortSignal });
          if (res.ok) {
            let data = await res.json();
            if (data?.results?.length > 0) {
              return { id: data.results[0].id, type: type };
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }
    }
    return null;
  }

  // --- MASTER CASCADE RESOLVER ("TRAILERS FIRST" MANDATE) ---
  async function executeCascade(itemId, card, abortSignal) {
    const { serverAddress, token, userId } = getJellyfinAuth();

    // 0. Render baseline Ken Burns backdrop poster (Tier 5 fail-safe baseline, 0ms layout shift)
    mountKenBurnsTier(itemId, serverAddress, token);

    // Asynchronously fetch item details for metadata & cascade resolution
    let item = null;
    try {
      item = await fetchItemDetails(itemId, serverAddress, token, abortSignal);
      if (abortSignal.aborted) return;
      if (item) {
        updateMetadataFromItem(item);
      }
    } catch (e) {
      if (abortSignal.aborted) return;
    }

    // Tier 1: Local Trailers (Direct stream HTML5 <video> with static=true)
    try {
      const localTrailer = await fetchLocalTrailer(itemId, userId, serverAddress, token, abortSignal);
      if (abortSignal.aborted) return;
      if (localTrailer?.url) {
        const success = await mountVideoTier(localTrailer.url, abortSignal);
        if (success) {
          console.log('[HoverPreview] Tier 1 (Local Trailer) activated successfully.');
          return;
        }
      }
    } catch (e) {
      if (abortSignal.aborted) return;
      console.debug('[HoverPreview] Tier 1 bypassed:', e);
    }

    // Tier 2: Jellyfin Metadata item.RemoteTrailers (YouTube)
    try {
      const remoteYtId = resolveRemoteTrailerYtId(item);
      if (abortSignal.aborted) return;
      if (remoteYtId) {
        const success = await mountYouTubeTier(remoteYtId, card, abortSignal, 'TRAILER');
        if (success) {
          console.log('[HoverPreview] Tier 2 (Jellyfin Remote Trailer) activated successfully:', remoteYtId);
          return;
        }
      }
    } catch (e) {
      if (abortSignal.aborted) return;
      console.debug('[HoverPreview] Tier 2 bypassed:', e);
    }

    // Tier 3: TMDb API Resolution (Videos API with multi-language & TV/Movie support)
    try {
      let tmdbId = item?.ProviderIds?.Tmdb || item?.ProviderIds?.tmdb || item?.ProviderIds?.TheMovieDb;
      let tmdbType = (item?.Type === 'Series' || item?.Type === 'Season' || item?.Type === 'Episode') ? 'tv' : 'movie';

      // If no TMDb ID in metadata, search TMDb by title + year
      if (!tmdbId && item) {
        const searchTitle = (item.Type === 'Episode' || item.Type === 'Season') && item.SeriesName ? item.SeriesName : (item.Name || '');
        const searchYear = item.ProductionYear || (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : null);
        if (searchTitle) {
          const searchResult = await searchTmdb(searchTitle, searchYear, item.Type, abortSignal);
          if (searchResult) {
            tmdbId = searchResult.id;
            tmdbType = searchResult.type;
          }
        }
      }

      if (abortSignal.aborted) return;

      if (tmdbId) {
        const tmdbYtKey = await fetchTmdbTrailer(tmdbId, tmdbType, abortSignal);
        if (abortSignal.aborted) return;
        if (tmdbYtKey) {
          const success = await mountYouTubeTier(tmdbYtKey, card, abortSignal, 'TRAILER');
          if (success) {
            console.log('[HoverPreview] Tier 3 (TMDb YouTube Trailer) activated successfully:', tmdbYtKey);
            return;
          }
        }
      }
    } catch (e) {
      if (abortSignal.aborted) return;
      console.debug('[HoverPreview] Tier 3 bypassed:', e);
    }

    // Tier 4: Trickplay Sprite Canvas Scrub (Visual fallback ONLY if no trailer exists)
    try {
      const trickplaySuccess = await mountTrickplayTier(itemId, serverAddress, token, abortSignal);
      if (abortSignal.aborted) return;
      if (trickplaySuccess) {
        console.log('[HoverPreview] Tier 4 (Trickplay Canvas Scrub) activated successfully.');
        return;
      }
    } catch (e) {
      if (abortSignal.aborted) return;
      console.debug('[HoverPreview] Tier 4 bypassed:', e);
    }

    // Tier 5: Ken Burns Poster Zoom (Retained as final fail-safe baseline)
    console.log('[HoverPreview] Tier 5 (Ken Burns Zoom) retained as fail-safe preview.');
    updateTierBadge('PREVIEW');
  }

  // --- ACTIVATION & POSITIONING ---
  function activatePreview(card, itemId) {
    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    if (portalHideTimer) {
      clearTimeout(portalHideTimer);
      portalHideTimer = null;
    }
    if (!card || !itemId) return;

    ensurePortalExists();

    // Cancel any prior in-flight session
    if (currentAbortController) {
      try {
        currentAbortController.abort();
      } catch {}
    }
    currentAbortController = new AbortController();

    isPortalActive = true;
    currentIsMuted = true; // Audio Safety: Hover preview starts strictly muted
    currentActiveCard = card;
    currentActiveItemId = itemId;

    // Compute bounding rect of hovered card
    const rect = card.getBoundingClientRect();
    const vpWidth = window.innerWidth;
    const vpHeight = window.innerHeight;

    portalElement.style.top = `${rect.top}px`;
    portalElement.style.left = `${rect.left}px`;
    portalElement.style.width = `${rect.width}px`;
    portalElement.style.height = `${rect.height}px`;

    // Smart Transform Origin Clamping to prevent screen edge clipping
    let originX = 'center';
    let originY = 'center';

    if (rect.left < 60) {
      originX = 'left';
    } else if (rect.right > vpWidth - 60) {
      originX = 'right';
    }

    if (rect.top < 60) {
      originY = 'top';
    } else if (rect.bottom > vpHeight - 60) {
      originY = 'bottom';
    }

    portalElement.style.transformOrigin = `${originX} ${originY}`;
    portalElement.style.display = 'block';

    // Populate metadata from card DOM
    populateCardInfoFromDOM(card);

    // Force reflow and activate CSS expansion
    void portalElement.offsetWidth;
    portalElement.classList.add('active');

    // Execute 5-Tier Fallback Cascade ("Trailers First" Mandate)
    executeCascade(itemId, card, currentAbortController.signal);
  }

  // --- TEARDOWN & CLEANUP (CPU & MEMORY OPTIMIZATION) ---
  function closePreview() {
    // Release Global Audio Coordinator lock if held by hover preview
    releaseAudioLock();

    // 1. Immediately abort pending network fetches
    if (currentAbortController) {
      try {
        currentAbortController.abort();
      } catch {}
      currentAbortController = null;
    }

    // 2. Clear dwell timer
    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }

    // 3. Clear audio ramp
    if (audioRampTimer) {
      cancelAnimationFrame(audioRampTimer);
      audioRampTimer = null;
    }

    // 4. Halt, reset, and remove HTML5 video player from DOM
    if (currentActiveVideo) {
      try {
        currentActiveVideo.pause();
        currentActiveVideo.removeAttribute('src');
        currentActiveVideo.load();
        if (currentActiveVideo.parentNode) {
          currentActiveVideo.parentNode.removeChild(currentActiveVideo);
        }
      } catch {}
      currentActiveVideo = null;
    }

    // 5. Clear trickplay timer, animation frame & in-flight image
    if (activeTrickplayTimer) {
      clearInterval(activeTrickplayTimer);
      activeTrickplayTimer = null;
    }
    if (activeTrickplayAnimFrame) {
      cancelAnimationFrame(activeTrickplayAnimFrame);
      activeTrickplayAnimFrame = null;
    }
    if (activeTrickplayImg) {
      activeTrickplayImg.onload = null;
      activeTrickplayImg.onerror = null;
      activeTrickplayImg.src = '';
      activeTrickplayImg = null;
    }

    // 6. Unload YouTube iframe (about:blank) and remove from DOM
    if (currentActiveIframe) {
      try {
        currentActiveIframe.src = 'about:blank';
        currentActiveIframe.removeAttribute('src');
        if (currentActiveIframe.parentNode) {
          currentActiveIframe.parentNode.removeChild(currentActiveIframe);
        }
      } catch {}
      currentActiveIframe = null;
    }

    // 7. Clear media container DOM immediately
    if (portalElement) {
      const container = portalElement.querySelector('.hover-preview-media-container');
      if (container) {
        container.innerHTML = '';
      }
    }

    // 8. Hide portal with tracked timer to avoid race conditions
    if (portalHideTimer) {
      clearTimeout(portalHideTimer);
      portalHideTimer = null;
    }

    if (portalElement) {
      portalElement.classList.remove('active');
      portalElement.style.opacity = '0';
      portalElement.style.pointerEvents = 'none';
      portalElement.style.transform = 'scale(0.96) translateZ(0)';

      portalHideTimer = setTimeout(() => {
        portalHideTimer = null;
        if (!isPortalActive && portalElement) {
          portalElement.style.display = 'none';
          const container = portalElement.querySelector('.hover-preview-media-container');
          if (container) container.innerHTML = '';
        }
      }, 220);
    }

    candidateCard = null;
    candidateItemId = null;
    currentActiveCard = null;
    currentActiveItemId = null;
    isPortalActive = false;
    currentIsMuted = true;
  }

  // Alias teardownPreview to closePreview for backwards compatibility
  const teardownPreview = closePreview;

  function handleScroll() {
    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    if (isPortalActive || currentActiveVideo || currentActiveIframe || activeTrickplayTimer || currentAbortController) {
      closePreview();
    }
  }

  // --- INTENT & VELOCITY EVENT HANDLERS ---
  function onPointerEnter(card, e) {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
    if (e.pointerType === 'touch') return;

    const itemId = extractItemId(card);
    if (!itemId) return;

    // Avoid restarting dwell countdown if cursor is already hovering inside this exact card
    if (candidateCard === card && (dwellTimer || (isPortalActive && currentActiveItemId === itemId))) return;
    if (isPortalActive && currentActiveItemId === itemId) return;

    candidateCard = card;
    candidateItemId = itemId;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    lastPointerTime = performance.now();

    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }

    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      activatePreview(candidateCard, candidateItemId);
    }, DWELL_DELAY_MS);
  }

  function onPointerMove(card, e) {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
    if (e.pointerType === 'touch') return;

    if (!candidateCard || candidateCard !== card) {
      onPointerEnter(card, e);
      return;
    }

    const now = performance.now();
    const dt = now - lastPointerTime;
    if (dt > 16) {
      const dx = e.clientX - lastPointerX;
      const dy = e.clientY - lastPointerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const velocity = dist / dt;

      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      lastPointerTime = now;

      if (velocity > VELOCITY_THRESHOLD) {
        // High velocity (scrolling / sweeping) -> cancel intent
        if (dwellTimer) {
          clearTimeout(dwellTimer);
          dwellTimer = null;
        }
      } else {
        // Low velocity / stationary -> restart dwell countdown if idle
        if (!dwellTimer && !isPortalActive) {
          dwellTimer = setTimeout(() => {
            dwellTimer = null;
            activatePreview(candidateCard, candidateItemId);
          }, DWELL_DELAY_MS);
        }
      }
    }
  }

  function onPointerLeave(card, e) {
    const related = e.relatedTarget;
    // Don't teardown if pointer is moving between child elements inside the same card
    if (card && related && card.contains(related)) {
      return;
    }
    // Don't teardown if pointer is moving into the preview portal
    if (portalElement && related && portalElement.contains(related)) {
      return;
    }

    if (candidateCard === card) {
      candidateCard = null;
      candidateItemId = null;
    }

    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }

    if (isPortalActive && currentActiveCard === card) {
      closePreview();
    }
  }

  // --- GLOBAL LISTENERS & CAPTURE EVENT DELEGATION ---
  function registerGlobalListeners() {
    // High-performance document capture delegation guarantees 100% card detection across all views
    // without scanning or attaching listeners to container DOM elements.
    document.addEventListener(
      'mouseenter',
      (e) => {
        const card = e.target?.closest?.('.card, .cardBox, [data-id], .cardScalable');
        if (card) onPointerEnter(card, e);
      },
      true
    );

    document.addEventListener(
      'mousemove',
      (e) => {
        const card = e.target?.closest?.('.card, .cardBox, [data-id], .cardScalable');
        if (card) onPointerMove(card, e);
      },
      { passive: true, capture: true }
    );

    document.addEventListener(
      'mouseleave',
      (e) => {
        const card = e.target?.closest?.('.card, .cardBox, [data-id], .cardScalable');
        if (card) onPointerLeave(card, e);
      },
      true
    );

    document.addEventListener(
      'pointerleave',
      (e) => {
        const card = e.target?.closest?.('.card, .cardBox, [data-id], .cardScalable');
        if (card) onPointerLeave(card, e);
      },
      true
    );

    // Page scroll or window resize halts preview immediately
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });

    window.addEventListener('blur', () => {
      if (isPortalActive || dwellTimer) closePreview();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (isPortalActive || dwellTimer)) closePreview();
    });

    window.addEventListener('hashchange', closePreview);
    window.addEventListener('popstate', closePreview);
    document.addEventListener('viewshow', closePreview);
    document.addEventListener('viewbeforehide', closePreview);
    document.addEventListener('viewhide', closePreview);
    document.addEventListener('pagehide', closePreview);
    window.addEventListener('beforeunload', closePreview);
    document.addEventListener('playbackstart', closePreview);

    // Global Audio Coordinator listener: mute hover preview if another audio source claims lock
    window.addEventListener('jellyfin-audio-lock-acquired', (e) => {
      if (e.detail && e.detail.source !== 'hover' && isPortalActive) {
        currentIsMuted = true;
        if (currentActiveVideo && !currentActiveVideo.muted) {
          if (audioRampTimer) {
            cancelAnimationFrame(audioRampTimer);
            audioRampTimer = null;
          }
          currentActiveVideo.muted = true;
          currentActiveVideo.volume = 0;
          updateMuteButtonState(true, true);
        }
        if (currentActiveIframe?.contentWindow) {
          try {
            currentActiveIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'mute' }), '*');
            updateMuteButtonState(true, true);
          } catch {}
        }
      }
    });
  }

  // --- INITIALIZATION ---
  function init() {
    injectModuleStyles();
    ensurePortalExists();
    registerGlobalListeners();
    console.log('[HoverPreview] Card Hover Video Preview module successfully initialized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
