(() => {
  'use strict';
  const VERSION = XClip.VERSION;
  if (globalThis.__xClipBridgeVersion === VERSION) return;
  globalThis.__xClipBridgeCleanup?.();
  globalThis.__xClipBridgeVersion = VERSION;
  let diagnostics = null, lastError = '', sequence = 0;
  let pending = Promise.resolve();
  const waiting = new Map();
  function request(reset = false, requestId = '') {
    window.postMessage({channel: 'XCLIP_REQUEST_V2', reset, requestId}, location.origin);
  }
  function onWindowMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel === 'XCLIP_DIAGNOSTICS_V2') {
      const d = event.data.diagnostics;
      if (d && typeof d === 'object') diagnostics = {version: String(d.version || '').slice(0, 20),
        responses: Number(d.responses) || 0, domScans: Number(d.domScans) || 0,
        mediaCount: Number(d.mediaCount) || 0, lastError: String(d.lastError || '').slice(0, 160)};
      return;
    }
    const snapshot = event.data;
    if (snapshot?.channel !== 'XCLIP_MEDIA_V2' || !Array.isArray(snapshot.items) ||
        XClip.pageKey(snapshot.pageUrl) !== XClip.pageKey(location.href) || !Number.isSafeInteger(snapshot.revision)) return;
    const items = snapshot.items.slice(0, 80).map(XClip.cleanItem).filter(Boolean);
    // Empty snapshots invalidate media belonging to the previous page.
    pending = pending.catch(() => {}).then(async () => {
      try {
        const result = await chrome.runtime.sendMessage({type: 'MEDIA_FOUND', version: VERSION,
          pageUrl: snapshot.pageUrl, revision: snapshot.revision, items});
        lastError = result?.ok ? '' : result?.error || '视频信息未保存。';
      } catch (error) { lastError = error.message; }
      const finish = waiting.get(snapshot.requestId);
      if (finish) finish();
    });
  }
  function onRuntimeMessage(message, sender, reply) {
    const status = () => ({ok: !lastError, version: VERSION, diagnostics, lastError});
    if (message?.type === 'RESCAN') {
      const requestId = `${Date.now()}:${++sequence}`;
      const timer = setTimeout(() => finish('播放器检测响应超时，请刷新 X 页面。'), 2000);
      function finish(error = '') {
        clearTimeout(timer);
        waiting.delete(requestId);
        if (error) lastError = error;
        reply(status());
      }
      waiting.set(requestId, finish);
      request(true, requestId);
      return true;
    }
    if (['PAGE_STATUS', 'PING'].includes(message?.type)) reply(status());
  }
  const requestCurrent = () => request();
  const onVisibility = () => { if (!document.hidden) request(); };
  window.addEventListener('message', onWindowMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  document.addEventListener('DOMContentLoaded', requestCurrent, {once: true});
  window.addEventListener('pageshow', requestCurrent);
  document.addEventListener('visibilitychange', onVisibility);
  globalThis.__xClipBridgeCleanup = () => {
    window.removeEventListener('message', onWindowMessage);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    document.removeEventListener('DOMContentLoaded', requestCurrent);
    window.removeEventListener('pageshow', requestCurrent);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const finish of waiting.values()) finish('页面检测脚本已更新，请重新检测。');
  };
  request();
})();
