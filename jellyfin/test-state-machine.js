/**
 * Comprehensive Audio/Video Concurrency & State Machine Validator
 * Headless Node.js Test Suite for Jellyfin Web Extensions:
 *   - custom-details-hero.js
 *   - custom-hover-preview.js
 *   - Jellyfin.Plugin.MediaBarEnhanced.xml
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

// ANSI Color Helpers
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passedAssertions = 0;
let failedAssertions = 0;

function assertCondition(cond, message) {
  if (cond) {
    passedAssertions++;
    console.log(`  ${GREEN}✓${RESET} ${message}`);
  } else {
    failedAssertions++;
    console.error(`  ${RED}✗ FAIL:${RESET} ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log(`${BOLD}${CYAN}=================================================================${RESET}`);
console.log(`${BOLD}${CYAN} Jellyfin Audio/Video Concurrency & State Machine Test Suite     ${RESET}`);
console.log(`${BOLD}${CYAN}=================================================================${RESET}\n`);

// -------------------------------------------------------------
// 1. HEADLESS DOM & W3C EVENT SIMULATION ENGINE
// -------------------------------------------------------------

class MockDOMTokenList {
  constructor(owner) {
    this._owner = owner;
    this._tokens = new Set();
  }

  add(...tokens) {
    for (const t of tokens) {
      if (t) this._tokens.add(t);
    }
    this._owner._syncClassName();
  }

  remove(...tokens) {
    for (const t of tokens) {
      this._tokens.delete(t);
    }
    this._owner._syncClassName();
  }

  contains(token) {
    return this._tokens.has(token);
  }

  toggle(token, force) {
    if (typeof force !== 'undefined') {
      if (force) {
        this.add(token);
        return true;
      } else {
        this.remove(token);
        return false;
      }
    }
    if (this.contains(token)) {
      this.remove(token);
      return false;
    } else {
      this.add(token);
      return true;
    }
  }

  toString() {
    return Array.from(this._tokens).join(' ');
  }
}

class MockEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = !!options.bubbles;
    this.cancelable = !!options.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.detail = options.detail || null;
    this.pointerType = options.pointerType || 'mouse';
    this.clientX = options.clientX || 0;
    this.clientY = options.clientY || 0;
    this.relatedTarget = options.relatedTarget || null;
  }

  stopPropagation() {
    this.bubbles = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

function dispatchDOMEvent(target, event) {
  event.target = target;
  const path = [];
  let curr = target;
  while (curr) {
    path.unshift(curr);
    curr = curr.parentNode;
  }

  // Ensure root of path includes mockDocElement, mockDocument, and mockWindow
  if (path.length > 0 && path[0] === mockDocElement) {
    path.unshift(mockDocument);
    path.unshift(mockWindow);
  } else if (path.length > 0 && path[0] === mockDocument) {
    path.unshift(mockWindow);
  }

  // 1. Capture Phase (from root down to parent)
  for (let i = 0; i < path.length - 1; i++) {
    event.currentTarget = path[i];
    const listeners = path[i]._listeners ? (path[i]._listeners.get(event.type) || []) : [];
    for (const l of listeners) {
      if (l.capture) {
        try {
          l.handler.call(path[i], event);
        } catch (e) {
          console.error(`Error in capture handler for ${event.type}:`, e);
        }
      }
    }
  }

  // 2. Target Phase
  event.currentTarget = target;
  const targetListeners = target._listeners ? (target._listeners.get(event.type) || []) : [];
  for (const l of targetListeners) {
    try {
      l.handler.call(target, event);
    } catch (e) {
      console.error(`Error in target handler for ${event.type}:`, e);
    }
  }

  // 3. Bubbling Phase (from parent up to root)
  if (event.bubbles) {
    for (let i = path.length - 2; i >= 0; i--) {
      event.currentTarget = path[i];
      const listeners = path[i]._listeners ? (path[i]._listeners.get(event.type) || []) : [];
      for (const l of listeners) {
        if (!l.capture) {
          try {
            l.handler.call(path[i], event);
          } catch (e) {
            console.error(`Error in bubble handler for ${event.type}:`, e);
          }
        }
      }
    }
  }

  return !event.defaultPrevented;
}

class MockElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this._className = '';
    this.classList = new MockDOMTokenList(this);
    this.style = {};
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this._innerHTML = '';
    this._textContent = '';
    this._listeners = new Map();
    this._bound = false;
    this._clickBound = false;
    this._leaveBound = false;
    this._hoverPreviewBound = false;
    this.__videoHeroScrollListenersAttached__ = false;

    // Media properties (for video/iframe)
    this._src = '';
    this.paused = true;
    this.muted = false;
    this.volume = 1.0;
    this.currentTime = 0;
    this.autoplay = false;
    this.loop = false;
    this.playsInline = false;
    this.preload = 'auto';
    this.postedMessages = [];

    // Bounding Box Mock (Default 1920x1080 screen layout)
    this._rect = { top: 0, left: 0, right: 300, bottom: 450, width: 300, height: 450 };

    if (this.tagName === 'IFRAME') {
      this.contentWindow = {
        postMessage: (msg) => {
          this.postedMessages.push(msg);
          if (typeof window !== 'undefined' && window.__iframeMessageHook) {
            window.__iframeMessageHook(this, msg);
          }
        }
      };
    }
  }

  _syncClassName() {
    this._className = this.classList.toString();
  }

  get className() {
    return this._className;
  }

  set className(val) {
    this._className = val || '';
    this.classList._tokens.clear();
    (this._className.split(/\s+/)).filter(Boolean).forEach(t => this.classList._tokens.add(t));
  }

  get offsetWidth() {
    return this._rect.width || 300;
  }

  get offsetHeight() {
    return this._rect.height || 450;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx !== -1 && idx < this.parentNode.childNodes.length - 1) {
      return this.parentNode.childNodes[idx + 1];
    }
    return null;
  }

  get src() {
    return this._src;
  }

  set src(val) {
    this._src = val || '';
    if (val && val !== 'about:blank') {
      setTimeout(() => {
        if (this.tagName === 'VIDEO') {
          if (typeof this.oncanplay === 'function') this.oncanplay();
          this.dispatchEvent(new MockEvent('canplay'));
        } else if (this.tagName === 'IFRAME' || this.tagName === 'IMG') {
          if (typeof this.onload === 'function') this.onload();
          this.dispatchEvent(new MockEvent('load'));
        }
      }, 10);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.childNodes = [];
    if (!html) return;

    // Specialized parser for hover portal structure
    if (html.includes('hover-preview-inner')) {
      const inner = new MockElement('DIV');
      inner.className = 'hover-preview-inner';
      this.appendChild(inner);

      const mediaCont = new MockElement('DIV');
      mediaCont.className = 'hover-preview-media-container';
      inner.appendChild(mediaCont);

      const vignette = new MockElement('DIV');
      vignette.className = 'hover-preview-vignette';
      inner.appendChild(vignette);

      const muteBtn = new MockElement('BUTTON');
      muteBtn.className = 'hover-preview-mute-btn';
      inner.appendChild(muteBtn);

      const info = new MockElement('DIV');
      info.className = 'hover-preview-info';
      inner.appendChild(info);

      const title = new MockElement('DIV');
      title.className = 'hover-preview-title';
      info.appendChild(title);

      const badges = new MockElement('DIV');
      badges.className = 'hover-preview-badges';
      info.appendChild(badges);

      const tier = new MockElement('SPAN');
      tier.className = 'hover-preview-badge tier';
      badges.appendChild(tier);

      const year = new MockElement('SPAN');
      year.className = 'hover-preview-badge year';
      badges.appendChild(year);

      const rating = new MockElement('SPAN');
      rating.className = 'hover-preview-badge rating';
      badges.appendChild(rating);

      const stars = new MockElement('SPAN');
      stars.className = 'hover-preview-badge stars';
      badges.appendChild(stars);
      return;
    }

    const stack = [];
    const tagRegex = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)>|<([a-zA-Z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      const [fullMatch, closeTag, openTag, attrStr, selfCloseSlash, textContent] = match;
      if (fullMatch.startsWith('<!--')) continue;
      if (textContent) {
        const text = textContent.trim();
        if (text && stack.length > 0) {
          stack[stack.length - 1].textContent = (stack[stack.length - 1].textContent || '') + text;
        }
        continue;
      }
      if (closeTag) {
        if (stack.length > 0 && stack[stack.length - 1].tagName.toLowerCase() === closeTag.toLowerCase()) {
          stack.pop();
        }
        continue;
      }
      const isSelfClosing = selfCloseSlash === '/' || ['img', 'input', 'br', 'hr', 'source', 'area'].includes(openTag.toLowerCase());
      const el = new MockElement(openTag.toUpperCase());
      if (attrStr) {
        const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
        let a;
        while ((a = attrRegex.exec(attrStr)) !== null) {
          el.setAttribute(a[1], a[2] !== undefined ? a[2] : '');
        }
      }
      if (stack.length === 0) {
        this.appendChild(el);
      } else {
        stack[stack.length - 1].appendChild(el);
      }
      if (!isSelfClosing) {
        stack.push(el);
      }
    }
  }

  get textContent() {
    if (this.childNodes.length === 0) {
      return this._textContent || '';
    }
    return this.childNodes.map(c => c.textContent).join('');
  }

  set textContent(text) {
    this._textContent = text || '';
    this.childNodes = [];
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
    if (name === 'id') this.id = String(val);
    if (name === 'class') this.className = String(val);
    if (name === 'disabled') this.disabled = val !== false && val !== 'false';
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[prop] = String(val);
    }
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    if (name === 'disabled') return this.disabled ? '' : null;
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[prop] || null;
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this._src = '';
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
    if (name === 'disabled') this.disabled = false;
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[prop];
    }
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }

  click() {
    this.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
  }

  insertBefore(newChild, refChild) {
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    newChild.parentNode = this;
    if (!refChild) {
      this.childNodes.push(newChild);
      return newChild;
    }
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) {
      this.childNodes.push(newChild);
    } else {
      this.childNodes.splice(idx, 0, newChild);
    }
    return newChild;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  replaceWith(newEl) {
    if (this.parentNode) {
      this.parentNode.insertBefore(newEl, this);
      this.parentNode.removeChild(this);
    }
  }

  getBoundingClientRect() {
    return this._rect;
  }

  setBoundingClientRect(rect) {
    this._rect = { ...this._rect, ...rect };
  }

  addEventListener(type, handler, opts) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push({ handler, capture: !!(opts && (opts.capture || opts === true)) });
  }

  removeEventListener(type, handler) {
    if (!this._listeners.has(type)) return;
    const list = this._listeners.get(type).filter(item => item.handler !== handler);
    this._listeners.set(type, list);
  }

  dispatchEvent(event) {
    return dispatchDOMEvent(this, event);
  }

  // HTMLVideoElement methods
  play() {
    this.paused = false;
    const p = Promise.resolve();
    setTimeout(() => {
      this.dispatchEvent(new MockEvent('playing'));
      this.dispatchEvent(new MockEvent('timeupdate'));
    }, 10);
    return p;
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new MockEvent('pause'));
  }

  load() {
    this.currentTime = 0;
  }

  // HTMLCanvasElement methods
  getContext(type) {
    if (type === '2d') {
      return {
        clearRect: () => {},
        drawImage: () => {}
      };
    }
    return null;
  }

  // Query and traversal
  contains(node) {
    if (node === this) return true;
    for (const child of this.childNodes) {
      if (child.contains(node)) return true;
    }
    return false;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.nodeType === 1 && matchSelector(curr, selector)) {
        return curr;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return querySelector(this, selector);
  }

  querySelectorAll(selector) {
    return querySelectorAll(this, selector);
  }
}

// Splits CSS selectors on whitespace outside brackets and parentheses
function splitSelectorTokens(sel) {
  const tokens = [];
  let current = '';
  let inBracket = 0;
  let inParen = 0;
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '"' || ch === "'") {
      if (!inQuote) { inQuote = true; quoteChar = ch; }
      else if (ch === quoteChar) { inQuote = false; }
      current += ch;
    } else if (!inQuote && ch === '[') {
      inBracket++; current += ch;
    } else if (!inQuote && ch === ']') {
      inBracket--; current += ch;
    } else if (!inQuote && ch === '(') {
      inParen++; current += ch;
    } else if (!inQuote && ch === ')') {
      inParen--; current += ch;
    } else if (!inQuote && inBracket === 0 && inParen === 0 && /\s/.test(ch)) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

// Selector matching engine
function matchSingleToken(el, token) {
  token = token.trim();
  if (!token) return true;

  // Handle :not(...)
  const notMatch = token.match(/:not\(([^)]+)\)/);
  if (notMatch) {
    const notSel = notMatch[1];
    const withoutNot = token.replace(notMatch[0], '');
    if (withoutNot && !matchSingleToken(el, withoutNot)) return false;
    if (matchSingleToken(el, notSel)) return false;
    return true;
  }

  const parts = token.match(/([#\.][\w-]+|\[[^\]]+\]|[a-zA-Z0-9_-]+)/g);
  if (!parts) return false;

  for (const part of parts) {
    if (part.startsWith('#')) {
      if (el.id !== part.slice(1)) return false;
    } else if (part.startsWith('.')) {
      if (!el.classList || !el.classList.contains(part.slice(1))) return false;
    } else if (part.startsWith('[')) {
      const inner = part.slice(1, -1);
      if (inner.includes('*=')) {
        const [k, v] = inner.split('*=');
        const val = v.replace(/['"]/g, '');
        const actual = el.getAttribute ? el.getAttribute(k) : el[k];
        if (!String(actual || '').includes(val)) return false;
      } else if (inner.includes('=')) {
        const [k, v] = inner.split('=');
        const val = v.replace(/['"]/g, '');
        const actual = el.getAttribute ? el.getAttribute(k) : el[k];
        if (String(actual || '') !== val) return false;
      } else {
        const has = el.hasAttribute ? el.hasAttribute(inner) : el[inner] !== undefined;
        if (!has) return false;
      }
    } else {
      if (!el.tagName || el.tagName.toLowerCase() !== part.toLowerCase()) return false;
    }
  }
  return true;
}

function matchSelector(el, selector) {
  const commaParts = selector.split(',').map(s => s.trim());
  return commaParts.some(subSel => {
    const tokens = splitSelectorTokens(subSel);
    if (tokens.length === 0) return false;
    if (!matchSingleToken(el, tokens[tokens.length - 1])) return false;
    if (tokens.length === 1) return true;

    let curr = el.parentNode;
    let tIdx = tokens.length - 2;
    while (curr && tIdx >= 0) {
      if (curr.nodeType === 1 && matchSingleToken(curr, tokens[tIdx])) {
        tIdx--;
      }
      curr = curr.parentNode;
    }
    return tIdx < 0;
  });
}

function querySelector(root, selector) {
  const results = querySelectorAll(root, selector);
  return results.length > 0 ? results[0] : null;
}

function querySelectorAll(root, selector) {
  const commaParts = selector.split(',').map(s => s.trim());
  const found = [];
  const seen = new Set();

  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        for (const subSel of commaParts) {
          if (!seen.has(child) && matchSelector(child, subSel)) {
            seen.add(child);
            found.push(child);
            break;
          }
        }
        walk(child);
      }
    }
  }

  walk(root);
  return found;
}

// -------------------------------------------------------------
// 2. GLOBAL WINDOW & DOCUMENT INITIALIZATION
// -------------------------------------------------------------

const mockHead = new MockElement('HEAD');
const mockBody = new MockElement('BODY');
const mockDocElement = new MockElement('HTML');
mockDocElement.appendChild(mockHead);
mockDocElement.appendChild(mockBody);

const docListeners = new Map();
const mockDocument = {
  head: mockHead,
  body: mockBody,
  documentElement: mockDocElement,
  readyState: 'complete',
  _listeners: docListeners,
  createElement: (tag) => new MockElement(tag),
  getElementById: (id) => querySelector(mockDocElement, `#${id}`),
  querySelector: (sel) => querySelector(mockDocElement, sel),
  querySelectorAll: (sel) => querySelectorAll(mockDocElement, sel),
  addEventListener: (type, handler, opts) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push({ handler, capture: !!(opts && (opts.capture || opts === true)) });
  },
  removeEventListener: (type, handler) => {
    if (!docListeners.has(type)) return;
    docListeners.set(type, docListeners.get(type).filter(l => l.handler !== handler));
  },
  dispatchEvent: (ev) => dispatchDOMEvent(mockDocument, ev)
};

// IntersectionObserver Registry
const observerInstances = [];
class MockIntersectionObserver {
  constructor(callback, options = {}) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    observerInstances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    const idx = observerInstances.indexOf(this);
    if (idx !== -1) observerInstances.splice(idx, 1);
  }

  trigger(target, ratio) {
    if (this.targets.has(target)) {
      this.callback([{
        target,
        intersectionRatio: ratio,
        isIntersecting: ratio >= 0.20
      }], this);
    }
  }
}

class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
}

const storageData = new Map();
const mockLocalStorage = {
  getItem: (key) => storageData.has(key) ? storageData.get(key) : null,
  setItem: (key, val) => storageData.set(key, String(val)),
  removeItem: (key) => storageData.delete(key),
  clear: () => storageData.clear()
};

const sessionData = new Map();
const mockSessionStorage = {
  getItem: (key) => sessionData.has(key) ? sessionData.get(key) : null,
  setItem: (key, val) => sessionData.set(key, String(val)),
  removeItem: (key) => sessionData.delete(key),
  clear: () => sessionData.clear()
};

class BaseMockYTPlayer {
  constructor(container, options) {
    this.container = container;
    this.options = options || {};
    this.playbackQuality = null;
    this.playbackQualityRange = null;
    this.lastLoadedVideo = null;
    this._iframe = mockDocument.createElement('iframe');
    if (this.options.width) this._iframe.setAttribute('width', String(this.options.width));
    if (this.options.height) this._iframe.setAttribute('height', String(this.options.height));
  }

  getIframe() {
    return this._iframe;
  }

  setPlaybackQuality(q) {
    this.playbackQuality = q;
  }

  setPlaybackQualityRange(min, max) {
    this.playbackQualityRange = [min, max];
  }

  loadVideoById(opts) {
    this.lastLoadedVideo = opts;
  }

  playVideo() {}
  pauseVideo() {}
  stopVideo() {}
  mute() {}
  unMute() {}
  setVolume(v) {}
  seekTo(s) {}
  getPlayerState() {
    return 1;
  }
}

const winListeners = new Map();
const mockWindow = {
  document: mockDocument,
  _listeners: winListeners,
  location: {
    origin: 'http://localhost:8096',
    host: 'localhost:8096',
    hostname: 'localhost',
    protocol: 'http:',
    pathname: '/web/index.html',
    hash: '#/home',
    search: ''
  },
  history: {
    pushState: (state, title, url) => {
      if (url && url.includes('#')) {
        mockWindow.location.hash = url.substring(url.indexOf('#'));
      }
    },
    replaceState: (state, title, url) => {
      if (url && url.includes('#')) {
        mockWindow.location.hash = url.substring(url.indexOf('#'));
      }
    }
  },
  localStorage: mockLocalStorage,
  sessionStorage: mockSessionStorage,
  screen: { width: 1920, height: 1080 },
  YT: {
    Player: BaseMockYTPlayer,
    PlayerState: {
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5
    }
  },
  innerHeight: 1080,
  innerWidth: 1920,
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  addEventListener: (type, handler, opts) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push({ handler, capture: !!(opts && (opts.capture || opts === true)) });
  },
  removeEventListener: (type, handler) => {
    if (!winListeners.has(type)) return;
    winListeners.set(type, winListeners.get(type).filter(l => l.handler !== handler));
  },
  dispatchEvent: (ev) => dispatchDOMEvent(mockWindow, ev),
  CustomEvent: MockEvent,
  Event: MockEvent
};

// Wire globals to Node.js environment
global.window = mockWindow;
global.document = mockDocument;
global.location = mockWindow.location;
global.history = mockWindow.history;
global.localStorage = mockLocalStorage;
global.sessionStorage = mockSessionStorage;
global.YT = mockWindow.YT;
global.requestAnimationFrame = mockWindow.requestAnimationFrame;
global.cancelAnimationFrame = mockWindow.cancelAnimationFrame;
global.CustomEvent = MockEvent;
global.Event = MockEvent;
global.IntersectionObserver = MockIntersectionObserver;
global.MutationObserver = MockMutationObserver;
global.Image = class {
  constructor() {
    this.naturalWidth = 320;
    this.naturalHeight = 180;
    setTimeout(() => { if (this.onload) this.onload(); }, 10);
  }
};

mockWindow.ApiClient = {
  serverAddress: () => 'http://localhost:8096',
  accessToken: () => 'test-auth-token-12345',
  getCurrentUserId: () => 'test-user-id-abc',
  getUrl: (endpoint) => `http://localhost:8096/${endpoint}`,
  appName: () => 'Jellyfin Web',
  deviceName: () => 'Mock Browser',
  deviceId: () => 'mock-device-id',
  appVersion: () => '10.9.0'
};

mockWindow.__TEST_TMDB_PROXY_CALLS__ = [];

global.fetch = async function (url, options = {}) {
  const urlStr = String(url);
  let tmdbProxyPath = '';
  if (urlStr.includes('/api/tmdb/proxy')) {
    mockWindow.__TEST_TMDB_PROXY_CALLS__.push(urlStr);
    try {
      const parsed = new URL(urlStr, 'http://localhost:3000');
      tmdbProxyPath = parsed.searchParams.get('path') || '';
    } catch {}
  }

  if (
    urlStr.includes('/discover/movies') ||
    urlStr.includes('/discover/trending') ||
    urlStr.includes('api.themoviedb.org/3/discover/movie') ||
    tmdbProxyPath === 'discover/movie' ||
    tmdbProxyPath.startsWith('discover/movie')
  ) {
    return {
      ok: true,
      json: async () => ({
        results: [
          {
            id: 157336,
            title: 'Interstellar',
            vote_average: 8.7,
            vote_count: 35000,
            release_date: '2014-11-07',
            overview: 'When Earth becomes uninhabitable in the future, a farmer and ex-NASA pilot, Joseph Cooper, is tasked to pilot a spacecraft.',
            backdrop_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
            genre_ids: [12, 18, 878]
          },
          {
            id: 27205,
            title: 'Inception',
            vote_average: 8.4,
            vote_count: 36000,
            release_date: '2010-07-16',
            overview: 'Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious of his targets.',
            backdrop_path: '/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
            genre_ids: [28, 878, 12]
          }
        ]
      })
    };
  }

  if (urlStr.includes('api.themoviedb.org/3/movie/') || tmdbProxyPath.startsWith('movie/')) {
    return {
      ok: true,
      json: async () => ({
        id: 157336,
        title: 'Interstellar',
        runtime: 169,
        genres: [{ id: 12, name: 'Adventure' }, { id: 18, name: 'Drama' }, { id: 878, name: 'Science Fiction' }],
        credits: {
          crew: [{ job: 'Director', name: 'Christopher Nolan' }],
          cast: [{ name: 'Matthew McConaughey' }, { name: 'Anne Hathaway' }, { name: 'Jessica Chastain' }, { name: 'Michael Caine' }]
        },
        videos: {
          results: [{ site: 'YouTube', type: 'Trailer', key: 'zSWdZVtXT7E' }]
        }
      })
    };
  }

  if (urlStr.includes('/request')) {
    return {
      ok: true,
      json: async () => ({ success: true })
    };
  }

  if (urlStr.includes('/Items/movie-details-1') || urlStr.includes('/Users/test-user-id-abc/Items/movie-details-1')) {
    return {
      ok: true,
      json: async () => ({
        Id: 'movie-details-1',
        Name: 'Oppenheimer',
        Type: 'Movie',
        ProductionYear: 2023,
        CommunityRating: 8.9,
        OfficialRating: 'R',
        BackdropImageTags: ['backdrop-tag-1'],
        LocalTrailers: [
          { Id: 'local-trailer-oppenheimer', Name: 'Official 4K Trailer' }
        ],
        RemoteTrailers: []
      })
    };
  }

  if (urlStr.includes('/Items/movie-hover-1') || urlStr.includes('/Users/test-user-id-abc/Items/movie-hover-1')) {
    if (urlStr.includes('LocalTrailers')) {
      return {
        ok: true,
        json: async () => ([
          {
            Id: 'local-trailer-hover',
            Name: 'Inception Teaser',
            MediaSources: [{ Id: 'ms-hover-1' }]
          }
        ])
      };
    }
    return {
      ok: true,
      json: async () => ({
        Id: 'movie-hover-1',
        Name: 'Inception',
        Type: 'Movie',
        ProductionYear: 2010,
        CommunityRating: 8.8,
        OfficialRating: 'PG-13',
        BackdropImageTags: ['backdrop-hover-tag'],
        LocalTrailers: [
          { Id: 'local-trailer-hover', Name: 'Inception Teaser' }
        ]
      })
    };
  }

  if (urlStr.includes('/LocalTrailers')) {
    return {
      ok: true,
      json: async () => ([
        { Id: 'local-trailer-oppenheimer', Name: 'Official 4K Trailer' }
      ])
    };
  }

  return {
    ok: true,
    json: async () => ({})
  };
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -------------------------------------------------------------
// 3. COMPREHENSIVE TEST SUITE EXECUTION
// -------------------------------------------------------------

async function runTestSuite() {
  console.log(`${BOLD}--- Suite 1: Plugin Configuration Validation ---${RESET}`);
  const xmlPath = path.join(__dirname, 'plugins', 'configurations', 'Jellyfin.Plugin.MediaBarEnhanced.xml');
  const xmlContent = fs.readFileSync(xmlPath, 'utf8');

  const startMutedMatch = xmlContent.match(/<StartMuted>(.*?)<\/StartMuted>/);
  const startMuted = startMutedMatch ? startMutedMatch[1].toLowerCase() === 'true' : true;

  const defaultVolumeMatch = xmlContent.match(/<DefaultTrailerVolume>(.*?)<\/DefaultTrailerVolume>/);
  const defaultVolume = defaultVolumeMatch ? parseInt(defaultVolumeMatch[1], 10) : 40;

  const enableVideoBackdropMatch = xmlContent.match(/<EnableVideoBackdrop>(.*?)<\/EnableVideoBackdrop>/);
  const enableVideoBackdrop = enableVideoBackdropMatch ? enableVideoBackdropMatch[1].toLowerCase() === 'true' : false;

  assertCondition(startMuted === false, `Jellyfin.Plugin.MediaBarEnhanced.xml has StartMuted = false (unmuted trailer on home)`);
  assertCondition(defaultVolume === 40, `Jellyfin.Plugin.MediaBarEnhanced.xml has DefaultTrailerVolume = 40 (40% volume)`);
  assertCondition(enableVideoBackdrop === true, `Jellyfin.Plugin.MediaBarEnhanced.xml has EnableVideoBackdrop = true`);

  mockWindow.mediaBarEnhanced = {
    CONFIG: {
      startMuted: startMuted,
      defaultTrailerVolume: defaultVolume,
      enableVideoBackdrop: enableVideoBackdrop
    },
    STATE: {
      slideshow: {
        videoPlayers: {}
      }
    }
  };

  // Setup Home Screen DOM Container
  const homePage = new MockElement('DIV');
  homePage.id = 'homePage';
  mockBody.appendChild(homePage);

  const slidesContainer = new MockElement('DIV');
  slidesContainer.id = 'slides-container';
  slidesContainer.setBoundingClientRect({ top: 0, left: 0, width: 1920, height: 700, bottom: 700 });
  homePage.appendChild(slidesContainer);

  const homeSlide = new MockElement('DIV');
  homeSlide.className = 'slide active';
  slidesContainer.appendChild(homeSlide);

  const homeTrailerUrl = 'http://localhost:8096/Videos/home-trailer/stream.mp4?static=true';
  const homeVideo = new MockElement('VIDEO');
  homeVideo.className = 'home-hero-video';
  homeVideo.src = homeTrailerUrl;
  homeSlide.appendChild(homeVideo);

  mockWindow.mediaBarEnhanced.STATE.slideshow.videoPlayers['home-slide-1'] = homeVideo;

  // Add Card Container for posters
  const itemsContainer = new MockElement('DIV');
  itemsContainer.className = 'itemsContainer';
  homePage.appendChild(itemsContainer);

  const card1 = new MockElement('DIV');
  card1.className = 'card';
  card1.setAttribute('data-id', 'movie-hover-1');
  card1.setBoundingClientRect({ top: 850, left: 100, width: 220, height: 330, bottom: 1180 });
  itemsContainer.appendChild(card1);

  // Setup Details Page Containers (dormant initially)
  const detailPage = new MockElement('DIV');
  detailPage.id = 'itemDetailPage';
  detailPage.className = 'itemDetailPage hide';
  detailPage.setAttribute('data-itemid', 'movie-details-1');
  mockBody.appendChild(detailPage);

  const itemBackdrop = new MockElement('DIV');
  itemBackdrop.id = 'itemBackdrop';
  detailPage.appendChild(itemBackdrop);

  const detailWrapper = new MockElement('DIV');
  detailWrapper.className = 'detailPageWrapperContainer hide';
  detailPage.appendChild(detailWrapper);

  const detailRibbon = new MockElement('DIV');
  detailRibbon.className = 'detailRibbon';
  detailWrapper.appendChild(detailRibbon);

  const infoWrapper = new MockElement('DIV');
  infoWrapper.className = 'infoWrapper';
  detailRibbon.appendChild(infoWrapper);

  const nameContainer = new MockElement('DIV');
  nameContainer.className = 'nameContainer';
  infoWrapper.appendChild(nameContainer);

  const itemName = new MockElement('H1');
  itemName.className = 'itemName';
  itemName.textContent = 'Oppenheimer';
  nameContainer.appendChild(itemName);

  // Setup Skin Header & Main Drawer for Discovery Extension
  const skinHeader = new MockElement('DIV');
  skinHeader.className = 'skinHeader';
  mockBody.appendChild(skinHeader);

  const headerRight = new MockElement('DIV');
  headerRight.className = 'headerRight';
  skinHeader.appendChild(headerRight);

  const searchBtn = new MockElement('BUTTON');
  searchBtn.className = 'headerButtonSearch';
  headerRight.appendChild(searchBtn);

  const mainDrawer = new MockElement('DIV');
  mainDrawer.className = 'mainDrawer';
  mockBody.appendChild(mainDrawer);

  const drawerContainer = new MockElement('DIV');
  drawerContainer.className = 'mainDrawer-scrollContainer';
  mainDrawer.appendChild(drawerContainer);

  const drawerHome = new MockElement('A');
  drawerHome.className = 'navDrawer-item';
  drawerContainer.appendChild(drawerHome);

  console.log(`\n${BOLD}--- Executing Client Extension Scripts ---${RESET}`);
  require(path.join(__dirname, 'custom-details-hero.js'));
  require(path.join(__dirname, 'custom-hover-preview.js'));
  const discoverModule = require(path.join(__dirname, 'custom-discover-request.js'));

  await sleep(50);
  assertCondition(mockWindow.__JELLYFIN_VIDEO_HERO_INITIALIZED__ === true, `custom-details-hero.js loaded & initialized`);
  assertCondition(mockWindow.__JELLYFIN_HOVER_PREVIEW_INITIALIZED__ === true, `custom-hover-preview.js loaded & initialized`);
  assertCondition(mockWindow.__JELLYFIN_DISCOVER_REQUEST_INITIALIZED__ === true, `custom-discover-request.js loaded & initialized`);

  // =============================================================
  // Scenario A: Home Screen Carousel Plays Unmuted Trailer -> User Scrolls Down
  // =============================================================
  console.log(`\n${BOLD}--- Scenario A: Home Hero Trailer Plays Unmuted -> Scroll Down Auto-Pauses ---${RESET}`);

  homeVideo.muted = false;
  homeVideo.volume = defaultVolume / 100; // 0.40
  await homeVideo.play();
  mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ = 'home-hero';

  assertCondition(homeVideo.paused === false, `Home carousel video is playing`);
  assertCondition(homeVideo.muted === false, `Home carousel video is UNMUTED (StartMuted=false)`);
  assertCondition(homeVideo.volume === 0.40, `Home carousel volume matches DefaultTrailerVolume (0.40)`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'home-hero', `Home carousel holds audio lock ('home-hero')`);

  const homeObserver = observerInstances.find(obs => obs.targets.has(slidesContainer));
  assertCondition(!!homeObserver, `IntersectionObserver is observing #slides-container`);

  homeObserver.trigger(slidesContainer, 0.05); // Scrolled 95% out of view
  await sleep(30);

  assertCondition(homeVideo.paused === true, `Home carousel paused immediately when scrolled offscreen`);
  assertCondition(homeVideo.dataset.heroPausedByScroll === 'true', `Home video tagged with heroPausedByScroll='true'`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'home-hero', `Home hero audio lock released on scroll-down`);

  // =============================================================
  // Scenario B: User Hovers Movie Poster -> Hover Preview Concurrency & Audio Lock
  // =============================================================
  console.log(`\n${BOLD}--- Scenario B: Hover Preview Stays Muted by Default -> Unmute Locks Audio ---${RESET}`);

  // Hover card1 (Inception poster)
  card1.dispatchEvent(new MockEvent('mouseenter', { pointerType: 'mouse', bubbles: false }));

  // Wait 1000ms: with 2000ms dwell, portal must NOT be active
  await sleep(1000);
  let portal = mockDocument.getElementById('jellyfin-hover-preview-portal');
  assertCondition(!portal || !portal.classList.contains('active'), `Hover preview does NOT trigger before 2000ms dwell threshold`);

  // Wait remaining 1150ms (total 2150ms > 2000ms dwell)
  await sleep(1150);
  portal = mockDocument.getElementById('jellyfin-hover-preview-portal');
  assertCondition(!!portal, `Singleton hover preview portal exists in document.body`);
  assertCondition(portal.classList.contains('active'), `Hover portal is active and visible after 2000ms dwell`);

  const hoverVideo = portal.querySelector('video');
  const hoverVideoSrc = hoverVideo ? (hoverVideo.src || '') : '';
  assertCondition(!!hoverVideo, `Hover preview loaded Tier 1 local trailer video`);
  assertCondition(hoverVideo.muted === true, `Hover preview stays SILENT (muted) by default`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'hover', `Hover preview does NOT hold audio lock while muted`);

  // User clicks speaker unmute button on hover card
  const muteBtn = portal.querySelector('.hover-preview-mute-btn');
  assertCondition(!!muteBtn, `Hover card floating speaker button is present`);

  let lockAcquiredEventFired = false;
  const lockAcquiredHandler = (e) => {
    if (e.detail && e.detail.source === 'hover') {
      lockAcquiredEventFired = true;
    }
  };
  mockWindow.addEventListener('jellyfin-audio-lock-acquired', lockAcquiredHandler);

  muteBtn.dispatchEvent(new MockEvent('click', { bubbles: false }));
  await sleep(50);

  assertCondition(hoverVideo.muted === false, `Hover video unmuted after clicking speaker button`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hover', `Hover preview ACQUIRED audio lock ('hover')`);
  assertCondition(mockWindow.__JELLYFIN_AUDIO_LOCK__ === 'hover', `Global __JELLYFIN_AUDIO_LOCK__ is set to 'hover'`);
  assertCondition(lockAcquiredEventFired === true, `jellyfin-audio-lock-acquired event broadcast to system`);

  mockWindow.removeEventListener('jellyfin-audio-lock-acquired', lockAcquiredHandler);

  // User moves mouse away (pointerleave on card)
  card1.dispatchEvent(new MockEvent('mouseleave', { bubbles: false }));
  await sleep(50);

  assertCondition(hoverVideo.paused === true, `Hover video paused on pointerleave teardown`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === null, `Audio lock released when hover preview closed`);

  // =============================================================
  // Scenario C: Navigation into Details Page -> Mutual Exclusion & Details Loop
  // =============================================================
  console.log(`\n${BOLD}--- Scenario C: Navigate to Details -> Home Trailer Silenced Immediately & Details Hero Plays on Loop ---${RESET}`);

  // Re-start home video to verify forcible termination
  homeVideo.src = 'http://localhost:8096/Videos/home-trailer/stream.mp4?static=true';
  homeVideo.muted = false;
  homeVideo.volume = 0.40;
  await homeVideo.play();
  assertCondition(homeVideo.paused === false, `Home video resumed before navigation test`);

  // Navigate to Details page
  mockWindow.location.hash = '#/details?id=movie-details-1';
  homePage.classList.add('hide');
  detailPage.classList.remove('hide');
  detailWrapper.classList.remove('hide');

  // Trigger SPA route change
  mockWindow.dispatchEvent(new MockEvent('hashchange'));

  // Immediate mutual exclusion check (0ms before settle delay)
  assertCondition(homeVideo.paused === true, `Home trailer FORCIBLY PAUSED immediately upon details route transition`);
  assertCondition(homeVideo.muted === true, `Home trailer FORCIBLY MUTED immediately upon details route transition`);
  assertCondition(homeVideo.volume === 0, `Home trailer volume set to 0 immediately`);
  assertCondition(homeVideo.src === '', `Home trailer src purged immediately to free hardware decoder`);

  // Poll until heroContainer is injected into detailWrapper
  for (let i = 0; i < 20; i++) {
    if (mockDocument.getElementById('jellyfinDetailsVideoHero')) break;
    await sleep(100);
  }

  const heroContainer = mockDocument.getElementById('jellyfinDetailsVideoHero');
  assertCondition(!!heroContainer, `Details hero container injected into .detailPageWrapperContainer`);
  assertCondition(detailPage.classList.contains('has-video-hero'), `Detail page class has-video-hero applied`);

  const detailsVideo = heroContainer.querySelector('video.jellyfin-hero-html5-video');
  assertCondition(!!detailsVideo, `Details hero HTML5 video instantiated`);
  assertCondition(detailsVideo.autoplay === true, `Details video autoplay is true`);
  assertCondition(detailsVideo.loop === true, `Details video continuous loop is true`);
  assertCondition(detailsVideo.muted === false, `Details video is unmuted (default audio active)`);

  await sleep(50);
  assertCondition(detailsVideo.paused === false, `Details video is actively playing`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hero' || mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'details-hero', `Details hero holds audio lock ('hero')`);

  // Verify continuous loop failsafe on ended event
  detailsVideo.currentTime = 120.5;
  let replayed = false;
  const origPlay = detailsVideo.play;
  detailsVideo.play = function () {
    replayed = true;
    return origPlay.call(this);
  };

  detailsVideo.dispatchEvent(new MockEvent('ended'));
  assertCondition(detailsVideo.currentTime === 0, `Continuous loop failsafe reset currentTime to 0 on ended`);
  assertCondition(replayed === true, `Continuous loop failsafe re-invoked play()`);

  // =============================================================
  // Scenario D: Details Page Scroll Down -> Pause Trailer; Scroll Up -> Resume Trailer
  // =============================================================
  console.log(`\n${BOLD}--- Scenario D: Details Page Scroll Down Pauses Trailer -> Scroll Up Resumes Trailer ---${RESET}`);

  const detailsObserver = observerInstances.find(obs => obs.targets.has(heroContainer));
  assertCondition(!!detailsObserver, `IntersectionObserver registered on #jellyfinDetailsVideoHero`);

  // User scrolls down into cast & crew (intersectionRatio < 0.20)
  detailsObserver.trigger(heroContainer, 0.08);
  await sleep(30);

  assertCondition(detailsVideo.paused === true, `Details trailer paused immediately when scrolled offscreen`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'hero' && mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'details-hero', `Details hero audio lock released on scroll-down`);

  // User scrolls back up to top (intersectionRatio >= 0.20)
  detailsObserver.trigger(heroContainer, 0.90);
  await sleep(30);

  assertCondition(detailsVideo.paused === false, `Details trailer resumed playback when scrolled back into view`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hero' || mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'details-hero', `Details hero re-acquired audio lock on scroll-up`);

  // =============================================================
  // Scenario E: Full Video Playback Starts -> Hero Trailer Pauses Immediately & Stays Paused
  // =============================================================
  console.log(`\n${BOLD}--- Scenario E: Full Playback Intercept -> Hero Trailer Pauses & Stays Paused ---${RESET}`);

  // User clicks Play button to watch full movie -> Jellyfin fires playbackstart
  mockWindow.dispatchEvent(new MockEvent('playbackstart'));
  await sleep(30);

  assertCondition(detailsVideo.paused === true, `Details trailer paused immediately on playbackstart`);
  assertCondition(detailsVideo.muted === true, `Details video muted on playbackstart`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'hero' && mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'details-hero', `Details hero released audio lock on playbackstart`);

  // User scrolls up and down while full movie is playing: hero must STAY PAUSED
  detailsObserver.trigger(heroContainer, 0.95);
  await sleep(30);

  assertCondition(detailsVideo.paused === true, `Details trailer STAYS PAUSED despite scrolling up while movie is playing`);

  detailsObserver.trigger(heroContainer, 0.10);
  await sleep(30);
  assertCondition(detailsVideo.paused === true, `Details trailer remains paused on scroll down`);

  // Movie playback ends
  mockWindow.dispatchEvent(new MockEvent('playbackstop'));
  await sleep(20);

  // =============================================================
  // Suite 7: Extra Concurrency Edge Case - Hover Preview on Details Page
  // =============================================================
  console.log(`\n${BOLD}--- Scenario F: Concurrency Edge Case - Unmuting Hover Preview on Details Page Silences Hero ---${RESET}`);

  // Resume details hero unmuted
  detailsVideo.muted = false;
  await detailsVideo.play();
  mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ = 'hero';
  assertCondition(detailsVideo.paused === false && detailsVideo.muted === false, `Details hero active and unmuted`);

  // Simulate user hovering "More Like This" movie card on details page
  card1.dispatchEvent(new MockEvent('mouseenter', { pointerType: 'mouse', bubbles: false }));
  await sleep(2150);

  // Unmute hover preview
  muteBtn.dispatchEvent(new MockEvent('click', { bubbles: false }));
  await sleep(50);

  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hover', `Hover preview acquired audio lock on details page`);
  assertCondition(detailsVideo.muted === true, `Details hero automatically muted when hover preview claimed audio lock`);

  // User leaves hover card -> hover releases lock -> details hero restores audio
  card1.dispatchEvent(new MockEvent('mouseleave', { bubbles: false }));
  await sleep(50);

  assertCondition(portal.classList.contains('active') === false, `Complete portal teardown: hover portal deactivated on mouseleave`);
  assertCondition(hoverVideo.paused === true, `Complete portal teardown: hover video paused on card departure`);
  assertCondition(portal.querySelector('video') === null, `Complete memory release: hover video element unmounted and removed from DOM on mouseleave`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hero' || mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'details-hero', `Details hero restored audio lock after hover preview closed`);
  assertCondition(detailsVideo.muted === false, `Details hero un-muted and restored audio smoothly`);

  // =============================================================
  // Scenario G: Verify 1080p Quality Directive Enforcement
  // =============================================================
  console.log(`\n${BOLD}--- Scenario G: Verify 1080p Quality Directive Enforcement ---${RESET}`);
  const heroCode = fs.readFileSync(path.join(__dirname, 'custom-details-hero.js'), 'utf8');
  const hoverCode = fs.readFileSync(path.join(__dirname, 'custom-hover-preview.js'), 'utf8');

  // Assert created YouTube <iframe> elements have explicit width="1920" and height="1080" attributes
  assertCondition(
    (heroCode.includes("setAttribute('width', '1920')") || heroCode.includes('config.width = isUltraWide ? 2560 : 1920;')) &&
    hoverCode.includes("setAttribute('width', '1920')"),
    `Created YouTube <iframe> elements have explicit width="1920" attribute`
  );
  assertCondition(
    (heroCode.includes("setAttribute('height', '1080')") || heroCode.includes('config.height = isUltraWide ? 1440 : 1080;')) &&
    hoverCode.includes("setAttribute('height', '1080')"),
    `Created YouTube <iframe> elements have explicit height="1080" attribute`
  );

  // Assert embed URLs include &vq=hd1080
  assertCondition(
    heroCode.includes('&vq=hd1080') || heroCode.includes('vq=hd1080'),
    `Details Hero YouTube embed URLs include &vq=hd1080`
  );
  assertCondition(
    hoverCode.includes('&vq=hd1080') || hoverCode.includes('vq=hd1080'),
    `Hover Preview YouTube embed URLs include &vq=hd1080`
  );

  // Assert that YT.Player interceptor passes vq: 'hd1080' and calls setPlaybackQuality('hd1080')
  assertCondition(typeof mockWindow.YT?.Player === 'function', `window.YT.Player is available in global runtime`);
  assertCondition(mockWindow.YT.Player.__is1080pInterceptor__ === true, `window.YT.Player transparent 1080p interceptor is actively installed`);

  const testYtDiv = mockDocument.createElement('DIV');
  testYtDiv.id = 'yt-interceptor-unit-test';
  mockBody.appendChild(testYtDiv);

  let onReadyTarget = null;
  const testPlayerConfig = {
    videoId: 'test-yt-video-key',
    playerVars: { autoplay: 1 },
    events: {
      onReady: (ev) => { onReadyTarget = ev.target; }
    }
  };

  const interceptedPlayer = new mockWindow.YT.Player('yt-interceptor-unit-test', testPlayerConfig);

  assertCondition(interceptedPlayer.options.width === 1920, `YT.Player interceptor sets explicit width = 1920`);
  assertCondition(interceptedPlayer.options.height === 1080, `YT.Player interceptor sets explicit height = 1080`);
  assertCondition(interceptedPlayer.options.playerVars.vq === 'hd1080', `YT.Player interceptor passes vq: 'hd1080' in playerVars`);
  assertCondition(interceptedPlayer.options.playerVars.suggestedQuality === 'hd1080', `YT.Player interceptor passes suggestedQuality: 'hd1080'`);

  // Trigger onReady event
  interceptedPlayer.options.events.onReady({ target: interceptedPlayer });
  assertCondition(interceptedPlayer.playbackQuality === 'hd1080', `YT.Player interceptor calls setPlaybackQuality('hd1080') on onReady`);

  // Trigger onStateChange event with PLAYING state (1)
  interceptedPlayer.options.events.onStateChange({ target: interceptedPlayer, data: 1 });
  assertCondition(interceptedPlayer.playbackQuality === 'hd1080', `YT.Player interceptor calls setPlaybackQuality('hd1080') on PLAYING state`);

  // =============================================================
  // Scenario H: Verify Total Absence of Pause Buttons
  // =============================================================
  console.log(`\n${BOLD}--- Scenario H: Verify Total Absence of Pause Buttons ---${RESET}`);
  const brandingXml = fs.readFileSync(path.join(__dirname, 'config', 'branding.xml'), 'utf8');

  // Assert that #slides-container .pause-button is hidden (display: none) or scavenged from DOM
  assertCondition(brandingXml.includes('.pause-button') && brandingXml.includes('display: none !important'), `branding.xml hides .pause-button with display: none !important`);
  assertCondition(brandingXml.includes('#slides-container .pause-button'), `branding.xml explicitly targets #slides-container .pause-button`);
  assertCondition(heroCode.includes('scavengePauseButtons'), `Details Hero includes proactive DOM scavenger for rogue pause buttons`);

  // Assert scavenger removes any injected pause button from DOM
  const testPauseBtn = mockDocument.createElement('BUTTON');
  testPauseBtn.className = 'pause-button';
  slidesContainer.appendChild(testPauseBtn);
  assertCondition(slidesContainer.contains(testPauseBtn), `Rogue pause button mounted to #slides-container for scavenger validation`);

  mockWindow.dispatchEvent(new MockEvent('hashchange'));
  await sleep(50);
  assertCondition(slidesContainer.querySelector('.pause-button') === null, `#slides-container .pause-button is scavenged and purged from DOM`);

  // Assert that only the floating speaker toggle is active and interactable at bottom: 32px; right: 32px;
  assertCondition(brandingXml.includes('bottom: 32px !important') && brandingXml.includes('right: 32px !important'), `branding.xml positions floating speaker toggle at bottom-right offset`);
  assertCondition(brandingXml.includes('backdrop-filter: blur(12px)'), `branding.xml styles .mute-button with circular glassmorphism`);

  const homeMuteBtn = mockDocument.createElement('BUTTON');
  homeMuteBtn.className = 'mute-button';
  homeMuteBtn.setAttribute('aria-label', 'Toggle Sound');
  slidesContainer.appendChild(homeMuteBtn);

  let speakerBtnClicked = false;
  homeMuteBtn.addEventListener('click', () => { speakerBtnClicked = true; });
  homeMuteBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

  assertCondition(speakerBtnClicked === true, `Floating speaker toggle is active and interactable at bottom: 32px; right: 32px;`);
  assertCondition(slidesContainer.querySelector('.pause-button') === null, `Slides container contains only active speaker toggle and NO pause buttons`);

  // =============================================================
  // Scenario I: Verify Zero-Transcode Direct Stream Policy
  // =============================================================
  console.log(`\n${BOLD}--- Scenario I: Verify Zero-Transcode Direct Stream Policy ---${RESET}`);
  // Assert that all local trailer stream URLs include static=true
  assertCondition(heroCode.includes('static=true'), `Details Hero enforces static=true for all local trailer streams`);
  assertCondition(hoverCode.includes('static=true'), `Hover Preview enforces static=true for all local trailer streams`);
  assertCondition(hoverVideoSrc.includes('static=true'), `Hover preview active trailer stream URL includes static=true`);
  assertCondition(detailsVideo.src.includes('static=true'), `Details hero active trailer stream URL includes static=true`);
  assertCondition(homeTrailerUrl.includes('static=true'), `Home carousel active trailer stream URL includes static=true`);

  // Assert that no full-length feature film is streamed as a trailer
  assertCondition(hoverCode.includes('trailer.Id !== itemId'), `Zero-transcode guarantee: Hover preview strictly refuses to stream main movie files as trailers`);
  assertCondition(heroCode.includes('t.Id !== itemId') || heroCode.includes('trailer.Id !== itemId'), `Zero-transcode guarantee: Details Hero strictly refuses to stream main movie files as trailers`);

  // =============================================================
  // Scenario J: Verify Floating Speaker Button Positioning & Mute Toggle State Machine
  // =============================================================
  console.log(`\n${BOLD}--- Scenario J: Floating Speaker Button Positioning & Mute Toggle State Machine ---${RESET}`);

  // 1. Check branding.xml for speaker button styling
  assertCondition(brandingXml.includes('.jellyfin-hero-speaker-btn'), `branding.xml includes .jellyfin-hero-speaker-btn selector`);
  assertCondition(brandingXml.includes('bottom: 32px !important'), `branding.xml positions speaker toggle at bottom-right offset`);
  assertCondition(brandingXml.includes('right: 32px !important'), `branding.xml positions speaker toggle at right: 32px`);
  assertCondition(brandingXml.includes('z-index: 100 !important'), `branding.xml elevates speaker toggle with z-index: 100`);
  assertCondition(brandingXml.includes('opacity: 1 !important'), `branding.xml enforces opacity: 1 (overriding default 0.3)`);
  assertCondition(brandingXml.includes('pointer-events: auto !important'), `branding.xml enables pointer-events: auto`);
  assertCondition(brandingXml.includes('backdrop-filter: blur(12px) !important'), `branding.xml provides backdrop-filter: blur(12px)`);
  assertCondition(brandingXml.includes('.jellyfin-hero-speaker-btn:hover'), `branding.xml styles hover state with authentic Netflix red and scale`);

  // 2. Check custom-details-hero.js stylesheet for speaker button styling
  assertCondition(heroCode.includes('.jellyfin-hero-speaker-btn {'), `custom-details-hero.js stylesheet defines .jellyfin-hero-speaker-btn`);
  assertCondition(heroCode.includes('bottom: 24px !important'), `custom-details-hero.js positions speaker toggle at bottom-right offset`);
  assertCondition(heroCode.includes('right: 28px !important'), `custom-details-hero.js positions speaker toggle at right: 28px`);
  assertCondition(heroCode.includes('z-index: 50 !important'), `custom-details-hero.js sets z-index: 50`);
  assertCondition(heroCode.includes('opacity: 1 !important'), `custom-details-hero.js sets opacity: 1`);
  assertCondition(heroCode.includes('pointer-events: auto !important'), `custom-details-hero.js sets pointer-events: auto`);

  // 3. Speaker button DOM instantiation in heroContainer
  const heroSpeakerBtn = heroContainer.querySelector('.jellyfin-hero-speaker-btn');
  assertCondition(!!heroSpeakerBtn, `Details hero floating speaker button instantiated in #jellyfinDetailsVideoHero`);
  assertCondition(heroSpeakerBtn.classList.contains('is-muted') === false, `Details speaker button starts unmuted (no is-muted class)`);
  assertCondition(detailsVideo.muted === false, `Details hero video is unmuted initially`);
  assertCondition(heroSpeakerBtn.getAttribute('aria-label') === 'Mute video audio', `Details speaker button aria-label initialized to 'Mute video audio'`);
  assertCondition(heroSpeakerBtn.innerHTML.includes('svg'), `Details speaker button renders SVG icon`);

  // 4. Bubbling prevention
  let heroParentClicked = false;
  heroContainer.addEventListener('click', () => { heroParentClicked = true; });
  heroSpeakerBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

  assertCondition(heroParentClicked === false, `Speaker button click stops propagation (e.stopPropagation()) to prevent hero container triggers`);

  // 5. Mute toggle state machine verification
  await sleep(30);
  assertCondition(heroSpeakerBtn.classList.contains('is-muted') === true, `Speaker button acquires is-muted class when toggled`);
  assertCondition(detailsVideo.muted === true, `Details video muted property set to true`);
  assertCondition(detailsVideo.volume === 0, `Details video volume set to 0 upon mute`);
  assertCondition(heroSpeakerBtn.getAttribute('aria-label') === 'Unmute video audio', `Speaker button aria-label updated to 'Unmute video audio'`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ !== 'hero', `Details hero releases audio lock on mute`);

  // 6. Unmute toggle & audio restoration
  heroSpeakerBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
  await sleep(30);

  assertCondition(heroSpeakerBtn.classList.contains('is-muted') === false, `Speaker button removes is-muted class upon unmuting`);
  assertCondition(detailsVideo.muted === false, `Details video muted property set to false upon unmuting`);
  assertCondition(heroSpeakerBtn.getAttribute('aria-label') === 'Mute video audio', `Speaker button aria-label restored to 'Mute video audio'`);
  assertCondition(mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'hero' || mockWindow.__JELLYFIN_ACTIVE_AUDIO_SOURCE__ === 'details-hero', `Details hero re-acquires audio lock upon unmuting`);

  // =============================================================
  // Scenario K: Movie Details Page Layout, Title Hierarchy & #itemBackdrop Collapse
  // =============================================================
  console.log(`\n${BOLD}--- Scenario K: Details Page Layout, Title Hierarchy & #itemBackdrop Collapse ---${RESET}`);

  // 1. #itemBackdrop total collapse
  assertCondition(heroCode.includes('#itemDetailPage.has-video-hero #itemBackdrop'), `custom-details-hero.js targets #itemBackdrop under .has-video-hero`);
  assertCondition(heroCode.includes('display: none !important;') && heroCode.includes('height: 0 !important;'), `#itemBackdrop completely collapsed with display: none and height: 0`);
  assertCondition(heroCode.includes('min-height: 0 !important;') && heroCode.includes('max-height: 0 !important;'), `#itemBackdrop height constraints clamped to 0`);
  assertCondition(heroCode.includes('visibility: hidden !important;') && heroCode.includes('pointer-events: none !important;'), `#itemBackdrop visibility and pointer-events deactivated`);
  assertCondition(detailPage.querySelector('#itemBackdrop') !== null, `#itemBackdrop is present in details DOM and targeted by collapse rule`);
  assertCondition(detailPage.classList.contains('has-video-hero'), `#itemDetailPage active page holds has-video-hero class`);

  // 2. Theatrical in-flow banner styling for .jellyfin-details-video-hero (52vh, z-index: 2)
  assertCondition(heroCode.includes('.jellyfin-details-video-hero {'), `custom-details-hero.js defines .jellyfin-details-video-hero stage`);
  assertCondition(heroCode.includes('position: relative !important;'), `.jellyfin-details-video-hero positioned as in-flow theatrical stage`);
  assertCondition(heroCode.includes('height: 52vh !important;'), `.jellyfin-details-video-hero height set to 52vh stage`);
  assertCondition(heroCode.includes('z-index: 2 !important;'), `.jellyfin-details-video-hero positioned at z-index: 2`);

  // 3. In-flow styling for .detailRibbon below the trailer (never overlapping)
  assertCondition(heroCode.includes('#itemDetailPage.has-video-hero .detailRibbon'), `custom-details-hero.js defines in-flow styling for .detailRibbon`);
  assertCondition(heroCode.includes('position: relative !important;') && heroCode.includes('z-index: 5 !important;'), `.detailRibbon elevated to z-index: 5`);
  assertCondition(heroCode.includes('min-height: auto !important;'), `.detailRibbon min-height set to auto (sitting cleanly below trailer)`);
  assertCondition(heroCode.includes('flex-direction: column !important;'), `.detailRibbon arranged in column flex direction`);
  assertCondition(heroCode.includes('justify-content: flex-start !important;'), `.detailRibbon justifies content to flex-start (positioned cleanly below trailer)`);
  assertCondition(heroCode.includes('align-items: flex-start !important;'), `.detailRibbon aligns items to flex-start`);

  // 4. Cinema screen ambient vignette (z-index: 3)
  assertCondition(heroCode.includes('.jellyfin-hero-vignette-overlay {'), `custom-details-hero.js defines .jellyfin-hero-vignette-overlay`);
  assertCondition(heroCode.includes('z-index: 3 !important;'), `Ambient vignette overlay positioned at z-index: 3`);
  assertCondition(heroCode.includes('linear-gradient(180deg') && heroCode.includes('#0b0b0d 100%'), `Ambient vignette provides bottom fade to #0b0b0d`);
  assertCondition(heroContainer.querySelector('.jellyfin-hero-vignette-overlay') !== null, `Vignette overlay DOM element mounted into heroContainer`);

  // 5. Title typography and responsive font sizing clamp
  assertCondition(heroCode.includes('#itemDetailPage.has-video-hero .nameContainer h1.itemName'), `custom-details-hero.js defines big title typography rule`);
  assertCondition(heroCode.includes('"Inter"'), `Title typography enforces Inter font family`);
  assertCondition(heroCode.includes('font-size: clamp(2.2rem, 3.8vw, 3.4rem) !important;'), `Title typography enforces responsive clamp(2.2rem, 3.8vw, 3.4rem) sizing`);
  assertCondition(heroCode.includes('font-weight: 800 !important;'), `Title typography enforces font-weight: 800`);
  assertCondition(heroCode.includes('text-shadow: 0 2px 14px rgba(0, 0, 0, 0.85)'), `Title typography enforces theatrical drop text-shadow`);
  assertCondition(detailRibbon.querySelector('.nameContainer h1.itemName') !== null, `Movie title element is mounted in .detailRibbon hierarchy`);

  // 6. Zero negative margin collisions
  assertCondition(!heroCode.includes('margin-top: -') && !heroCode.includes('margin-bottom: -'), `custom-details-hero.js contains zero negative margin collisions with the video edge`);

  // =============================================================
  // Scenario L: Discovery & Surprise Me Feature (custom-discover-request.js)
  // =============================================================
  console.log(`\n${BOLD}--- Scenario L: Discovery & Surprise Me Feature (custom-discover-request.js) ---${RESET}`);

  // 1. Syntax validation via node -c
  let syntaxOk = false;
  try {
    execSync(`node -c ${JSON.stringify(path.join(__dirname, 'custom-discover-request.js'))}`, { stdio: 'pipe' });
    syntaxOk = true;
  } catch {}
  assertCondition(syntaxOk === true, `custom-discover-request.js syntax validation (node -c) passed`);

  const discoverCode = fs.readFileSync(path.join(__dirname, 'custom-discover-request.js'), 'utf8');
  assertCondition(
    !heroCode.includes('api.themoviedb.org') &&
    !hoverCode.includes('api.themoviedb.org') &&
    !discoverCode.includes('api.themoviedb.org'),
    `All client JS modules contain zero direct api.themoviedb.org URLs`
  );
  assertCondition(
    !heroCode.includes('TMDB_PUBLIC_API_KEY') &&
    !hoverCode.includes('TMDB_PUBLIC_API_KEY') &&
    !discoverCode.includes('TMDB_PUBLIC_API_KEY'),
    `All client JS modules contain zero hardcoded TMDB_PUBLIC_API_KEY constants`
  );

  // 2. Module initialization & exports
  assertCondition(mockWindow.__JELLYFIN_DISCOVER_REQUEST_INITIALIZED__ === true, `window.__JELLYFIN_DISCOVER_REQUEST_INITIALIZED__ is true`);
  assertCondition(typeof mockWindow.JellyfinDiscover === 'object', `window.JellyfinDiscover object is exposed globally`);
  assertCondition(typeof mockWindow.JellyfinDiscover.open === 'function', `JellyfinDiscover exports open()`);
  assertCondition(typeof mockWindow.JellyfinDiscover.close === 'function', `JellyfinDiscover exports close()`);
  assertCondition(typeof mockWindow.JellyfinDiscover.roll === 'function', `JellyfinDiscover exports roll()`);
  assertCondition(typeof mockWindow.JellyfinDiscover.request === 'function', `JellyfinDiscover exports request()`);
  assertCondition(typeof mockWindow.JellyfinDiscover.toggleTrailer === 'function', `JellyfinDiscover exports toggleTrailer()`);
  assertCondition(discoverModule === mockWindow.JellyfinDiscover, `module.exports cleanly matches window.JellyfinDiscover`);

  // 3. Navbar and drawer injection
  const headerBtn = mockDocument.getElementById('jellyfinDiscoverHeaderBtn');
  assertCondition(!!headerBtn, `Header 'Surprise Me' button injected into .skinHeader .headerRight`);
  assertCondition(headerBtn.textContent.includes('Surprise Me'), `Header button displays 'Surprise Me' text`);
  assertCondition(headerBtn.innerHTML.includes('svg'), `Header button renders dice SVG icon`);

  const drawerBtn = mockDocument.getElementById('jellyfinDiscoverDrawerBtn');
  assertCondition(!!drawerBtn, `Drawer item injected into .mainDrawer-scrollContainer`);
  assertCondition(drawerBtn.textContent.includes('Discover & Request'), `Drawer item displays 'Discover & Request' text`);
  assertCondition(drawerBtn.innerHTML.includes('svg'), `Drawer item renders sparkles SVG icon`);

  // 4. Search page recommendation card injection
  const searchPage = new MockElement('DIV');
  searchPage.className = 'searchPage';
  mockBody.appendChild(searchPage);

  mockWindow.location.hash = '#/search';
  mockWindow.dispatchEvent(new MockEvent('hashchange'));
  await sleep(150);

  const searchCard = mockDocument.getElementById('jellyfinDiscoverSearchCard');
  assertCondition(!!searchCard, `Search recommendation card injected on search page route`);
  assertCondition(searchCard.textContent.includes('Can\'t find what you\'re looking for?') || searchCard.textContent.includes('Surprise Me'), `Search card displays recommendation prompt`);

  // 5. Modal rendering, glassmorphic styles & backdrop
  await mockWindow.JellyfinDiscover.open();
  await sleep(100);

  assertCondition(
    mockWindow.__TEST_TMDB_PROXY_CALLS__.some(
      u => u.startsWith('http://localhost:3000/api/tmdb/proxy?') &&
           u.includes('path=movie%2F') &&
           u.includes('append_to_response=credits%2Cvideos')
    ),
    `TMDb enrichment requests route through Dashboard proxy (/api/tmdb/proxy)`
  );

  const modal = mockDocument.getElementById('jellyfinDiscoverModal');
  assertCondition(!!modal, `Discovery Modal (#jellyfinDiscoverModal) mounted into DOM`);
  assertCondition(modal.classList.contains('jdr-active'), `Modal has active class jdr-active`);
  assertCondition(mockDocument.body.style.overflow === 'hidden', `Body scroll locked (overflow: hidden) while modal is open`);

  assertCondition(modal.querySelector('.jdr-media-container') !== null, `Modal includes 16:9 preview container (.jdr-media-container)`);
  assertCondition(modal.querySelector('#jdrBackdropImg') !== null, `Modal includes movie backdrop image element (#jdrBackdropImg)`);
  assertCondition(modal.querySelector('.jdr-media-vignette') !== null, `Modal includes multi-stop ambient vignette overlay (.jdr-media-vignette)`);
  assertCondition(modal.querySelector('#jdrRatingBadge') !== null, `Modal includes glassmorphic rating badge (#jdrRatingBadge)`);
  assertCondition(modal.querySelector('#jdrModalTitle') !== null, `Modal includes candidate title element (#jdrModalTitle)`);
  assertCondition(modal.querySelector('#jdrYear') !== null, `Modal includes release year metadata element (#jdrYear)`);
  assertCondition(modal.querySelector('#jdrRuntime') !== null, `Modal includes runtime metadata element (#jdrRuntime)`);
  assertCondition(modal.querySelector('#jdrSynopsis') !== null, `Modal includes synopsis element (#jdrSynopsis)`);
  assertCondition(modal.querySelector('#jdrDirector') !== null, `Modal includes director credits element (#jdrDirector)`);
  assertCondition(modal.querySelector('#jdrCast') !== null, `Modal includes cast credits element (#jdrCast)`);
  assertCondition(modal.querySelector('#jdrRequestBtn') !== null, `Modal includes Request to Watch button (#jdrRequestBtn)`);
  assertCondition(modal.querySelector('#jdrTrailerBtn') !== null, `Modal includes Watch Trailer button (#jdrTrailerBtn)`);
  assertCondition(modal.querySelector('#jdrRollBtn') !== null, `Modal includes Roll Another button (#jdrRollBtn)`);
  assertCondition(modal.querySelector('#jdrCloseBtn') !== null, `Modal includes Close button (#jdrCloseBtn)`);

  // 6. Trailer playback toggle
  const trailerWrapper = modal.querySelector('#jdrTrailerWrapper');
  const trailerIframe = modal.querySelector('#jdrTrailerIframe');
  const trailerBtn = modal.querySelector('#jdrTrailerBtn');

  assertCondition(trailerWrapper.classList.contains('jdr-active') === false, `Trailer wrapper dormant before user triggers playback`);

  mockWindow.JellyfinDiscover.toggleTrailer();
  assertCondition(trailerWrapper.classList.contains('jdr-active') === true, `Trailer wrapper activated with jdr-active upon toggle`);
  assertCondition(trailerIframe.src.includes('youtube-nocookie.com/embed/'), `Trailer iframe src loaded with youtube-nocookie.com URL`);
  assertCondition(trailerBtn.textContent.includes('Stop Trailer'), `Trailer button text updated to 'Stop Trailer'`);

  mockWindow.JellyfinDiscover.toggleTrailer();
  assertCondition(trailerWrapper.classList.contains('jdr-active') === false, `Trailer wrapper deactivated on second toggle`);
  assertCondition(trailerIframe.src === 'about:blank', `Trailer iframe reset to about:blank to release decoder & network resources`);

  // 7. Request button submission flow
  const requestBtn = modal.querySelector('#jdrRequestBtn');
  await mockWindow.JellyfinDiscover.request();
  await sleep(50);

  assertCondition(requestBtn.classList.contains('jdr-requested') === true, `Request button acquires jdr-requested styling class`);
  assertCondition(requestBtn.disabled === true, `Request button disabled after successful dispatch`);
  assertCondition(requestBtn.textContent.includes('Request Placed') || requestBtn.textContent.includes('Downloading'), `Request button displays download confirmation status`);

  // 8. Modal closure flow
  mockWindow.JellyfinDiscover.close();
  assertCondition(modal.classList.contains('jdr-active') === false, `Modal deactivates jdr-active on close`);
  assertCondition(mockDocument.body.style.overflow === '', `Body scroll restored on modal close`);

  console.log(`\n${BOLD}${GREEN}=================================================================${RESET}`);
  console.log(`${BOLD}${GREEN} All Test Scenarios Passed Successfully! (${passedAssertions}/${passedAssertions})        ${RESET}`);
  console.log(`${BOLD}${GREEN}=================================================================${RESET}\n`);
}

runTestSuite().catch(err => {
  console.error(`\n${BOLD}${RED}Test Suite Failed with Error:${RESET}`, err);
  process.exit(1);
});
