(() => {
  'use strict';
  const VERSION = '1.0.2';
  if (window.__xClipObserverVersion === VERSION) return;
  window.__xClipObserverVersion = VERSION;
  window.__xClipObserverInstalled = true;
  let cache = [];
  const diagnostics = {version: VERSION, responses: 0, domScans: 0, mediaCount: 0, lastError: ''};
  function report() {
    diagnostics.mediaCount = cache.length;
    window.postMessage({channel: 'XCLIP_DIAGNOSTICS_V1', diagnostics: {...diagnostics}}, location.origin);
  }
  function publish(items) {
    if (items.length) {
      cache = XClip.mergeMedia(cache, items);
      window.postMessage({channel: 'XCLIP_MEDIA_V1', items: items.slice(0, 80)}, location.origin);
    }
    report();
  }
  function parse(value) {
    diagnostics.responses++;
    try { publish(XClip.extractMedia(value, location.href)); }
    catch (error) { diagnostics.lastError = String(error.message).slice(0, 160); report(); }
  }
  function isApi(url) {
    try {
      const u = new URL(url, location.href);
      return /(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) && /\/(graphql|i\/api|2\/timeline)\//.test(u.pathname);
    } catch { return false; }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return Reflect.apply(originalFetch, this, args).then(response => {
      try {
        if (isApi(response.url || args[0]?.url || args[0]) && response.ok) {
          response.clone().json().then(parse).catch(() => {});
        }
      } catch { /* Ignore non-JSON responses. */ }
      return response;
    });
  };
  const requests = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const result = Reflect.apply(originalOpen, this, [method, url, ...args]);
    requests.set(this, url);
    return result;
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isApi(requests.get(this))) {
      this.addEventListener('load', function () {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType === 'json') parse(this.response);
          else if (this.responseType === '' || this.responseType === 'text') parse(JSON.parse(this.responseText));
        } catch { /* Ignore non-JSON responses. */ }
      }, {once: true});
    }
    return Reflect.apply(originalSend, this, args);
  };
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
  function scanRendered() {
    diagnostics.domScans++;
    const found = [];
    try {
      for (const video of document.querySelectorAll('video')) {
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
      publish(found.filter(Boolean));
    } catch (error) { diagnostics.lastError = String(error.message).slice(0, 160); report(); }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'XCLIP_REQUEST_V1') return;
    scanRendered();
    if (cache.length) window.postMessage({channel: 'XCLIP_MEDIA_V1', items: cache}, location.origin);
    report();
  });
  scanRendered();
})();
