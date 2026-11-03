(() => {
  'use strict';
  const VERSION = '1.0.2';
  if (globalThis.__xClipBridgeVersion === VERSION) return;
  globalThis.__xClipBridgeVersion = VERSION;
  let diagnostics = null, lastError = '';
  function request() { window.postMessage({channel: 'XCLIP_REQUEST_V1'}, location.origin); }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel === 'XCLIP_DIAGNOSTICS_V1') {
      const d = event.data.diagnostics;
      if (d && typeof d === 'object') diagnostics = {version: String(d.version || '').slice(0, 20),
        responses: Number(d.responses) || 0, domScans: Number(d.domScans) || 0,
        mediaCount: Number(d.mediaCount) || 0, lastError: String(d.lastError || '').slice(0, 160)};
      return;
    }
    if (event.data?.channel !== 'XCLIP_MEDIA_V1' || !Array.isArray(event.data.items)) return;
    try {
      const items = event.data.items.slice(0, 80).map(XClip.cleanItem).filter(Boolean);
      if (items.length) chrome.runtime.sendMessage({type: 'MEDIA_FOUND', items}).then(result => {
        lastError = result?.ok ? '' : result?.error || '视频信息未保存。';
      }).catch(error => { lastError = error.message; });
    } catch (error) { lastError = error.message; }
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'RESCAN') request();
    if (['RESCAN', 'PAGE_STATUS', 'PING'].includes(message?.type)) reply({ok: true, version: VERSION, diagnostics, lastError});
  });
  request();
  document.addEventListener('DOMContentLoaded', request, {once: true});
  window.addEventListener('pageshow', request);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) request(); });
})();
