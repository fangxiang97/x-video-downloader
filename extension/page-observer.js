(() => {
  'use strict';
  const VERSION = XClip.VERSION;
  if (window.__xClipObserverVersion === VERSION) return;
  window.__xClipObserverCleanup?.();
  window.__xClipObserverVersion = VERSION;
  window.__xClipObserverInstalled = true;
  let cache = [];
  let pageUrl = XClip.pageKey(location.href), revision = 0, scanTimer = null;
  let routeVideos = new Map();
  const diagnostics = {version: VERSION, responses: 0, domScans: 0, mediaCount: 0, lastError: ''};
  function report() {
    diagnostics.mediaCount = cache.length;
    window.postMessage({channel: 'XCLIP_DIAGNOSTICS_V2', diagnostics: {...diagnostics}}, location.origin);
  }
  function publish(items, requestId = '') {
    cache = XClip.mergeMedia(cache, XClip.forPage(items, pageUrl));
    report();
    window.postMessage({channel: 'XCLIP_MEDIA_V2', items: cache, pageUrl, revision, requestId}, location.origin);
  }
  function fingerprint(video) { return `${ownerFor(video) || ''}|${video.currentSrc || video.src || ''}|${video.poster || ''}`; }
  function syncPage() {
    const current = XClip.pageKey(location.href);
    if (current === pageUrl) return false;
    // X may leave the previous route's players mounted while its new page loads.
    routeVideos = new Map(Array.from(document.querySelectorAll('video'), video => [video, fingerprint(video)]));
    pageUrl = current;
    revision++;
    cache = [];
    diagnostics.lastError = '';
    publish([]);
    return true;
  }
  function ticket() { syncPage(); return {pageUrl, revision}; }
  function parse(value, source) {
    syncPage();
    if (source.pageUrl !== pageUrl || source.revision !== revision) return;
    diagnostics.responses++;
    try { publish(XClip.extractMedia(value, pageUrl)); }
    catch (error) { diagnostics.lastError = String(error.message).slice(0, 160); report(); }
  }
  function isApi(url) {
    try {
      const u = new URL(url, location.href);
      return /(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) && /\/(graphql|i\/api|2\/timeline)\//.test(u.pathname);
    } catch { return false; }
  }
  const originalFetch = window.fetch;
  const wrappedFetch = function (...args) {
    const source = ticket();
    return Reflect.apply(originalFetch, this, args).then(response => {
      try {
        if (isApi(response.url || args[0]?.url || args[0]) && response.ok) {
          response.clone().json().then(value => parse(value, source)).catch(() => {});
        }
      } catch { /* Ignore non-JSON responses. */ }
      return response;
    });
  };
  window.fetch = wrappedFetch;
  const requests = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const wrappedOpen = function (method, url, ...args) {
    const result = Reflect.apply(originalOpen, this, [method, url, ...args]);
    requests.set(this, url);
    return result;
  };
  const wrappedSend = function (...args) {
    const source = ticket();
    if (isApi(requests.get(this))) {
      this.addEventListener('load', function () {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType === 'json') parse(this.response, source);
          else if (this.responseType === '' || this.responseType === 'text') parse(JSON.parse(this.responseText), source);
        } catch { /* Ignore non-JSON responses. */ }
      }, {once: true});
    }
    return Reflect.apply(originalSend, this, args);
  };
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.send = wrappedSend;
  function ownerFor(video) {
    const quote = video.closest('[data-testid="quoteTweet"]');
    if (quote) {
      for (const link of quote.querySelectorAll('a[href*="/status/"]')) {
        const id = XClip.postId(link.href);
        if (id) return id;
      }
      return null;
    }
    const article = video.closest('article');
    if (article) {
      for (const time of article.querySelectorAll('time')) {
        const link = time.closest('a');
        const id = link && XClip.postId(link.href);
        if (id) return id;
      }
      return null;
    }
    return XClip.postId(location.href);
  }
  function scanRendered(requestId = '') {
    syncPage();
    diagnostics.domScans++;
    const found = [];
    try {
      for (const video of document.querySelectorAll('video')) {
        if (routeVideos.get(video) === fingerprint(video)) continue;
        routeVideos.delete(video);
        const ownerId = ownerFor(video);
        if (!ownerId) continue;
        const local = [];
        let scope = video.closest('[data-testid="quoteTweet"]') || video.closest('article');
        if (!scope) {
          scope = Array.from(document.querySelectorAll('article')).find(article =>
            Array.from(article.querySelectorAll('time')).some(time => XClip.postId(time.closest('a')?.href) === ownerId));
        }
        const user = scope?.querySelector?.('[data-testid="User-Name"]');
        const authorLink = user && Array.from(user.querySelectorAll('a[href]')).find(link => {
          try { return XClip.isXUrl(link.href) && /^\/[A-Za-z0-9_]+\/?$/.test(new URL(link.href).pathname); } catch { return false; }
        });
        const details = {
          title: scope?.querySelector?.('[data-testid="tweetText"]')?.textContent || '',
          authorName: authorLink?.textContent || '',
          authorHandle: authorLink ? new URL(authorLink.href).pathname.replace(/\//g, '') : '',
          posterUrl: video.poster || ''
        };
        const direct = XClip.mp4Url(video.currentSrc || video.src);
        if (direct) local.push(XClip.cleanItem({tweetId: ownerId, pageUrl: location.href, variants: [{url: direct}]}));
        let element = video;
        for (let level = 0; element && level < 7; level++, element = element.parentElement) {
          for (const key of Object.keys(element)) {
            if (key.startsWith('__reactProps$')) local.push(...XClip.extractPlayerMedia(element[key], location.href, ownerId));
            if (key.startsWith('__reactFiber$')) {
              let fiber = element[key];
              for (let parent = 0; fiber && parent < 5; parent++, fiber = fiber.return) {
                local.push(...XClip.extractPlayerMedia(fiber.memoizedProps, location.href, ownerId));
              }
            }
          }
          if (element.matches('article,[data-testid="quoteTweet"]')) break;
        }
        found.push(...local.filter(Boolean).map(item => XClip.cleanItem({...item,
          title: details.title || item.title,
          authorName: item.authorName || details.authorName,
          authorHandle: item.authorHandle || details.authorHandle,
          posterUrl: item.posterUrl || details.posterUrl})).filter(Boolean));
      }
      publish(found.filter(Boolean), requestId);
    } catch (error) { diagnostics.lastError = String(error.message).slice(0, 160); report(); }
  }
  function onRequest(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'XCLIP_REQUEST_V2') return;
    syncPage();
    if (event.data.reset) { revision++; cache = []; }
    scanRendered(event.data.requestId);
  }
  function scheduleScan() {
    syncPage();
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => { scanTimer = null; scanRendered(); }, 120);
  }
  window.addEventListener('message', onRequest);
  window.addEventListener('popstate', scheduleScan);
  window.addEventListener('hashchange', scheduleScan);
  document.addEventListener('loadedmetadata', scheduleScan, true);
  document.addEventListener('play', scheduleScan, true);
  const restores = [];
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    const wrapped = function (...args) {
      const result = Reflect.apply(original, this, args);
      scheduleScan();
      return result;
    };
    history[name] = wrapped;
    restores.push(() => { if (history[name] === wrapped) history[name] = original; });
  }
  const mutations = new MutationObserver(scheduleScan);
  mutations.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster']});
  window.__xClipObserverCleanup = () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalSend;
    for (const restore of restores) restore();
    mutations.disconnect();
    clearTimeout(scanTimer);
    window.removeEventListener('message', onRequest);
    window.removeEventListener('popstate', scheduleScan);
    window.removeEventListener('hashchange', scheduleScan);
    document.removeEventListener('loadedmetadata', scheduleScan, true);
    document.removeEventListener('play', scheduleScan, true);
  };
  scanRendered();
})();
