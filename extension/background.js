importScripts('shared.js');
const queues = new Map();
const publicAttempts = new Map();
const keyFor = tabId => `media:${tabId}`;
async function readSnapshot(tabId) {
  const value = (await chrome.storage.session.get(keyFor(tabId)))[keyFor(tabId)];
  return value?.version === XClip.VERSION && Array.isArray(value.items) ? value : null;
}
function serialize(tabId, work) {
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}
async function currentTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('找不到当前标签页。');
  const tab = await chrome.tabs.get(tabId);
  if (!XClip.isXUrl(tab.url)) throw new Error('请在 X / Twitter 视频页面使用。');
  return tab;
}
function emptySnapshot(pageUrl, previous = null) {
  return {version: XClip.VERSION, pageUrl: XClip.pageKey(pageUrl), items: [],
    documentId: previous?.documentId || '', revision: previous?.revision ?? -1,
    minRevision: previous?.minRevision ?? 0, generation: previous?.generation ?? 0, retired: previous?.retired || []};
}
function contextFor(snapshot) {
  return snapshot && {pageUrl: snapshot.pageUrl, documentId: snapshot.documentId, revision: snapshot.revision, generation: snapshot.generation};
}
function sameContext(snapshot, context) {
  return Boolean(snapshot && context && snapshot.pageUrl === context.pageUrl &&
    snapshot.documentId === context.documentId && snapshot.revision === context.revision && snapshot.generation === context.generation);
}
async function writeSnapshot(tabId, snapshot) {
  await chrome.storage.session.set({[keyFor(tabId)]: snapshot});
  const tab = await chrome.tabs.get(tabId);
  const count = XClip.forPage(snapshot.items, tab.url).length;
  await chrome.action.setBadgeBackgroundColor({tabId, color: '#2563eb'});
  await chrome.action.setBadgeText({tabId, text: count ? String(Math.min(count, 99)) : ''});
}
async function invalidate(tabId, pageUrl, {loading = false, rescan = false} = {}) {
  return serialize(tabId, async () => {
    const previous = await readSnapshot(tabId);
    const page = XClip.pageKey(pageUrl);
    if (!loading && !rescan && previous?.pageUrl === page) return;
    const snapshot = emptySnapshot(pageUrl, previous);
    snapshot.generation++;
    if (loading) {
      snapshot.retired = [...new Set([...snapshot.retired, snapshot.documentId].filter(Boolean))].slice(-8);
      snapshot.documentId = '';
      snapshot.revision = -1;
      snapshot.minRevision = 0;
    } else if (rescan) snapshot.minRevision = snapshot.revision + 1;
    await writeSnapshot(tabId, snapshot);
  });
}
async function scanPage(tabId) {
  const result = {reader: false, observer: false, lastError: ''};
  try {
    let ping;
    try { ping = await chrome.tabs.sendMessage(tabId, {type: 'PING'}); } catch { /* Already open before installation. */ }
    if (ping?.version !== XClip.VERSION) {
      await chrome.scripting.executeScript({target: {tabId}, world: 'ISOLATED', files: ['shared.js', 'content.js']});
    }
    await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', files: ['shared.js', 'page-observer.js']});
    // The reply waits until the fresh snapshot has reached session storage.
    const status = await chrome.tabs.sendMessage(tabId, {type: 'RESCAN'});
    result.reader = status?.version === XClip.VERSION;
    result.observer = status?.diagnostics?.version === XClip.VERSION;
    result.lastError = status?.lastError || status?.diagnostics?.lastError || '';
    result.responses = status?.diagnostics?.responses || 0;
    result.domScans = status?.diagnostics?.domScans || 0;
  } catch (error) { result.lastError = String(error.message || error).slice(0, 180); }
  return result;
}
async function publicFallback(tab, snapshot, force) {
  const id = XClip.postId(tab.url);
  if (!id) return {state: 'not-a-post'};
  const attemptKey = `${tab.id}:${id}`;
  const previous = publicAttempts.get(attemptKey);
  // A cached success is not evidence that a cleared page cache still has that video.
  if (!force && previous && previous.result.state !== 'found' && Date.now() - previous.time < 20000) return previous.result;
  const expected = contextFor(snapshot);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let result;
  try {
    const response = await fetch(XClip.syndicationUrl(id), {credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal});
    if (!response.ok) throw new Error(`公开数据接口返回 HTTP ${response.status}`);
    const data = await response.json();
    if (String(data.id_str || '') !== id) result = {state: 'unavailable'};
    else {
      const items = XClip.forPage(XClip.extractMedia(data, tab.url), tab.url);
      if (!items.length) result = {state: 'no-mp4'};
      else {
        const accepted = await serialize(tab.id, async () => {
          const latest = await currentTab(tab.id);
          const current = await readSnapshot(tab.id);
          if (XClip.pageKey(latest.url) !== expected.pageUrl || !sameContext(current, expected)) return false;
          const revision = Math.max(current.revision, current.minRevision);
          await writeSnapshot(tab.id, {...current, revision, minRevision: revision, items: XClip.mergeMedia(current.items, items)});
          return true;
        });
        result = {state: accepted ? 'found' : 'changed'};
      }
    }
  } catch (error) {
    result = {state: 'failed', error: error.name === 'AbortError' ? '公开数据连接超时。' : String(error.message).slice(0, 180)};
  } finally { clearTimeout(timer); }
  if (result.state !== 'changed') publicAttempts.set(attemptKey, {time: Date.now(), result});
  if (publicAttempts.size > 100) publicAttempts.delete(publicAttempts.keys().next().value);
  return result;
}
async function remember(message, sender) {
  if (!sender.tab || sender.frameId !== 0 || !XClip.isXUrl(sender.url)) throw new Error('来源不受支持。');
  if (message.version !== XClip.VERSION || !Array.isArray(message.items) || !XClip.isXUrl(message.pageUrl) ||
      !Number.isSafeInteger(message.revision) || message.revision < 0 || !sender.documentId) throw new Error('请刷新 X 页面以启用新版检测。');
  const tabId = sender.tab.id;
  return serialize(tabId, async () => {
    const tab = await currentTab(tabId);
    const page = XClip.pageKey(tab.url);
    if (page !== XClip.pageKey(message.pageUrl) || page !== XClip.pageKey(sender.url)) return {ok: true, ignored: true};
    const previous = await readSnapshot(tabId);
    if (previous?.retired.includes(sender.documentId)) return {ok: true, ignored: true};
    const sameDocument = previous?.documentId === sender.documentId;
    if (sameDocument && (message.revision < previous.revision || message.revision < previous.minRevision)) return {ok: true, ignored: true};
    const preserve = sameDocument && previous.pageUrl === page && previous.revision === message.revision;
    const retired = [...new Set([...(previous?.retired || []),
      previous?.documentId !== sender.documentId ? previous?.documentId : ''].filter(Boolean))].slice(-8);
    const items = XClip.forPage(message.items.slice(0, 80).map(XClip.cleanItem).filter(Boolean), page);
    await writeSnapshot(tabId, {version: XClip.VERSION, pageUrl: page, documentId: sender.documentId,
      revision: message.revision, minRevision: message.revision, generation: previous?.generation ?? 0, retired,
      items: XClip.mergeMedia(preserve ? previous.items : [], items)});
    return {ok: true};
  });
}
async function ownDownloads() {
  const saved = (await chrome.storage.session.get('downloads')).downloads || [];
  return (await Promise.all(saved.slice(-20).reverse().map(async entry => {
    const found = await chrome.downloads.search({id: entry.id});
    const item = found[0];
    return item ? {id: item.id, tweetId: entry.tweetId, title: entry.title || '', authorHandle: entry.authorHandle || '', filename: item.filename.split(/[\\/]/).pop(), state: item.state,
      error: item.error || '', bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, exists: item.exists} : null;
  }))).filter(Boolean);
}
let downloadQueue = Promise.resolve();
async function startDownload(message) {
  const tab = await currentTab(message.tabId);
  if (queues.has(tab.id)) await queues.get(tab.id);
  const snapshot = await readSnapshot(tab.id);
  if (!sameContext(snapshot, message.context) || snapshot.pageUrl !== XClip.pageKey(tab.url) || snapshot.minRevision > snapshot.revision) {
    throw new Error('页面已切换或刷新，请重新检测当前视频。');
  }
  const media = XClip.forPage(snapshot.items, tab.url).find(item => item.key === message.key);
  if (!media) throw new Error('视频已不在当前帖子中，请重新检测。');
  const index = Number(message.variantIndex ?? 0);
  if (!Number.isInteger(index) || index < 0 || index >= media.variants.length) throw new Error('画质选项无效。');
  const variant = media.variants[index];
  if (!XClip.mp4Url(variant.url)) throw new Error('视频地址不受支持。');
  const {askWhere = false} = await chrome.storage.local.get('askWhere');
  const latest = await currentTab(tab.id);
  if (XClip.pageKey(latest.url) !== snapshot.pageUrl || !sameContext(await readSnapshot(tab.id), message.context)) throw new Error('页面已变化，请重新检测。');
  const id = await chrome.downloads.download({url: variant.url, filename: XClip.filename(media, variant), saveAs: Boolean(askWhere), conflictAction: 'uniquify'});
  const write = downloadQueue.catch(() => {}).then(async () => {
    const previous = (await chrome.storage.session.get('downloads')).downloads || [];
    await chrome.storage.session.set({downloads: [...previous, {id, tweetId: media.tweetId, title: media.title || '', authorHandle: media.authorHandle || ''}].slice(-50)});
  });
  downloadQueue = write;
  await write;
  return {ok: true, id};
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('不受支持的请求。');
  if (message?.type === 'MEDIA_FOUND') return remember(message, sender);
  if (sender.tab) throw new Error('请从扩展窗口操作下载。');
  switch (message?.type) {
    case 'GET_MEDIA': {
      const tab = await currentTab(message.tabId);
      if (queues.has(tab.id)) await queues.get(tab.id);
      let snapshot = await readSnapshot(tab.id);
      let items = XClip.forPage(snapshot?.items || [], tab.url);
      let diagnostics = null, fallback = null;
      if (!items.length || message.rescan) {
        await invalidate(tab.id, tab.url, {rescan: true});
        diagnostics = await scanPage(tab.id);
        snapshot = await readSnapshot(tab.id);
        items = XClip.forPage(snapshot?.items || [], tab.url);
      }
      if (!items.length || (XClip.postId(tab.url) && items.some(item => !item.title))) {
        fallback = await publicFallback(tab, snapshot, Boolean(message.force));
      }
      const latest = await currentTab(tab.id);
      snapshot = await readSnapshot(tab.id);
      return {ok: true, items: XClip.forPage(snapshot?.items || [], latest.url), pageUrl: latest.url,
        context: contextFor(snapshot), changed: XClip.pageKey(latest.url) !== XClip.pageKey(tab.url), diagnostics, fallback};
    }
    case 'DOWNLOAD': return startDownload(message);
    case 'GET_DOWNLOADS': return {ok: true, items: await ownDownloads()};
    default: throw new Error('未知操作。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply).catch(error => reply({ok: false, error: error.message || '操作失败。'}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  serialize(tabId, () => chrome.storage.session.remove(keyFor(tabId))).catch(() => {});
  for (const key of publicAttempts.keys()) if (key.startsWith(`${tabId}:`)) publicAttempts.delete(key);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'loading') return;
  return invalidate(tabId, change.url || tab.url, {loading: change.status === 'loading'}).catch(() => {});
});
