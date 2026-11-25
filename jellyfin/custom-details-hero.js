/**
 * Jellyfin Movie Details Video Hero Module
 * Architectural Component: Dynamic 16:9 Video Banner with Multi-Stop Vignette & Glassmorphism Controls
 *
 * Capabilities:
 *  1. Router Interceptor: SPA hashchange, popstate, history push/replaceState, and Jellyfin view lifecycle events.
 *  2. Media Resolver: Prioritized resolution across Local Trailers -> Theme Videos -> Remote Trailers (YouTube).
 *  3. Zero-Transcode Guarantee: Strict static=true direct stream for local trailers, never falling back to full movie item.
 *  4. Transparent Global YouTube Interceptor: Forces 1080p / 1440p playback quality on all window.YT.Player instances.
 *  5. Settle Delay: 600ms debounce to prevent spurious player spawning during rapid user navigation.
 *  6. Video Banner Injection: Dual-layer (Layer 0 4K Backdrop Poster, Layer 1 Video Player) with 16:9 aspect ratio.
 *  7. Multi-Container Selector: Searches .detailPageWrapperContainer, .detailPagePrimaryContainer, .detailRibbon, #itemDetailPage.
 *  8. Audio Management: Default unmuted (vol: 0.40) with gentle ramp & browser autoplay policy fallback.
 *  9. Floating Glass Speaker Button: 42x42px blur(8px) glassmorphism toggle at bottom-right.
 * 10. Multi-Stop Vignette: Deep theatrical dark vignette blending seamlessly into dx.bi #0b0b0d obsidian canvas.
 * 11. DOM Scavenger: Proactively clears rogue .pause-button elements from #slides-container.
 * 12. Lifecycle & Memory Safety: IntersectionObserver scroll auto-pause/resume and comprehensive teardown on exit.
 */

(function () {
  'use strict';

  if (window.__JELLYFIN_VIDEO_HERO_INITIALIZED__) {
    console.log('[VideoHero] Module already initialized, skipping duplicate execution.');
    return;
  }
  window.__JELLYFIN_VIDEO_HERO_INITIALIZED__ = true;

  // --- CONFIGURATION CONSTANTS ---
  const SETTLE_DELAY_MS = 600;
  const TARGET_VOLUME = 0.40;
  const AUDIO_RAMP_DURATION_MS = 800;
  const HERO_CONTAINER_ID = 'jellyfinDetailsVideoHero';
  const HERO_STYLES_ID = 'jellyfinDetailsVideoHeroStyles';
  const TRAILER_CACHE_PREFIX = 'jellyfin_tmdb_trailer_';
  const TRAILER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  function buildTmdbProxyUrl(tmdbPath, params = {}) {
    const proto = (typeof window !== 'undefined' && window.location && window.location.protocol) || 'http:';
    const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'localhost';
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        qs.set(key, String(value));
      }
    }
    const queryStr = qs.toString();
    return `${proto}//${host}:3000/api/tmdb/proxy?path=${encodeURIComponent(tmdbPath)}${queryStr ? `&${queryStr}` : ''}`;
  }

  const DETAIL_HERO_SELECTORS = [
    '.detailPageWrapperContainer',
    '.detailPagePrimaryContainer',
    '.detailRibbon',
    '#itemDetailPage'
  ];

  // SVG Icons for Glassmorphism Speaker Button
  const ICON_SPEAKER_UNMUTED = `
    <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    </svg>
  `;

  const ICON_SPEAKER_MUTED = `
    <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <line x1="23" y1="9" x2="17" y2="15"></line>
      <line x1="17" y1="9" x2="23" y2="15"></line>
    </svg>
  `;

  // --- STATE MANAGEMENT ---
  let settleTimer = null;
  let audioRampTimer = null;
  let ytAutoplayCheckTimer = null;
  let iframeReadyTimer = null;
  let currentAbortController = null;
  let intersectionObserver = null;

  let activeItemId = null;
  let currentMediaType = null; // 'local' | 'youtube' | 'backdrop_only' | null
  let currentHeroContainer = null;
  let activeVideoElement = null;
  let currentYtPlayer = null;
  let activeIframeElement = null;

  let isMuted = false;
  let mutedByAudioLock = false;
  let mutedByAutoplayPolicy = false;
  let isPausedByScroll = false;
  let isPlaybackActive = false;
  let ytApiPromise = null;

  // --- TASK 1: TRANSPARENT GLOBAL WINDOW.YT.PLAYER 1080P INTERCEPTOR ---
  function installGlobalYTInterceptor() {
    function wrapYT(yt) {
      if (!yt || !yt.Player || yt.Player.__is1080pInterceptor__) return;

      const OrigPlayer = yt.Player;

      function CustomYTPlayer(container, options) {
        const config = Object.assign({}, options || {});
        const screenW = window.innerWidth || window.screen?.width || 1920;
        const isUltraWide = screenW >= 2500;

        // Set explicit dimensions: 1920x1080 or 2560x1440 for wide displays
        config.width = isUltraWide ? 2560 : 1920;
        config.height = isUltraWide ? 1440 : 1080;

        // Force 1080p parameters
        config.playerVars = Object.assign({}, config.playerVars || {});
        config.playerVars.vq = 'hd1080';
        config.playerVars.suggestedQuality = 'hd1080';

        // Chain onReady
        const events = Object.assign({}, config.events || {});
        const origOnReady = events.onReady;
        events.onReady = function (event) {
          try {
            event.target?.setPlaybackQuality?.('hd1080');
            event.target?.setPlaybackQualityRange?.('hd1080', 'hd1440');
          } catch (e) {
            console.warn('[VideoHeroInterceptor] onReady setPlaybackQuality error:', e);
          }
          if (typeof origOnReady === 'function') {
            return origOnReady.apply(this, arguments);
          }
        };

        // Chain onStateChange: when state === 1 (PLAYING), enforce hd1080
        const origOnStateChange = events.onStateChange;
        events.onStateChange = function (event) {
          try {
            const ytState = window.YT?.PlayerState || yt.PlayerState;
            const playingCode = ytState?.PLAYING !== undefined ? ytState.PLAYING : 1;
            const state = (typeof event?.data === 'number') ? event.data : event?.target?.getPlayerState?.();
            if (state === playingCode) {
              event.target?.setPlaybackQuality?.('hd1080');
              event.target?.setPlaybackQualityRange?.('hd1080', 'hd1440');
            }
          } catch (e) {
            console.warn('[VideoHeroInterceptor] onStateChange setPlaybackQuality error:', e);
          }
          if (typeof origOnStateChange === 'function') {
            return origOnStateChange.apply(this, arguments);
          }
        };
        config.events = events;

        // Construct player instance
        const instance = new OrigPlayer(container, config);

        // Wrap returned player's loadVideoById: ensure { ...args, suggestedQuality: 'hd1080' } is passed
        const wrapLoadVideoMethod = (targetObj) => {
          if (!targetObj) return;
          const origLoad = targetObj.loadVideoById;
          if (typeof origLoad === 'function' && !targetObj.__loadVideoById1080pWrapped__) {
            targetObj.loadVideoById = function (args, ...rest) {
              let wrappedArgs = args;
              if (typeof args === 'string') {
                wrappedArgs = {
                  videoId: args,
                  startSeconds: (typeof rest[0] === 'number') ? rest[0] : 0,
                  suggestedQuality: 'hd1080'
                };
              } else if (args && typeof args === 'object') {
                wrappedArgs = Object.assign({}, args, { suggestedQuality: 'hd1080' });
              }
              return origLoad.call(this, wrappedArgs, ...rest);
            };
            targetObj.__loadVideoById1080pWrapped__ = true;
          }
        };

        wrapLoadVideoMethod(instance);
        wrapLoadVideoMethod(this);

        return instance;
      }

      CustomYTPlayer.prototype = OrigPlayer.prototype;
      Object.setPrototypeOf(CustomYTPlayer, OrigPlayer);
      CustomYTPlayer.__is1080pInterceptor__ = true;

      // Wrap prototype loadVideoById for defense in depth
      if (OrigPlayer.prototype && typeof OrigPlayer.prototype.loadVideoById === 'function' && !OrigPlayer.prototype.loadVideoById.__wrapped1080p__) {
        const origProtoLoad = OrigPlayer.prototype.loadVideoById;
        OrigPlayer.prototype.loadVideoById = function (args, ...rest) {
          let wrappedArgs = args;
          if (typeof args === 'string') {
            wrappedArgs = {
              videoId: args,
              startSeconds: (typeof rest[0] === 'number') ? rest[0] : 0,
              suggestedQuality: 'hd1080'
            };
          } else if (args && typeof args === 'object') {
            wrappedArgs = Object.assign({}, args, { suggestedQuality: 'hd1080' });
          }
          return origProtoLoad.call(this, wrappedArgs, ...rest);
        };
        OrigPlayer.prototype.loadVideoById.__wrapped1080p__ = true;
      }

      // Copy static properties
      Object.getOwnPropertyNames(OrigPlayer).forEach((key) => {
        if (key !== 'prototype' && key !== 'name' && key !== 'length') {
          try {
            const desc = Object.getOwnPropertyDescriptor(OrigPlayer, key);
            if (desc) Object.defineProperty(CustomYTPlayer, key, desc);
          } catch {}
        }
      });

      yt.Player = CustomYTPlayer;
      console.log('[VideoHero] Transparent global window.YT.Player 1080p interceptor installed.');
    }

    if (window.YT && window.YT.Player) {
      wrapYT(window.YT);
    }

    // Hook window.YT setter / getter
    try {
      let _rawYT = window.YT;
      Object.defineProperty(window, 'YT', {
        configurable: true,
        enumerable: true,
        get() {
          return _rawYT;
        },
        set(newYT) {
          _rawYT = newYT;
          if (newYT && typeof newYT === 'object') {
            if (newYT.Player) {
              wrapYT(newYT);
            } else {
              let _rawPlayer = newYT.Player;
              try {
                Object.defineProperty(newYT, 'Player', {
                  configurable: true,
                  enumerable: true,
                  get() {
                    return _rawPlayer;
                  },
                  set(p) {
                    _rawPlayer = p;
                    wrapYT(newYT);
                  }
                });
              } catch {}
            }
          }
        }
      });
    } catch {}

    // Hook window.onYouTubeIframeAPIReady callback
    const origApiReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (window.YT) {
        wrapYT(window.YT);
      }
      if (typeof origApiReady === 'function') {
        try { origApiReady.apply(this, arguments); } catch {}
      }
    };

    // Watchdog polling for early initialization
    const checkTimer = setInterval(() => {
      if (window.YT && window.YT.Player) {
        wrapYT(window.YT);
        if (window.YT.Player.__is1080pInterceptor__) {
          clearInterval(checkTimer);
        }
      }
    }, 100);
    setTimeout(() => clearInterval(checkTimer), 10000);
  }

  // Install interceptor immediately
  installGlobalYTInterceptor();

  // --- TASK 6: DOM SCAVENGER FOR ROGUE PAUSE BUTTONS ---
  function scavengePauseButtons() {
    try {
      const pauseButtons = document.querySelectorAll(
        '#slides-container .pause-button, .slides-container .pause-button, #slides-container button.pause-button, [data-slideshow] .pause-button'
      );
      pauseButtons.forEach((btn) => {
        try {
          btn.remove();
          console.log('[VideoHero] Scavenged and removed pause-button from #slides-container.');
        } catch {}
      });
    } catch {}
  }

  // --- GLOBAL AUDIO COORDINATOR INTEGRATION ---
  function acquireAudioLock(source = 'hero') {
    try {
      window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ = source;
      if (typeof window.__JELLYFIN_AUDIO_LOCK__ === 'object' && window.__JELLYFIN_AUDIO_LOCK__ !== null) {
        if (typeof window.__JELLYFIN_AUDIO_LOCK__.acquire === 'function') {
          window.__JELLYFIN_AUDIO_LOCK__.acquire(source);
        } else if (typeof window.__JELLYFIN_AUDIO_LOCK__.setLock === 'function') {
          window.__JELLYFIN_AUDIO_LOCK__.setLock(source);
        } else if (typeof window.__JELLYFIN_AUDIO_LOCK__.requestLock === 'function') {
          window.__JELLYFIN_AUDIO_LOCK__.requestLock(source);
        }
      } else {
        window.__JELLYFIN_AUDIO_LOCK__ = source;
      }
      window.dispatchEvent(new CustomEvent('jellyfin-audio-lock-acquired', { detail: { source } }));
    } catch {}
  }

  function releaseAudioLock(source = 'hero') {
    try {
      const active = window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__;
      if (!source || active === source || (source === 'hero' && (active === 'hero' || active === 'home-hero' || active === 'details-hero')) || (source === 'home-hero' && (active === 'home-hero' || active === 'hero' || active === 'mediabar'))) {
        window.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ = null;
        if (typeof window.__JELLYFIN_AUDIO_LOCK__ === 'object' && window.__JELLYFIN_AUDIO_LOCK__ !== null) {
          if (typeof window.__JELLYFIN_AUDIO_LOCK__.release === 'function') {
            window.__JELLYFIN_AUDIO_LOCK__.release(active || source);
          } else if (typeof window.__JELLYFIN_AUDIO_LOCK__.releaseLock === 'function') {
            window.__JELLYFIN_AUDIO_LOCK__.releaseLock(active || source);
          }
        } else if (window.__JELLYFIN_AUDIO_LOCK__ === active || window.__JELLYFIN_AUDIO_LOCK__ === true) {
          window.__JELLYFIN_AUDIO_LOCK__ = null;
        }
        window.dispatchEvent(new CustomEvent('jellyfin-audio-lock-released', { detail: { source: active || source } }));
      }
    } catch {}
  }

  // --- STYLESHEET INJECTION ---
  function injectModuleStyles() {
    if (document.getElementById(HERO_STYLES_ID)) return;

    const styleEl = document.createElement('style');
    styleEl.id = HERO_STYLES_ID;
    styleEl.textContent = `
      /* ── Video Hero Container (Theatrical In-Flow Stage) ── */
      .jellyfin-details-video-hero {
        position: relative !important;
        width: 100% !important;
        height: 52vh !important;
        min-height: 380px !important;
        max-height: 620px !important;
        background-color: #0b0b0d !important;
        overflow: hidden !important;
        margin: 0 !important;
        z-index: 2 !important;
        box-sizing: border-box !important;
        pointer-events: auto !important;
      }

      @media (max-width: 768px) {
        .jellyfin-details-video-hero {
          position: relative !important;
          width: 100% !important;
          height: auto !important;
          aspect-ratio: 16 / 9 !important;
          max-height: 48vh !important;
          min-height: 200px !important;
          pointer-events: auto !important;
        }
      }

      /* ── #itemBackdrop Total Collapse (Zero Space in Layout Flow) ── */
      #itemDetailPage.has-video-hero #itemBackdrop {
        display: none !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* ── Foreground Wrapper Containers & Elevation ── */
      #itemDetailPage.has-video-hero {
        position: relative !important;
      }

      #itemDetailPage.has-video-hero .detailPageWrapperContainer {
        position: relative !important;
        padding-top: 0 !important;
        margin-top: 0 !important;
        background: transparent !important;
      }

      #itemDetailPage.has-video-hero .detailPagePrimaryContainer {
        position: relative !important;
        background: transparent !important;
        display: flex !important;
        flex-direction: column !important;
      }

      #itemDetailPage.has-video-hero .detailRibbon {
        position: relative !important;
        z-index: 5 !important;
        min-height: auto !important;
        max-height: none !important;
        height: auto !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: flex-start !important;
        align-items: flex-start !important;
        text-align: left !important;
        padding-top: 1rem !important;
        padding-bottom: 2rem !important;
        padding-left: max(env(safe-area-inset-left), 4%) !important;
        padding-right: max(env(safe-area-inset-right), 4%) !important;
        background: transparent !important;
        box-sizing: border-box !important;
        margin-top: 0 !important;
        pointer-events: auto !important;
      }

      #itemDetailPage.has-video-hero .infoWrapper {
        max-width: min(780px, 65vw) !important;
        z-index: 5 !important;
      }

      /* Stylish Big Title Typography (dx.bi Inter Hierarchy - Never Overlapping Trailer) */
      #itemDetailPage.has-video-hero .nameContainer h1.itemName,
      #itemDetailPage.has-video-hero .nameContainer h1.parentName,
      #itemDetailPage.has-video-hero .nameContainer h1.parentNameLast,
      #itemDetailPage.has-video-hero h1.itemName {
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif !important;
        font-size: clamp(2.2rem, 3.8vw, 3.4rem) !important;
        font-weight: 800 !important;
        letter-spacing: -0.025em !important;
        line-height: 1.15 !important;
        color: #FFFFFF !important;
        text-shadow: 0 2px 14px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.95) !important;
        margin: 0.25rem 0 0.75rem 0 !important;
        padding: 0 !important;
        word-break: break-word !important;
        max-width: 100% !important;
      }

      /* ClearLogo Integration */
      #itemDetailPage.has-video-hero .detailLogo {
        position: relative !important;
        top: auto !important;
        bottom: auto !important;
        left: auto !important;
        transform: none !important;
        margin: 0 0 0.75rem 0 !important;
        width: min(380px, 50vw) !important;
        height: clamp(60px, 12vh, 120px) !important;
        background-position: left center !important;
        background-size: contain !important;
        background-repeat: no-repeat !important;
        z-index: 6 !important;
        filter: drop-shadow(0 4px 16px rgba(0, 0, 0, 0.85)) !important;
        pointer-events: none !important;
      }

      @media (max-width: 768px) {
        #itemDetailPage.has-video-hero .detailRibbon {
          min-height: auto !important;
          max-height: none !important;
          padding-top: 0.75rem !important;
          padding-bottom: 1.5rem !important;
        }

        #itemDetailPage.has-video-hero .infoWrapper {
          max-width: 100% !important;
        }

        #itemDetailPage.has-video-hero .detailLogo {
          position: relative !important;
          bottom: auto !important;
          left: auto !important;
          width: min(280px, 70vw) !important;
          height: clamp(60px, 10vh, 100px) !important;
          margin-bottom: 0.75rem !important;
        }

        #itemDetailPage.has-video-hero .nameContainer h1.itemName,
        #itemDetailPage.has-video-hero .nameContainer h1.parentName,
        #itemDetailPage.has-video-hero .nameContainer h1.parentNameLast,
        #itemDetailPage.has-video-hero h1.itemName {
          font-size: clamp(1.6rem, 6vw, 2.4rem) !important;
        }
      }

      /* ── Layer 0: Static Backdrop Poster ── */
      .jellyfin-hero-layer-backdrop {
        position: absolute;
        inset: 0;
        background-size: cover;
        background-position: center 25%;
        background-repeat: no-repeat;
        z-index: 1;
        transform: scale(1.02);
        transition: opacity 0.9s cubic-bezier(0.25, 1, 0.5, 1);
        will-change: opacity;
      }

      /* ── Layer 1: Video Player Layer ── */
      .jellyfin-hero-layer-media {
        position: absolute;
        inset: 0;
        z-index: 2;
        overflow: hidden;
        opacity: 0;
        transition: opacity 0.9s cubic-bezier(0.25, 1, 0.5, 1);
        will-change: opacity;
      }

      .jellyfin-hero-layer-media.is-active {
        opacity: 1 !important;
      }

      .jellyfin-hero-html5-video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      /* Headless YouTube Iframe Viewport Scale & Masking */
      .jellyfin-hero-youtube-viewport {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 130%;
        height: 130%;
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .jellyfin-hero-youtube-viewport iframe {
        width: 100%;
        height: 100%;
        border: 0;
        pointer-events: none;
      }

      /* ── Layer 2: Cinema Screen Vignette with Bottom Gradient Fade ── */
      .jellyfin-hero-vignette-overlay {
        position: absolute !important;
        inset: 0 !important;
        pointer-events: none !important;
        z-index: 3 !important;
        background:
          linear-gradient(180deg, rgba(11, 11, 13, 0.45) 0%, transparent 18%, transparent 65%, rgba(11, 11, 13, 0.86) 90%, #0b0b0d 100%),
          linear-gradient(90deg, rgba(11, 11, 13, 0.42) 0%, transparent 12%, transparent 88%, rgba(11, 11, 13, 0.42) 100%) !important;
      }

      /* ── dx.bi Detail Ribbon Action Buttons &amp; Pill Badges ── */
      #itemDetailPage.has-video-hero .btnPlay,
      #itemDetailPage.has-video-hero .btnPlay.detailButton {
        background-color: #ffffff !important;
        color: #000000 !important;
        border: 1px solid #ffffff !important;
        border-radius: 9999px !important;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif !important;
        font-weight: 700 !important;
      }

      #itemDetailPage.has-video-hero .btnPlay .material-icons,
      #itemDetailPage.has-video-hero .btnPlay svg {
        color: #000000 !important;
        fill: #000000 !important;
      }

      #itemDetailPage.has-video-hero .btnPlay:hover {
        background-color: rgba(255, 255, 255, 0.85) !important;
      }

      #itemDetailPage.has-video-hero .detailButton:not(.btnPlay) {
        background-color: #212128 !important;
        color: #f4f4f5 !important;
        border: 1px solid rgba(255, 255, 255, 0.16) !important;
        border-radius: 9999px !important;
      }

      #itemDetailPage.has-video-hero .detailButton:not(.btnPlay):hover {
        background-color: #2b2b33 !important;
        border-color: rgba(255, 255, 255, 0.42) !important;
      }

      #itemDetailPage.has-video-hero .mediaInfoItem {
        background: rgba(24, 24, 29, 0.82) !important;
        border: 1px solid rgba(255, 255, 255, 0.16) !important;
        color: #f4f4f5 !important;
      }

      /* ── Layer 3: Floating Glass Speaker Button (Bottom Right) ── */
      .jellyfin-hero-speaker-btn {
        position: absolute !important;
        bottom: 24px !important;
        right: 28px !important;
        top: auto !important;
        left: auto !important;
        width: 44px !important;
        height: 44px !important;
        border-radius: 50% !important;
        background: rgba(19, 19, 23, 0.78) !important;
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        border: 1px solid rgba(255, 255, 255, 0.22) !important;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.75), 0 0 1px rgba(255, 255, 255, 0.16) !important;
        color: #ffffff !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        z-index: 50 !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 0;
        margin: 0;
        outline: none;
        transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
                    background-color 0.22s ease,
                    border-color 0.22s ease,
                    box-shadow 0.22s ease !important;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }

      .jellyfin-hero-speaker-btn:hover {
        transform: scale(1.10) !important;
        background: #e50914 !important;
        border-color: #e50914 !important;
        box-shadow: 0 4px 22px rgba(229, 9, 20, 0.60), 0 0 2px rgba(255, 255, 255, 0.45) !important;
      }

      .jellyfin-hero-speaker-btn:not(.is-muted) {
        border-color: rgba(229, 9, 20, 0.8) !important;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.75), 0 0 12px rgba(229, 9, 20, 0.38) !important;
      }

      .jellyfin-hero-speaker-btn:active {
        transform: scale(0.92);
      }

      .jellyfin-hero-speaker-btn svg {
        display: block;
        transition: transform 0.15s ease;
      }

      @media (max-width: 768px) {
        .jellyfin-hero-speaker-btn {
          bottom: 14px !important;
          right: 14px !important;
          top: auto !important;
          left: auto !important;
          width: 38px !important;
          height: 38px !important;
        }
        .jellyfin-hero-speaker-btn svg {
          width: 18px;
          height: 18px;
        }
      }
    `;
    document.head.appendChild(styleEl);
  }

  // --- API CLIENT & USER HELPERS ---
  function getApiClient() {
    if (window.ApiClient) return window.ApiClient;
    if (window.Emby?.ApiClient) return window.Emby.ApiClient;
    if (window.ConnectionManager && typeof window.ConnectionManager.getApiClient === 'function') {
      return window.ConnectionManager.getApiClient();
    }
    return null;
  }

  function waitForApiClient(timeoutMs = 6000, signal = null) {
    return new Promise((resolve) => {
      const client = getApiClient();
      if (client || signal?.aborted) return resolve(client);

      const startTime = Date.now();
      const interval = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(interval);
          resolve(null);
          return;
        }
        const c = getApiClient();
        if (c || Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(c);
        }
      }, 100);

      signal?.addEventListener('abort', () => {
        clearInterval(interval);
        resolve(null);
      }, { once: true });
    });
  }

  function getCurrentUserId(apiClient) {
    if (!apiClient) return null;
    if (typeof apiClient.getCurrentUserId === 'function') {
      const uid = apiClient.getCurrentUserId();
      if (uid) return uid;
    }
    if (apiClient._serverInfo && apiClient._serverInfo.UserId) {
      return apiClient._serverInfo.UserId;
    }
    if (apiClient._currentUserId) {
      return apiClient._currentUserId;
    }
    try {
      const stored = localStorage.getItem('jellyfin_credentials');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.Servers?.[0]?.UserId) return parsed.Servers[0].UserId;
      }
    } catch {}
    return null;
  }

  function getAuthToken(apiClient) {
    if (!apiClient) return '';
    if (typeof apiClient.accessToken === 'function') {
      return apiClient.accessToken() || '';
    }
    if (typeof apiClient.accessToken === 'string') {
      return apiClient.accessToken;
    }
    return '';
  }

  // Forensic Jellyfin 12.2 Authentication Header Builder
  function getAuthHeaders(apiClient) {
    const headers = {};
    const token = getAuthToken(apiClient);
    if (token) {
      headers['X-Emby-Token'] = token;
      const clientName = (typeof apiClient?.appName === 'function' ? apiClient.appName() : null) || 'Jellyfin Web';
      const deviceName = (typeof apiClient?.deviceName === 'function' ? apiClient.deviceName() : null) || 'Web';
      const deviceId = (typeof apiClient?.deviceId === 'function' ? apiClient.deviceId() : null) || '1';
      const version = (typeof apiClient?.appVersion === 'function' ? apiClient.appVersion() : null) || '12.2.0';
      headers['Authorization'] = `MediaBrowser Client="${clientName}", Device="${deviceName}", DeviceId="${deviceId}", Version="${version}", Token="${token}"`;
    }
    return headers;
  }

  // --- MUTUAL EXCLUSION: HOME SCREEN SLIDESHOW HALT ---
  function stopHomeScreenSlideshow() {
    try {
      scavengePauseButtons();

      const slidesContainers = document.querySelectorAll(
        '#slides-container, .slides-container, #mediaBar, .media-bar, .mediaBar, [data-slideshow]'
      );

      slidesContainers.forEach((container) => {
        const videos = container.querySelectorAll('video');
        videos.forEach((vid) => {
          try {
            vid.pause();
            vid.muted = true;
            vid.volume = 0;
            vid.removeAttribute('src');
            vid.load();
          } catch {
            try { vid.pause(); vid.muted = true; } catch {}
          }
        });

        const iframes = container.querySelectorAll('iframe');
        iframes.forEach((iframe) => {
          try {
            if (iframe.contentWindow) {
              iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
              iframe.contentWindow.postMessage('{"event":"command","func":"stopVideo","args":""}', '*');
              iframe.contentWindow.postMessage('{"event":"command","func":"mute","args":""}', '*');
            }
            if (iframe.src && iframe.src !== 'about:blank') {
              iframe.setAttribute('data-original-src', iframe.src);
              iframe.src = 'about:blank';
            }
          } catch {}
        });
      });

      const homeMedia = document.querySelectorAll(
        '#homePage video, .homePage video, #slides-container video, .homeSectionsContainer video'
      );
      homeMedia.forEach((vid) => {
        try {
          vid.pause();
          vid.muted = true;
          vid.volume = 0;
        } catch {}
      });
    } catch (err) {
      console.warn('[VideoHero] Error stopping home screen slideshow:', err);
    }
  }

  // --- DOM & ROUTING UTILITIES ---
  function isDetailsRoute() {
    const hash = window.location.hash || '';
    const pathname = window.location.pathname || '';
    const search = window.location.search || '';

    // Jellyfin router hash patterns: #/details?id=xxx, #!/details?id=xxx, #/item?id=xxx, #!/item?id=xxx
    const isDetailsHash = /^#\/?!?\/?(details|item|items|itemDetailPage)(\.html)?(?=[\/?&#]|$)/i.test(hash);

    const isOtherExplicitRoute = /^#\/?!?\/?(home|video|playback|movies|tv|music|channels|livetv|search|settings|dashboard)\b/i.test(hash);
    if (isOtherExplicitRoute && !isDetailsHash) {
      return false;
    }

    const isDetailsPath = /\/(?:details|item|items)(\.html)?\b/i.test(pathname) && /[?&](?:id|itemId)=[a-f0-9]+/i.test(search);

    const activeDetailPage = document.querySelector(
      '#itemDetailPage:not(.hide):not([style*="display: none"]), .itemDetailPage:not(.hide):not([style*="display: none"])'
    );
    const activeDetailWrapper = document.querySelector(
      '.detailPageWrapperContainer:not(.hide):not([style*="display: none"]), ' +
      '.detailPagePrimaryContainer:not(.hide):not([style*="display: none"]), ' +
      '.detailRibbon:not(.hide):not([style*="display: none"])'
    );

    const isDomActive = (activeDetailPage && !activeDetailPage.closest('.hide, [style*="display: none"]')) ||
                        (activeDetailWrapper && !activeDetailWrapper.closest('.hide, [style*="display: none"]'));

    return isDetailsHash || isDetailsPath || !!isDomActive;
  }

  function extractItemId() {
    const hash = window.location.hash || '';
    const search = window.location.search || '';

    // 1. URL parameters in hash: #/details?id=... or #!/details?id=...
    const qIndex = hash.indexOf('?');
    if (qIndex !== -1) {
      const params = new URLSearchParams(hash.substring(qIndex));
      const id = params.get('id') || params.get('itemId');
      if (id) return id;
    }

    // 2. window.location.search: ?id=...
    if (search) {
      const searchParams = new URLSearchParams(search);
      const searchId = searchParams.get('id') || searchParams.get('itemId');
      if (searchId) return searchId;
    }

    // 3. Path parameter: #/details/123456...
    const pathMatch = hash.match(/#\/?!?\/?(?:details|item|items)\/([a-f0-9]{32})/i);
    if (pathMatch && pathMatch[1]) return pathMatch[1];

    // 4. DOM active item page attributes
    const activePage = document.querySelector(
      '#itemDetailPage:not(.hide):not([style*="display: none"]), ' +
      '.itemDetailPage:not(.hide):not([style*="display: none"]), ' +
      '.detailPageWrapperContainer:not(.hide):not([style*="display: none"]), ' +
      '.detailPagePrimaryContainer:not(.hide):not([style*="display: none"]), ' +
      '.detailRibbon:not(.hide):not([style*="display: none"])'
    );
    if (activePage && !activePage.closest('.hide, [style*="display: none"]')) {
      const domId = activePage.getAttribute('data-itemid') ||
                    activePage.getAttribute('data-id') ||
                    activePage.dataset.itemid ||
                    activePage.dataset.id;
      if (domId) return domId;
    }

    return null;
  }

  // --- TASK 7: MULTI-CONTAINER SELECTOR FOR DETAILS HERO INJECTION ---
  function findActiveDetailWrapper() {
    // 1. Look inside active (non-hidden) detail page
    const activePage = document.querySelector(
      '#itemDetailPage:not(.hide):not([style*="display: none"]), .itemDetailPage:not(.hide):not([style*="display: none"])'
    );
    if (activePage && !activePage.closest('.hide, [style*="display: none"]')) {
      for (const sel of DETAIL_HERO_SELECTORS) {
        if (sel === '#itemDetailPage') {
          return activePage;
        }
        const candidate = activePage.querySelector(`${sel}:not(.hide):not([style*="display: none"])`) || activePage.querySelector(sel);
        if (candidate && !candidate.closest('.hide, [style*="display: none"]')) {
          return candidate;
        }
      }
    }

    // 2. Global search across target selectors not inside a hidden container
    for (const sel of DETAIL_HERO_SELECTORS) {
      const all = document.querySelectorAll(`${sel}:not(.hide):not([style*="display: none"])`);
      for (const el of all) {
        if (!el.closest('.hide, [style*="display: none"]')) {
          return el;
        }
      }
    }

    return null;
  }

  function waitForActiveDetailWrapper(timeoutMs = 3500, signal = null) {
    return new Promise((resolve) => {
      const el = findActiveDetailWrapper();
      if (el || signal?.aborted) return resolve(el);

      const targetRoot = document.getElementById('mainContent') ||
                         document.querySelector('.mainAnimatedPages') ||
                         document.body ||
                         document.documentElement;
      let observer = null;
      let timer = null;

      const cleanup = () => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      observer = new MutationObserver(() => {
        if (signal?.aborted) {
          cleanup();
          resolve(null);
          return;
        }
        const target = findActiveDetailWrapper();
        if (target) {
          cleanup();
          resolve(target);
        }
      });

      // ChildList only to prevent MutationObserver storms
      observer.observe(targetRoot, {
        childList: true,
        subtree: true
      });

      timer = setTimeout(() => {
        cleanup();
        resolve(findActiveDetailWrapper());
      }, timeoutMs);

      signal?.addEventListener('abort', () => {
        cleanup();
        resolve(null);
      }, { once: true });
    });
  }

  // --- TASK 3: SESSIONSTORAGE CACHING FOR RESOLVED TRAILERS (24H TTL) ---
  function getCachedTrailer(itemId) {
    if (!itemId) return null;
    try {
      const raw = sessionStorage.getItem(`${TRAILER_CACHE_PREFIX}${itemId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.timestamp && (Date.now() - parsed.timestamp < TRAILER_CACHE_TTL_MS)) {
        return parsed.youtubeId || null;
      }
    } catch {}
    return null;
  }

  function setCachedTrailer(itemId, youtubeId) {
    if (!itemId || !youtubeId) return;
    try {
      sessionStorage.setItem(`${TRAILER_CACHE_PREFIX}${itemId}`, JSON.stringify({
        youtubeId: youtubeId,
        timestamp: Date.now()
      }));
    } catch {}
  }

  function extractYouTubeId(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const match = trimmed.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})/i);
    return (match && match[1]) ? match[1] : null;
  }

  // --- TASK 5: LOCAL VIDEO STREAM ZERO-TRANSCODE GUARANTEE ---
  function buildVideoStreamUrl(apiClient, videoItemId) {
    const token = getAuthToken(apiClient);
    const tokenParam = token ? `&api_key=${encodeURIComponent(token)}` : '';
    // Zero-transcode: static=true strictly present in stream URL along with api_key
    return apiClient.getUrl(`Videos/${videoItemId}/stream.mp4?static=true${tokenParam}`);
  }

  // --- TASK 4: 4K DYNAMIC BACKDROP SCALING (QUALITY 95) ---
  function buildBackdropImageUrl(apiClient, itemId, item) {
    const token = getAuthToken(apiClient);
    const tokenParam = token ? `&api_key=${encodeURIComponent(token)}` : '';
    const maxW = Math.min(3840, Math.max(1920, Math.round(window.innerWidth * (window.devicePixelRatio || 1))));

    if (item?.BackdropImageTags?.length > 0) {
      const tag = item.BackdropImageTags[0];
      return apiClient.getUrl(`Items/${itemId}/Images/Backdrop/0?tag=${encodeURIComponent(tag)}&maxWidth=${maxW}&quality=95${tokenParam}`);
    }
    if (item?.ImageTags?.Primary) {
      const tag = item.ImageTags.Primary;
      return apiClient.getUrl(`Items/${itemId}/Images/Primary?tag=${encodeURIComponent(tag)}&maxWidth=${maxW}&quality=95${tokenParam}`);
    }
    return apiClient.getUrl(`Items/${itemId}/Images/Backdrop/0?maxWidth=${maxW}&quality=95${tokenParam}`);
  }

  async function fetchItemDetails(apiClient, userId, itemId, signal) {
    const headers = getAuthHeaders(apiClient);
    let item = null;

    try {
      const userUrl = apiClient.getUrl("Users/" + userId + "/Items/" + itemId + "?Fields=RemoteTrailers,MediaSources,Overview,Genres,ProviderIds,BackdropImageTags");
      const res = await fetch(userUrl, { headers, signal });
      if (res.ok) {
        item = await res.json();
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[VideoHero] Failed to fetch item details via Users endpoint:', err);
    }

    if (!item || !item.RemoteTrailers || item.RemoteTrailers.length === 0) {
      try {
        const fallbackUrl = apiClient.getUrl("Items/" + itemId + "?Fields=RemoteTrailers,MediaSources,Overview,Genres,ProviderIds,BackdropImageTags");
        const fallbackRes = await fetch(fallbackUrl, { headers, signal });
        if (fallbackRes.ok) {
          const fallbackItem = await fallbackRes.json();
          item = item ? { ...item, ...fallbackItem, RemoteTrailers: fallbackItem.RemoteTrailers || item.RemoteTrailers } : fallbackItem;
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn('[VideoHero] Failed to fetch item details via fallback Items endpoint:', err);
      }
    }

    return item;
  }

  async function fetchLocalTrailers(apiClient, userId, itemId, signal) {
    const headers = getAuthHeaders(apiClient);

    const sanitizeTrailers = (items) => {
      if (!Array.isArray(items)) return [];
      // ZERO-TRANSCODE GUARANTEE: Never include the main movie item itself!
      return items.filter((t) => t && t.Id && t.Id !== itemId);
    };

    try {
      const url = apiClient.getUrl(`Users/${userId}/Items/${itemId}/LocalTrailers`);
      const res = await fetch(url, { headers, signal });
      if (res.ok) {
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data?.Items || []);
        const sanitized = sanitizeTrailers(items);
        if (sanitized.length > 0) return sanitized;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }

    try {
      const fallbackUrl = apiClient.getUrl(`Items/${itemId}/LocalTrailers`);
      const res = await fetch(fallbackUrl, { headers, signal });
      if (res.ok) {
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data?.Items || []);
        return sanitizeTrailers(items);
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }

    return [];
  }

  async function fetchThemeVideos(apiClient, itemId, signal) {
    const headers = getAuthHeaders(apiClient);

    const sanitizeVideos = (items) => {
      if (!Array.isArray(items)) return [];
      // Never stream main movie item
      return items.filter((tv) => tv && tv.Id && tv.Id !== itemId);
    };

    try {
      const url = apiClient.getUrl(`Items/${itemId}/ThemeVideos`);
      const res = await fetch(url, { headers, signal });
      if (!res.ok) return [];
      const data = await res.json();
      const items = Array.isArray(data) ? data : (data?.Items || []);
      return sanitizeVideos(items);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return [];
    }
  }

  // --- TASK 3: TMDB TRAILER RESOLVER (MOVIES & TV SERIES WITH MULTI-LANGUAGE) ---
  async function fetchTmdbTrailer(tmdbId, itemType, signal) {
    if (!tmdbId) return null;
    const isTv = itemType === 'Series' || itemType === 'Season' || itemType === 'Episode' || itemType === 'tv';
    const primaryType = isTv ? 'tv' : 'movie';
    const secondaryType = isTv ? 'movie' : 'tv';

    const tryFetchVideos = async (type) => {
      try {
        const url = buildTmdbProxyUrl(`${type}/${encodeURIComponent(tmdbId)}/videos`, {
          include_video_language: 'hi,en,ko,ja,es,fr,null'
        });
        const res = await fetch(url, { signal });
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
            else s += 20;
            if (v.official) s += 20;
            if (v.iso_639_1 === 'en') s += 5;
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

  async function searchTmdb(title, year, itemType, signal) {
    if (!title) return null;
    const isTv = itemType === 'Series' || itemType === 'Season' || itemType === 'Episode' || itemType === 'tv';
    const cleanTitle = title.trim();

    const trySearch = async (endpoint, useYear) => {
      try {
        const params = { query: cleanTitle };
        if (useYear && year) {
          if (endpoint === 'tv') {
            params.first_air_date_year = year;
          } else {
            params.year = year;
          }
        }
        const url = buildTmdbProxyUrl(`search/${endpoint}`, params);
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        const data = await res.json();
        if (data?.results?.length > 0) {
          return {
            id: data.results[0].id,
            type: endpoint
          };
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }
      return null;
    };

    if (isTv) {
      let match = await trySearch('tv', true);
      if (match) return match;
      match = await trySearch('tv', false);
      if (match) return match;
      match = await trySearch('movie', true);
      if (match) return match;
      return await trySearch('movie', false);
    } else {
      let match = await trySearch('movie', true);
      if (match) return match;
      match = await trySearch('movie', false);
      if (match) return match;
      match = await trySearch('tv', true);
      if (match) return match;
      return await trySearch('tv', false);
    }
  }

  async function resolveHeroMedia(apiClient, userId, itemId, signal) {
    // 1. Fetch Item metadata (provides Backdrop tags, RemoteTrailers, ProviderIds)
    const item = await fetchItemDetails(apiClient, userId, itemId, signal);
    if (!item) return null;

    const backdropUrl = buildBackdropImageUrl(apiClient, itemId, item);

    // 2. Priority 1: Check Local Trailers (Zero-transcode guarantee: never fall back to main movie item)
    let localTrailers = (item.LocalTrailers && item.LocalTrailers.length > 0)
      ? item.LocalTrailers.filter((t) => t && t.Id && t.Id !== itemId)
      : null;
    if (!localTrailers || localTrailers.length === 0) {
      localTrailers = await fetchLocalTrailers(apiClient, userId, itemId, signal);
    }
    if (localTrailers && localTrailers.length > 0) {
      const trailer = localTrailers[0];
      if (trailer && trailer.Id && trailer.Id !== itemId) {
        const streamUrl = buildVideoStreamUrl(apiClient, trailer.Id);
        console.log('[VideoHero] Resolved Local Trailer (zero-transcode static=true):', trailer.Name || trailer.Id);
        return {
          type: 'local',
          videoUrl: streamUrl,
          backdropUrl: backdropUrl,
          title: item.Name || trailer.Name || 'Trailer',
          item: item
        };
      }
    }

    // 3. Priority 2: Check Theme Videos
    let themeVideos = (item.ThemeVideos && item.ThemeVideos.length > 0)
      ? item.ThemeVideos.filter((tv) => tv && tv.Id && tv.Id !== itemId)
      : null;
    if (!themeVideos || themeVideos.length === 0) {
      themeVideos = await fetchThemeVideos(apiClient, itemId, signal);
    }
    if (themeVideos && themeVideos.length > 0) {
      const themeVideo = themeVideos[0];
      if (themeVideo && themeVideo.Id && themeVideo.Id !== itemId) {
        const streamUrl = buildVideoStreamUrl(apiClient, themeVideo.Id);
        console.log('[VideoHero] Resolved Theme Video (zero-transcode static=true):', themeVideo.Name || themeVideo.Id);
        return {
          type: 'local',
          videoUrl: streamUrl,
          backdropUrl: backdropUrl,
          title: item.Name || themeVideo.Name || 'Theme Video',
          item: item
        };
      }
    }

    // 4. Priority 3: Check Remote Trailers (YouTube URLs)
    if (item.RemoteTrailers && item.RemoteTrailers.length > 0) {
      for (const rt of item.RemoteTrailers) {
        const trailerUrl = typeof rt === 'string' ? rt : (rt?.Url || '');
        const ytId = extractYouTubeId(trailerUrl);
        if (ytId) {
          console.log('[VideoHero] Resolved Remote YouTube Trailer:', ytId);
          setCachedTrailer(itemId, ytId);
          return {
            type: 'youtube',
            youtubeId: ytId,
            backdropUrl: backdropUrl,
            title: item.Name || (typeof rt === 'object' ? rt.Name : '') || 'Trailer',
            item: item
          };
        }
      }
    }

    // 5. Priority 4: Secondary Fallback using TMDb API (with 24h sessionStorage cache)
    const cachedYtId = getCachedTrailer(itemId);
    if (cachedYtId) {
      console.log('[VideoHero] Resolved YouTube Trailer from 24h sessionStorage cache:', cachedYtId);
      return {
        type: 'youtube',
        youtubeId: cachedYtId,
        backdropUrl: backdropUrl,
        title: item.Name || 'Trailer',
        item: item
      };
    }

    let tmdbId = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || item.ProviderIds?.TheMovieDb;
    let tmdbType = item.Type;

    if (!tmdbId && item.Name) {
      try {
        const searchResult = await searchTmdb(item.Name, item.ProductionYear, item.Type, signal);
        if (searchResult) {
          tmdbId = searchResult.id;
          tmdbType = searchResult.type;
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    if (tmdbId) {
      try {
        console.log('[VideoHero] Querying TMDb videos fallback for TMDb ID:', tmdbId);
        const ytKey = await fetchTmdbTrailer(tmdbId, tmdbType, signal);
        if (ytKey) {
          console.log('[VideoHero] Resolved YouTube Trailer from TMDb:', ytKey);
          setCachedTrailer(itemId, ytKey);
          return {
            type: 'youtube',
            youtubeId: ytKey,
            backdropUrl: backdropUrl,
            title: item.Name || 'Trailer',
            item: item
          };
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn('[VideoHero] TMDb trailer resolution failed:', err);
      }
    }

    // Zero listType=search: Fallback to static cinematic backdrop
    console.log('[VideoHero] No trailer video found, presenting static cinematic backdrop.');
    return {
      type: 'backdrop_only',
      backdropUrl: backdropUrl,
      title: item.Name || '',
      item: item
    };
  }

  // --- YOUTUBE IFRAME API LAZY LOADER ---
  function loadYouTubeIframeApi() {
    if (window.YT && window.YT.Player) {
      return Promise.resolve(window.YT);
    }
    if (ytApiPromise) return ytApiPromise;

    ytApiPromise = new Promise((resolve) => {
      let checkInterval = null;
      let safetyTimeout = null;

      const finish = (result) => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (safetyTimeout) {
          clearTimeout(safetyTimeout);
          safetyTimeout = null;
        }
        if (!result) {
          ytApiPromise = null;
        }
        if (result) {
          installGlobalYTInterceptor();
        }
        resolve(result);
      };

      const existingScript = document.querySelector('script[src*="youtube.com/iframe_api"]');
      if (!existingScript) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        const firstScript = document.getElementsByTagName('script')[0];
        if (firstScript && firstScript.parentNode) {
          firstScript.parentNode.insertBefore(tag, firstScript);
        } else {
          document.head.appendChild(tag);
        }
      }

      const prevCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prevCallback === 'function') {
          try { prevCallback(); } catch {}
        }
        finish(window.YT || null);
      };

      checkInterval = setInterval(() => {
        if (window.YT && window.YT.Player) {
          finish(window.YT);
        }
      }, 100);

      safetyTimeout = setTimeout(() => {
        finish(window.YT?.Player ? window.YT : null);
      }, 5000);
    });

    return ytApiPromise;
  }

  // --- AUDIO RAMP ENGINE ---
  function rampLocalAudio(video, targetVol = TARGET_VOLUME, durationMs = AUDIO_RAMP_DURATION_MS) {
    if (audioRampTimer) {
      clearInterval(audioRampTimer);
      audioRampTimer = null;
    }
    try {
      video.muted = false;
    } catch {}

    const startVol = (video && Number.isFinite(video.volume)) ? video.volume : 0;
    if (Math.abs(startVol - targetVol) < 0.02) {
      try { video.volume = targetVol; } catch {}
      return;
    }

    const steps = 16;
    const stepInterval = Math.max(20, Math.floor(durationMs / steps));
    const volDelta = (targetVol - startVol) / steps;
    let currentStep = 0;

    audioRampTimer = setInterval(() => {
      currentStep++;
      const nextVol = Math.max(0, Math.min(1, startVol + (currentStep * volDelta)));
      try {
        video.volume = nextVol;
      } catch {}

      if (currentStep >= steps) {
        try { video.volume = targetVol; } catch {}
        clearInterval(audioRampTimer);
        audioRampTimer = null;
      }
    }, stepInterval);
  }

  function rampYouTubeAudio(player, targetVol = Math.round(TARGET_VOLUME * 100), durationMs = AUDIO_RAMP_DURATION_MS) {
    if (audioRampTimer) {
      clearInterval(audioRampTimer);
      audioRampTimer = null;
    }
    try {
      player.unMute();
    } catch {}

    let startVol = 0;
    try {
      if (typeof player.getVolume === 'function') {
        const v = player.getVolume();
        if (Number.isFinite(v)) startVol = v;
      }
    } catch {}

    if (Math.abs(startVol - targetVol) < 2) {
      try { player.setVolume(targetVol); } catch {}
      return;
    }

    const steps = 16;
    const stepInterval = Math.max(20, Math.floor(durationMs / steps));
    const volDelta = (targetVol - startVol) / steps;
    let currentStep = 0;

    audioRampTimer = setInterval(() => {
      currentStep++;
      const nextVol = Math.max(0, Math.min(100, Math.round(startVol + (currentStep * volDelta))));
      try {
        player.setVolume(nextVol);
      } catch {}

      if (currentStep >= steps) {
        try { player.setVolume(targetVol); } catch {}
        clearInterval(audioRampTimer);
        audioRampTimer = null;
      }
    }, stepInterval);
  }

  // --- UI CONTROLS & SPEAKER BUTTON ---
  function updateSpeakerButtonUI(muted) {
    const btn = currentHeroContainer?.querySelector('.jellyfin-hero-speaker-btn');
    if (!btn) return;
    btn.classList.toggle('is-muted', !!muted);
    btn.innerHTML = muted ? ICON_SPEAKER_MUTED : ICON_SPEAKER_UNMUTED;
    btn.setAttribute('aria-label', muted ? 'Unmute video audio' : 'Mute video audio');
    btn.setAttribute('title', muted ? 'Unmute' : 'Mute');
  }

  function toggleMuteState() {
    mutedByAutoplayPolicy = false;
    if (currentMediaType === 'local' && activeVideoElement) {
      if (isMuted) {
        isMuted = false;
        acquireAudioLock('hero');
        if (activeVideoElement.paused) {
          activeVideoElement.play().catch(() => {});
        }
        rampLocalAudio(activeVideoElement, TARGET_VOLUME, 500);
        updateSpeakerButtonUI(false);
      } else {
        isMuted = true;
        releaseAudioLock('hero');
        if (audioRampTimer) {
          clearInterval(audioRampTimer);
          audioRampTimer = null;
        }
        try {
          activeVideoElement.muted = true;
          activeVideoElement.volume = 0;
        } catch {}
        updateSpeakerButtonUI(true);
      }
    } else if (currentMediaType === 'youtube') {
      if (isMuted) {
        isMuted = false;
        acquireAudioLock('hero');
        if (currentYtPlayer && typeof currentYtPlayer.unMute === 'function') {
          if (typeof currentYtPlayer.playVideo === 'function') {
            try { currentYtPlayer.playVideo(); } catch {}
          }
          rampYouTubeAudio(currentYtPlayer, Math.round(TARGET_VOLUME * 100), 500);
        } else if (activeIframeElement?.contentWindow) {
          activeIframeElement.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
          activeIframeElement.contentWindow.postMessage('{"event":"command","func":"unMute","args":""}', '*');
          activeIframeElement.contentWindow.postMessage(`{"event":"command","func":"setVolume","args":[${Math.round(TARGET_VOLUME * 100)}]}`, '*');
        }
        updateSpeakerButtonUI(false);
      } else {
        isMuted = true;
        releaseAudioLock('hero');
        if (audioRampTimer) {
          clearInterval(audioRampTimer);
          audioRampTimer = null;
        }
        if (currentYtPlayer && typeof currentYtPlayer.mute === 'function') {
          try { currentYtPlayer.mute(); } catch {}
        } else if (activeIframeElement?.contentWindow) {
          activeIframeElement.contentWindow.postMessage('{"event":"command","func":"mute","args":""}', '*');
        }
        updateSpeakerButtonUI(true);
      }
    }
  }

  function handleUserGestureUnmute() {
    if (mutedByAutoplayPolicy && isMuted) {
      console.log('[VideoHero] User interaction detected, restoring unmuted audio ramp.');
      mutedByAutoplayPolicy = false;
      isMuted = false;
      acquireAudioLock('hero');
      if (currentMediaType === 'local' && activeVideoElement) {
        rampLocalAudio(activeVideoElement, TARGET_VOLUME, AUDIO_RAMP_DURATION_MS);
        updateSpeakerButtonUI(false);
      } else if (currentMediaType === 'youtube') {
        if (currentYtPlayer && typeof currentYtPlayer.unMute === 'function') {
          rampYouTubeAudio(currentYtPlayer, Math.round(TARGET_VOLUME * 100), AUDIO_RAMP_DURATION_MS);
        } else if (activeIframeElement?.contentWindow) {
          activeIframeElement.contentWindow.postMessage('{"event":"command","func":"unMute","args":""}', '*');
          activeIframeElement.contentWindow.postMessage(`{"event":"command","func":"setVolume","args":[${Math.round(TARGET_VOLUME * 100)}]}`, '*');
        }
        updateSpeakerButtonUI(false);
      }
    }
  }

  // --- INTERSECTION OBSERVER FOR DETAILS SCROLL AUTO-PAUSE ---
  function attachIntersectionObserver(heroContainer) {
    if (intersectionObserver) {
      try { intersectionObserver.disconnect(); } catch {}
      intersectionObserver = null;
    }

    const options = {
      root: null,
      threshold: [0.0, 0.2, 0.5]
    };

    intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target !== heroContainer) return;
        if (isPlaybackActive) return;

        // User scrolled down away from hero: pause player
        if (entry.intersectionRatio < 0.20) {
          let didPause = false;

          const video = activeVideoElement || heroContainer.querySelector('video');
          if (video) {
            try {
              if (!video.paused) {
                video.pause();
              }
              didPause = true;
            } catch (e) {
              console.warn('[VideoHero] Details HTML5 video pause on scroll failed:', e);
            }
          }

          if (currentYtPlayer && typeof currentYtPlayer.pauseVideo === 'function') {
            try {
              currentYtPlayer.pauseVideo();
              didPause = true;
            } catch {}
          }
          const iframe = activeIframeElement || heroContainer.querySelector('iframe');
          if (iframe?.contentWindow) {
            try {
              iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
              didPause = true;
            } catch {}
          }

          if (didPause || video || currentYtPlayer || iframe) {
            isPausedByScroll = true;
            releaseAudioLock('hero');
          }
        }
        // User scrolled back up to top: resume player
        else if (entry.intersectionRatio >= 0.20) {
          if (isPausedByScroll && !isPlaybackActive) {
            isPausedByScroll = false;
            if (!isMuted && !mutedByAudioLock) {
              acquireAudioLock('hero');
            }

            const video = activeVideoElement || heroContainer.querySelector('video');
            if (video && video.paused) {
              video.play().catch((err) => {
                console.warn('[VideoHero] Details HTML5 video resume on scroll up failed:', err);
              });
            }

            if (currentYtPlayer && typeof currentYtPlayer.playVideo === 'function') {
              try { currentYtPlayer.playVideo(); } catch {}
            }
            const iframe = activeIframeElement || heroContainer.querySelector('iframe');
            if (iframe?.contentWindow) {
              try {
                iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
              } catch {}
            }
          }
        }
      });
    }, options);

    intersectionObserver.observe(heroContainer);
    console.log('[VideoHero] Details hero IntersectionObserver active on #' + heroContainer.id);
  }

  // --- HOME SCREEN SCROLL AUTO-PAUSE & AUTO-RESUME ENGINE ---
  let homeIntersectionObserver = null;
  let observedHomeContainer = null;
  let isHomeHeroPausedByScroll = false;
  let isHomeHeroOffscreen = false;

  function pauseHomeHeroPlayback(container, isScroll = true) {
    if (!container) return;
    releaseAudioLock('home-hero');
    let didPauseAny = false;

    const videos = container.querySelectorAll('video');
    videos.forEach((video) => {
      try {
        if (!video.paused) {
          video.pause();
          video.dataset.heroPausedByScroll = 'true';
          didPauseAny = true;
        }
      } catch (e) {
        console.warn('[VideoHero] Error pausing home HTML5 video on scroll:', e);
      }
    });

    const iframes = container.querySelectorAll('iframe');
    iframes.forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
        iframe.dataset.heroPausedByScroll = 'true';
        didPauseAny = true;
      } catch (e) {
        console.warn('[VideoHero] Error posting pauseVideo to home iframe on scroll:', e);
      }
    });

    if (window.mediaBarEnhanced?.STATE?.slideshow?.videoPlayers) {
      const players = window.mediaBarEnhanced.STATE.slideshow.videoPlayers;
      Object.values(players).forEach((player) => {
        if (!player) return;
        if (typeof player.pauseVideo === 'function') {
          try {
            player.pauseVideo();
            didPauseAny = true;
          } catch {}
        } else if (player.tagName === 'VIDEO' && !player.paused) {
          try {
            player.pause();
            player.dataset.heroPausedByScroll = 'true';
            didPauseAny = true;
          } catch {}
        }
      });
    }

    if (isScroll) {
      isHomeHeroOffscreen = true;
      if (didPauseAny || videos.length > 0 || iframes.length > 0) {
        isHomeHeroPausedByScroll = true;
      }
    }
  }

  function resumeHomeHeroPlayback(container) {
    if (!container) return;
    isHomeHeroOffscreen = false;

    if (!isHomeHeroPausedByScroll) return;
    if (isPlaybackActive) return;
    isHomeHeroPausedByScroll = false;
    console.log('[VideoHero] Home hero scrolled back into viewport, resuming trailer.');

    const videos = container.querySelectorAll('video');
    videos.forEach((video) => {
      const wasPausedByScroll = video.dataset.heroPausedByScroll === 'true';
      delete video.dataset.heroPausedByScroll;

      if (wasPausedByScroll || video.paused) {
        const slide = video.closest('.slide');
        if (!slide || slide.classList.contains('active') || slide.classList.contains('current') || !container.querySelector('.slide.active, .slide.current')) {
          video.play().catch((err) => {
            console.warn('[VideoHero] Home HTML5 video play on resume rejected:', err);
          });
        }
      }
    });

    const iframes = container.querySelectorAll('iframe');
    iframes.forEach((iframe) => {
      delete iframe.dataset.heroPausedByScroll;
      const slide = iframe.closest('.slide');
      if (!slide || slide.classList.contains('active') || slide.classList.contains('current') || !container.querySelector('.slide.active, .slide.current')) {
        try {
          iframe.contentWindow?.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
        } catch (e) {
          console.warn('[VideoHero] Error posting playVideo to home iframe on resume:', e);
        }
      }
    });

    if (window.mediaBarEnhanced?.STATE?.slideshow?.videoPlayers) {
      const players = window.mediaBarEnhanced.STATE.slideshow.videoPlayers;
      Object.values(players).forEach((player) => {
        if (!player) return;
        if (typeof player.playVideo === 'function') {
          try {
            player.playVideo();
          } catch {}
        } else if (player.tagName === 'VIDEO' && player.paused) {
          try {
            player.play().catch(() => {});
          } catch {}
        }
      });
    }
  }

  function attachHomeHeroListeners(container) {
    if (container.__videoHeroScrollListenersAttached__) return;
    container.__videoHeroScrollListenersAttached__ = true;

    container.addEventListener('play', (e) => {
      if (isHomeHeroOffscreen && e.target && e.target.tagName === 'VIDEO') {
        try {
          e.target.pause();
          e.target.dataset.heroPausedByScroll = 'true';
          isHomeHeroPausedByScroll = true;
          console.log('[VideoHero] Suppressed off-screen home video play event.');
        } catch {}
      }
    }, true);
  }

  function setupHomeHeroObserver() {
    scavengePauseButtons();

    if (isDetailsRoute()) {
      if (homeIntersectionObserver) {
        try { homeIntersectionObserver.disconnect(); } catch {}
        homeIntersectionObserver = null;
      }
      observedHomeContainer = null;
      isHomeHeroPausedByScroll = false;
      isHomeHeroOffscreen = false;
      return;
    }

    const homeContainer = document.querySelector('#slides-container, .slideshow-container');
    if (!homeContainer) {
      if (observedHomeContainer && !document.contains(observedHomeContainer)) {
        if (homeIntersectionObserver) {
          try { homeIntersectionObserver.disconnect(); } catch {}
          homeIntersectionObserver = null;
        }
        observedHomeContainer = null;
      }
      return;
    }

    if (homeContainer === observedHomeContainer && homeIntersectionObserver) {
      return;
    }

    if (homeIntersectionObserver) {
      try { homeIntersectionObserver.disconnect(); } catch {}
      homeIntersectionObserver = null;
    }

    observedHomeContainer = homeContainer;
    attachHomeHeroListeners(homeContainer);

    const options = {
      root: null,
      threshold: [0.0, 0.2, 0.5]
    };

    homeIntersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target !== homeContainer) return;
        if (isPlaybackActive) return;

        if (entry.intersectionRatio < 0.20) {
          pauseHomeHeroPlayback(homeContainer, true);
        } else if (entry.intersectionRatio >= 0.20) {
          resumeHomeHeroPlayback(homeContainer);
        }
      });
    }, options);

    homeIntersectionObserver.observe(homeContainer);
    console.log('[VideoHero] Home hero IntersectionObserver registered on:', homeContainer.id || homeContainer.className);
  }

  // --- CLEANUP & TEARDOWN ---
  function destroyCurrentPlayer() {
    releaseAudioLock('hero');

    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }

    if (currentAbortController) {
      try { currentAbortController.abort(); } catch {}
      currentAbortController = null;
    }

    if (audioRampTimer) {
      clearInterval(audioRampTimer);
      audioRampTimer = null;
    }

    if (ytAutoplayCheckTimer) {
      clearTimeout(ytAutoplayCheckTimer);
      ytAutoplayCheckTimer = null;
    }

    if (iframeReadyTimer) {
      clearTimeout(iframeReadyTimer);
      iframeReadyTimer = null;
    }

    if (intersectionObserver) {
      try { intersectionObserver.disconnect(); } catch {}
      intersectionObserver = null;
    }

    if (activeVideoElement) {
      try {
        activeVideoElement.pause();
        activeVideoElement.removeAttribute('src');
        activeVideoElement.load();
        activeVideoElement.remove();
      } catch (e) {
        console.warn('[VideoHero] Error during video teardown:', e);
      }
      activeVideoElement = null;
    }

    if (currentYtPlayer && typeof currentYtPlayer.destroy === 'function') {
      try { currentYtPlayer.destroy(); } catch {}
      currentYtPlayer = null;
    }

    if (activeIframeElement) {
      try {
        activeIframeElement.src = 'about:blank';
        activeIframeElement.remove();
      } catch {}
      activeIframeElement = null;
    }

    if (currentHeroContainer) {
      try { currentHeroContainer.remove(); } catch {}
      currentHeroContainer = null;
    }

    const orphanHeroes = document.querySelectorAll(`#${HERO_CONTAINER_ID}, .jellyfin-details-video-hero`);
    orphanHeroes.forEach((hero) => {
      try {
        const vids = hero.querySelectorAll('video');
        vids.forEach((v) => {
          v.pause();
          v.removeAttribute('src');
          v.load();
          v.remove();
        });
        const ifrs = hero.querySelectorAll('iframe');
        ifrs.forEach((f) => {
          f.src = 'about:blank';
          f.remove();
        });
        hero.remove();
      } catch {}
    });

    const detailPages = document.querySelectorAll('#itemDetailPage, .itemDetailPage');
    detailPages.forEach((page) => {
      page.classList.remove('has-video-hero');
    });

    activeItemId = null;
    currentMediaType = null;
    isMuted = false;
    mutedByAutoplayPolicy = false;
    isPausedByScroll = false;
    isPlaybackActive = false;
  }

  // --- BANNER INJECTION & INITIALIZATION ---
  async function injectVideoHeroBanner(targetWrapper, itemId, mediaInfo) {
    stopHomeScreenSlideshow();

    const existingHero = targetWrapper.querySelector(`#${HERO_CONTAINER_ID}`);
    if (existingHero) existingHero.remove();

    // 1. Container Architecture
    const heroContainer = document.createElement('div');
    heroContainer.id = HERO_CONTAINER_ID;
    heroContainer.className = 'jellyfin-details-video-hero';
    currentHeroContainer = heroContainer;
    activeItemId = itemId;
    currentMediaType = mediaInfo.type;
    isMuted = false;
    isPausedByScroll = false;

    // 2. Layer 0: Static Backdrop Poster
    const layerBackdrop = document.createElement('div');
    layerBackdrop.className = 'jellyfin-hero-layer-backdrop';
    if (mediaInfo.backdropUrl) {
      layerBackdrop.style.backgroundImage = `url("${mediaInfo.backdropUrl}")`;
    }
    heroContainer.appendChild(layerBackdrop);

    // 3. Layer 1: Video Player Layer
    const layerMedia = document.createElement('div');
    layerMedia.className = 'jellyfin-hero-layer-media';
    heroContainer.appendChild(layerMedia);

    // 4. Layer 2: Multi-Stop Theatrical Dark Vignette
    const layerVignette = document.createElement('div');
    layerVignette.className = 'jellyfin-hero-vignette-overlay';
    heroContainer.appendChild(layerVignette);

    // 5. Layer 3: Floating Glass Speaker Button
    if (mediaInfo.type === 'local' || mediaInfo.type === 'youtube') {
      const speakerBtn = document.createElement('button');
      speakerBtn.type = 'button';
      speakerBtn.className = 'jellyfin-hero-speaker-btn' + (isMuted ? ' is-muted' : '');
      speakerBtn.innerHTML = isMuted ? ICON_SPEAKER_MUTED : ICON_SPEAKER_UNMUTED;
      speakerBtn.setAttribute('aria-label', isMuted ? 'Unmute video audio' : 'Mute video audio');
      speakerBtn.setAttribute('title', isMuted ? 'Unmute' : 'Mute');
      speakerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMuteState();
      });
      heroContainer.appendChild(speakerBtn);
    }

    // Inject before firstChild of resolved target container without colliding with ribbon
    if (targetWrapper.classList.contains('detailRibbon') && targetWrapper.parentElement) {
      targetWrapper.parentElement.insertBefore(heroContainer, targetWrapper);
    } else {
      targetWrapper.insertBefore(heroContainer, targetWrapper.firstChild);
    }

    // Mark detail page for CSS backdrop coordination
    const activeDetailPage = targetWrapper.closest('#itemDetailPage, .itemDetailPage') ||
                             (targetWrapper.id === 'itemDetailPage' ? targetWrapper : null) ||
                             document.querySelector('#itemDetailPage:not(.hide):not([style*="display: none"]), .itemDetailPage:not(.hide):not([style*="display: none"])');
    if (activeDetailPage) {
      activeDetailPage.classList.add('has-video-hero');
    }

    // Attach IntersectionObserver for scroll-aware pause/resume
    attachIntersectionObserver(heroContainer);

    // 6. Player Instantiation
    if (mediaInfo.type === 'local') {
      instantiateLocalPlayer(layerMedia, mediaInfo.videoUrl);
    } else if (mediaInfo.type === 'youtube') {
      instantiateYouTubePlayer(layerMedia, mediaInfo.youtubeId);
    } else {
      layerMedia.classList.add('is-active');
    }
  }

  // --- LOCAL HTML5 VIDEO PLAYER ENGINE ---
  function instantiateLocalPlayer(container, videoUrl) {
    let finalUrl = videoUrl;
    if (finalUrl) {
      // Ensure static=true is strictly present
      if (!/[?&]static=true\b/i.test(finalUrl)) {
        const sep = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${sep}static=true`;
      }
      // Ensure api_key is present
      const client = getApiClient();
      const token = getAuthToken(client);
      if (token && !/[?&]api_key=/i.test(finalUrl)) {
        finalUrl += `&api_key=${encodeURIComponent(token)}`;
      }
    }

    const video = document.createElement('video');
    video.className = 'jellyfin-hero-html5-video';
    video.src = finalUrl;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';

    video.muted = false;
    video.volume = 0;

    activeVideoElement = video;

    const onPlaybackStarted = () => {
      container.classList.add('is-active');
      if (!isMuted && !mutedByAudioLock) {
        rampLocalAudio(video, TARGET_VOLUME, AUDIO_RAMP_DURATION_MS);
      }
    };
    video.addEventListener('playing', onPlaybackStarted);
    video.addEventListener('timeupdate', () => {
      if (video.currentTime > 0) {
        container.classList.add('is-active');
      }
    });

    video.addEventListener('ended', () => {
      try {
        video.currentTime = 0;
        const p = video.play();
        if (p !== undefined) {
          p.catch((err) => {
            console.warn('[VideoHero] Local video loop replay failed:', err);
          });
        }
      } catch (e) {
        console.warn('[VideoHero] Error in local video ended handler:', e);
      }
    });

    container.appendChild(video);

    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          isMuted = false;
          container.classList.add('is-active');
          updateSpeakerButtonUI(false);
          acquireAudioLock('hero');
          console.log('[VideoHero] HTML5 unmuted autoplay succeeded.');
        })
        .catch((err) => {
          console.warn('[VideoHero] Unmuted autoplay rejected by browser policy. Falling back to muted autoplay:', err);
          video.muted = true;
          isMuted = true;
          mutedByAutoplayPolicy = true;
          updateSpeakerButtonUI(true);
          releaseAudioLock('hero');
          video.play()
            .then(() => {
              container.classList.add('is-active');
            })
            .catch((playErr) => {
              console.error('[VideoHero] Muted playback attempt also failed:', playErr);
            });
        });
    }
  }

  // --- TASK 2: HEADLESS YOUTUBE IFRAME PLAYER ENGINE (1080P & AUTOPLAY SAFE) ---
  async function instantiateYouTubePlayer(container, youtubeId) {
    if (!youtubeId) return;

    const viewport = document.createElement('div');
    viewport.className = 'jellyfin-hero-youtube-viewport';

    const playerContainerId = `ytHeroPlayer_${Date.now()}`;
    const ytTargetDiv = document.createElement('div');
    ytTargetDiv.id = playerContainerId;
    viewport.appendChild(ytTargetDiv);
    container.appendChild(viewport);

    const hostOrigin = (window.location.origin && window.location.origin !== 'null')
      ? window.location.origin
      : (window.location.protocol + '//' + window.location.host);

    const screenW = window.innerWidth || window.screen?.width || 1920;
    const isUltraWide = screenW >= 2500;
    const widthVal = isUltraWide ? 2560 : 1920;
    const heightVal = isUltraWide ? 1440 : 1080;

    // Load API for programmatic audio & quality control
    const ytApi = await loadYouTubeIframeApi();

    if (ytApi && ytApi.Player) {
      try {
        const playerVars = {
          autoplay: 1,
          mute: 1, // Start muted to ensure browser autoplay policies NEVER block the video
          controls: 0,
          loop: 1,
          modestbranding: 1,
          rel: 0,
          showinfo: 0,
          iv_load_policy: 3,
          disablekb: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: hostOrigin,
          playlist: youtubeId,
          vq: 'hd1080',
          suggestedQuality: 'hd1080'
        };

        const playerConfig = {
          width: widthVal,
          height: heightVal,
          videoId: youtubeId,
          playerVars: playerVars,
          events: {
            onReady: (event) => {
              activeIframeElement = event.target.getIframe();
              try {
                event.target.setPlaybackQuality?.('hd1080');
                event.target.setPlaybackQualityRange?.('hd1080', 'hd1440');
              } catch {}
              event.target.playVideo();
            },
            onStateChange: (event) => {
              const ytState = window.YT?.PlayerState || ytApi?.PlayerState || {};
              const playingCode = ytState.PLAYING !== undefined ? ytState.PLAYING : 1;
              const endedCode = ytState.ENDED !== undefined ? ytState.ENDED : 0;

              // Immediately on state === 1 (PLAYING), cross-fade and gently ramp unmuted audio if allowed
              if (event.data === playingCode) {
                try {
                  event.target.setPlaybackQuality?.('hd1080');
                  event.target.setPlaybackQualityRange?.('hd1080', 'hd1440');
                } catch {}
                container.classList.add('is-active');

                if (!isMuted && !mutedByAudioLock) {
                  acquireAudioLock('hero');
                  try {
                    event.target.unMute();
                  } catch {}
                  rampYouTubeAudio(event.target, Math.round(TARGET_VOLUME * 100), AUDIO_RAMP_DURATION_MS);
                  updateSpeakerButtonUI(false);
                }
              }

              // Enforce continuous loop replay
              if (event.data === endedCode) {
                try {
                  event.target.seekTo(0);
                  event.target.playVideo();
                } catch (e) {
                  console.warn('[VideoHero] YouTube loop replay failed:', e);
                }
              }
            },
            onError: (err) => {
              console.warn('[VideoHero] YouTube player error:', err);
            }
          }
        };

        currentYtPlayer = new ytApi.Player(playerContainerId, playerConfig);
        return;
      } catch (err) {
        console.warn('[VideoHero] YT.Player construction failed, using direct iframe fallback:', err);
      }
    }

    // Direct IFrame Fallback (PostMessage controlled)
    const embedUrl = `https://www.youtube-nocookie.com/embed/${youtubeId}?enablejsapi=1&autoplay=1&mute=1&controls=0&loop=1&playlist=${youtubeId}&modestbranding=1&rel=0&showinfo=0&iv_load_policy=3&disablekb=1&playsinline=1&origin=${encodeURIComponent(hostOrigin)}&vq=hd1080`;

    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.setAttribute('width', '1920');
    iframe.setAttribute('height', '1080');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('tabindex', '-1');

    activeIframeElement = iframe;

    if (iframeReadyTimer) {
      clearTimeout(iframeReadyTimer);
      iframeReadyTimer = null;
    }

    iframe.onload = () => {
      container.classList.add('is-active');
      try {
        iframe.contentWindow?.postMessage('{"event":"command","func":"setPlaybackQuality","args":["hd1080"]}', '*');
      } catch {}

      iframeReadyTimer = setTimeout(() => {
        iframeReadyTimer = null;
        if (!activeIframeElement || activeIframeElement !== iframe) return;
        iframe.contentWindow?.postMessage('{"event":"listening"}', '*');
        iframe.contentWindow?.postMessage('{"event":"command","func":"setPlaybackQuality","args":["hd1080"]}', '*');
        iframe.contentWindow?.postMessage('{"event":"command","func":"playVideo","args":""}', '*');

        if (!isMuted && !mutedByAudioLock) {
          acquireAudioLock('hero');
          iframe.contentWindow?.postMessage('{"event":"command","func":"unMute","args":""}', '*');
          iframe.contentWindow?.postMessage(`{"event":"command","func":"setVolume","args":[${Math.round(TARGET_VOLUME * 100)}]}`, '*');
          updateSpeakerButtonUI(false);
        }
      }, 500);
    };

    ytTargetDiv.replaceWith(iframe);
  }

  // --- PLAYBACK INTERCEPTOR HELPERS ---
  function pauseHeroForPlayback() {
    console.log('[VideoHero] Full video playback started, immediately pausing hero trailer.');
    isPlaybackActive = true;
    releaseAudioLock('hero');

    if (audioRampTimer) {
      clearInterval(audioRampTimer);
      audioRampTimer = null;
    }

    if (activeVideoElement) {
      try {
        if (!activeVideoElement.paused) {
          activeVideoElement.pause();
        }
        activeVideoElement.muted = true;
      } catch {}
    }

    if (currentYtPlayer && typeof currentYtPlayer.pauseVideo === 'function') {
      try {
        currentYtPlayer.pauseVideo();
        currentYtPlayer.mute();
      } catch {}
    } else if (activeIframeElement?.contentWindow) {
      try {
        activeIframeElement.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
        activeIframeElement.contentWindow.postMessage('{"event":"command","func":"mute","args":""}', '*');
      } catch {}
    }

    const homeContainer = observedHomeContainer || document.querySelector('#slides-container, .slideshow-container');
    if (homeContainer) {
      pauseHomeHeroPlayback(homeContainer, false);
    }
  }

  function handlePlaybackStopped() {
    console.log('[VideoHero] Full video playback stopped.');
    isPlaybackActive = false;
  }

  // --- ROUTE INTERCEPTOR & SETTLE CONTROLLER ---
  async function handleRouteChange() {
    scavengePauseButtons();

    // 1. Clear any pending settle timer
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }

    // 2. Check if currently on a details page
    if (!isDetailsRoute()) {
      if (activeItemId || currentHeroContainer || settleTimer || currentAbortController) {
        console.log('[VideoHero] Navigated away from details page, destroying player.');
        destroyCurrentPlayer();
      }
      setupHomeHeroObserver();
      return;
    }

    // Mutual exclusion: entering details page, immediately silence home screen slideshow
    stopHomeScreenSlideshow();

    const newItemId = extractItemId();

    // If navigating to another item, immediately destroy active player
    if (newItemId && activeItemId && newItemId !== activeItemId) {
      console.log('[VideoHero] Item ID changed from', activeItemId, 'to', newItemId);
      destroyCurrentPlayer();
    }

    // If same item and hero already exists, nothing to do
    if (newItemId && newItemId === activeItemId && currentHeroContainer) {
      return;
    }

    // 3. Enforce 600ms Settle Delay (Prevents spurious spawning during rapid navigation)
    settleTimer = setTimeout(async () => {
      settleTimer = null;

      if (!isDetailsRoute()) return;
      const itemId = extractItemId();
      if (!itemId) return;

      if (itemId === activeItemId && currentHeroContainer) return;

      console.log('[VideoHero] Settle delay elapsed. Initiating media resolution for item:', itemId);

      stopHomeScreenSlideshow();

      if (currentAbortController) {
        try { currentAbortController.abort(); } catch {}
      }
      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;

      try {
        const apiClient = await waitForApiClient(6000, signal);
        if (signal.aborted || !apiClient) {
          console.warn('[VideoHero] ApiClient unavailable.');
          return;
        }

        const userId = getCurrentUserId(apiClient);
        if (signal.aborted || !userId) {
          console.warn('[VideoHero] User ID unavailable.');
          return;
        }

        const mediaInfo = await resolveHeroMedia(apiClient, userId, itemId, signal);
        if (signal.aborted || !mediaInfo) return;

        // Multi-container selector wait
        const wrapper = await waitForActiveDetailWrapper(3500, signal);
        if (signal.aborted || !wrapper) {
          console.warn('[VideoHero] Active detail page container not found.');
          return;
        }

        if (!isDetailsRoute() || extractItemId() !== itemId) return;

        // Inject Hero Banner
        await injectVideoHeroBanner(wrapper, itemId, mediaInfo);
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log('[VideoHero] Media resolution safely aborted.');
        } else {
          console.error('[VideoHero] Error during hero setup:', err);
        }
      }
    }, SETTLE_DELAY_MS);
  }

  // --- LIFECYCLE LISTENERS & PERFORMANCE SAFEGUARDS ---
  function registerLifecycleListeners() {
    // 1. History API & Hash Routing
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('popstate', handleRouteChange);

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const res = originalPushState.apply(this, args);
      try {
        handleRouteChange();
      } catch (err) {
        console.warn('[VideoHero] Error handling pushState route change:', err);
      }
      return res;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const res = originalReplaceState.apply(this, args);
      try {
        handleRouteChange();
      } catch (err) {
        console.warn('[VideoHero] Error handling replaceState route change:', err);
      }
      return res;
    };

    // 2. Jellyfin View Lifecycle Events (Capture mode for viewshow/pageshow)
    document.addEventListener('viewshow', handleRouteChange, { capture: true });
    document.addEventListener('pageshow', handleRouteChange, { capture: true });
    window.addEventListener('pageshow', handleRouteChange, { capture: true });

    // Precise Viewhide Guard: only destroy if outgoing view is the details page
    function handleViewHide(e) {
      const target = e?.target;
      if (target && (target.id === 'itemDetailPage' || target.classList?.contains('itemDetailPage'))) {
        destroyCurrentPlayer();
      }
    }

    document.addEventListener('viewbeforehide', handleViewHide);
    document.addEventListener('viewhide', handleViewHide);
    document.addEventListener('pagehide', handleViewHide);
    window.addEventListener('beforeunload', () => destroyCurrentPlayer());
    window.addEventListener('pagehide', handleViewHide);

    // 3. Full Playback Interceptor
    document.addEventListener('playbackstart', pauseHeroForPlayback);
    window.addEventListener('playbackstart', pauseHeroForPlayback);

    document.addEventListener('playbackstop', handlePlaybackStopped);
    window.addEventListener('playbackstop', handlePlaybackStopped);

    // 4. Audio Coordinator Lock Listeners
    window.addEventListener('jellyfin-audio-lock-acquired', (e) => {
      if (e.detail && e.detail.source !== 'hero' && !isMuted) {
        if (activeVideoElement || currentYtPlayer || activeIframeElement) {
          console.log('[VideoHero] Another audio source acquired lock (' + e.detail.source + '), muting hero video.');
          mutedByAudioLock = true;
          toggleMuteState();
        }
      }
    });

    window.addEventListener('jellyfin-audio-lock-released', (e) => {
      if (e.detail && e.detail.source !== 'hero' && mutedByAudioLock && !isPausedByScroll && !isPlaybackActive) {
        mutedByAudioLock = false;
        console.log('[VideoHero] External audio lock released (' + e.detail.source + '), restoring hero unmuted audio.');
        if (isMuted) {
          toggleMuteState();
        }
      }
    });

    // 5. High-Performance Content Observer (Observes #mainContent with childList only to eliminate CPU spikes)
    const mainContent = document.getElementById('mainContent') ||
                        document.querySelector('.mainAnimatedPages') ||
                        document.body;

    const contentObserver = new MutationObserver((mutations) => {
      scavengePauseButtons();
      for (const mut of mutations) {
        if (mut.type === 'childList' && mut.addedNodes.length > 0) {
          for (const node of mut.addedNodes) {
            if (node.nodeType === 1) {
              if (
                node.id === 'itemDetailPage' ||
                node.classList?.contains('itemDetailPage') ||
                node.classList?.contains('detailPageWrapperContainer') ||
                node.classList?.contains('detailPagePrimaryContainer') ||
                node.classList?.contains('detailRibbon') ||
                node.querySelector?.('.detailPageWrapperContainer, .detailPagePrimaryContainer, .detailRibbon')
              ) {
                handleRouteChange();
                return;
              }
              if (
                node.id === 'slides-container' ||
                node.classList?.contains('slideshow-container') ||
                node.querySelector?.('#slides-container, .slideshow-container')
              ) {
                setupHomeHeroObserver();
              }
            }
          }
        }
      }
    });

    contentObserver.observe(mainContent, {
      childList: true,
      subtree: true
    });

    // 6. User Gesture Auto-Unmute Fallback Listener
    window.addEventListener('pointerdown', handleUserGestureUnmute, { passive: true });
    window.addEventListener('keydown', handleUserGestureUnmute, { passive: true });

    // 7. Direct IFrame PostMessage Interceptor for Continuous Loop
    window.addEventListener('message', (e) => {
      if (!activeIframeElement || e.source !== activeIframeElement.contentWindow) return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data && data.event === 'infoDelivery' && data.info) {
          if (data.info.playerState === 1) { // PLAYING
            const mediaLayer = currentHeroContainer?.querySelector('.jellyfin-hero-layer-media');
            if (mediaLayer) mediaLayer.classList.add('is-active');
            if (!isMuted && !mutedByAudioLock) {
              acquireAudioLock('hero');
              activeIframeElement.contentWindow?.postMessage('{"event":"command","func":"unMute","args":""}', '*');
              activeIframeElement.contentWindow?.postMessage(`{"event":"command","func":"setVolume","args":[${Math.round(TARGET_VOLUME * 100)}]}`, '*');
              updateSpeakerButtonUI(false);
            }
          } else if (data.info.playerState === 0) { // ENDED
            activeIframeElement.contentWindow?.postMessage('{"event":"command","func":"seekTo","args":[0,true]}', '*');
            activeIframeElement.contentWindow?.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
          }
        }
      } catch {}
    });
  }

  // --- INITIALIZATION ---
  function initModule() {
    installGlobalYTInterceptor();
    injectModuleStyles();
    registerLifecycleListeners();
    scavengePauseButtons();
    handleRouteChange();
    setupHomeHeroObserver();
    setTimeout(setupHomeHeroObserver, 500);
    setTimeout(setupHomeHeroObserver, 1500);
    setTimeout(setupHomeHeroObserver, 3000);
    console.log('[VideoHero] Movie Details & Home Video Hero module successfully activated with 1080p YT interceptor.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModule);
  } else {
    initModule();
  }
})();
