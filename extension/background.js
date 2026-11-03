importScripts('shared.js');
const queues = new Map();
const publicAttempts = new Map();
const keyFor = tabId => `media:${tabId}`;
async function readMedia(tabId) { return (await chrome.storage.session.get(keyFor(tabId)))[keyFor(tabId)] || []; }
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
async function storeMedia(tabId, incoming) {
  await serialize(tabId, async () => {
    const items = XClip.mergeMedia(await readMedia(tabId), incoming);
    await chrome.storage.session.set({[keyFor(tabId)]: items});
    const tab = await chrome.tabs.get(tabId);
    const count = XClip.forPage(items, tab.url).length;
    await chrome.action.setBadgeBackgroundColor({tabId, color: '#2563eb'});
    await chrome.action.setBadgeText({tabId, text: count ? String(Math.min(count, 99)) : ''});
  });
}
async function scanPage(tabId) {
  const result = {reader: false, observer: false, lastError: ''};
  try {
    let ping;
    try { ping = await chrome.tabs.sendMessage(tabId, {type: 'PING'}); } catch { /* Already open before installation. */ }
    if (ping?.version !== '1.0.2') {
      await chrome.scripting.executeScript({target: {tabId}, world: 'ISOLATED', files: ['shared.js', 'content.js']});
    }
    await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', files: ['shared.js', 'page-observer.js']});
    await chrome.tabs.sendMessage(tabId, {type: 'RESCAN'});
    await new Promise(resolve => setTimeout(resolve, 100));
    if (queues.has(tabId)) await queues.get(tabId);
    const status = await chrome.tabs.sendMessage(tabId, {type: 'PAGE_STATUS'});
    result.reader = status?.version === '1.0.2';
    result.observer = status?.diagnostics?.version === '1.0.2';
    result.lastError = status?.lastError || status?.diagnostics?.lastError || '';
    result.responses = status?.diagnostics?.responses || 0;
    result.domScans = status?.diagnostics?.domScans || 0;
  } catch (error) { result.lastError = String(error.message || error).slice(0, 180); }
  return result;
}
async function publicFallback(tab, force) {
  const id = XClip.postId(tab.url);
  if (!id) return {state: 'not-a-post'};
  const previous = publicAttempts.get(id);
  if (!force && previous && Date.now() - previous.time < 20000) return previous.result;
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
      if (items.length) { await storeMedia(tab.id, items); result = {state: 'found'}; }
      else result = {state: 'no-mp4'};
    }
  } catch (error) {
    result = {state: 'failed', error: error.name === 'AbortError' ? '公开数据连接超时。' : String(error.message).slice(0, 180)};
  } finally { clearTimeout(timer); }
  publicAttempts.set(id, {time: Date.now(), result});
  if (publicAttempts.size > 100) publicAttempts.delete(publicAttempts.keys().next().value);
  return result;
}
async function remember(message, sender) {
  if (!sender.tab || sender.frameId !== 0 || !XClip.isXUrl(sender.url)) throw new Error('来源不受支持。');
  if (!Array.isArray(message.items)) throw new Error('无效的视频信息。');
  const tabId = sender.tab.id;
  await storeMedia(tabId, message.items.slice(0, 80));
  return {ok: true};
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
  const media = XClip.forPage(await readMedia(tab.id), tab.url).find(item => item.key === message.key);
  if (!media) throw new Error('视频已不在当前帖子中，请重新检测。');
  const index = Number(message.variantIndex ?? 0);
  if (!Number.isInteger(index) || index < 0 || index >= media.variants.length) throw new Error('画质选项无效。');
  const variant = media.variants[index];
  if (!XClip.mp4Url(variant.url)) throw new Error('视频地址不受支持。');
  const {askWhere = false} = await chrome.storage.local.get('askWhere');
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
      let items = XClip.forPage(await readMedia(tab.id), tab.url);
      let diagnostics = null, fallback = null;
      if (!items.length || message.rescan) {
        diagnostics = await scanPage(tab.id);
        items = XClip.forPage(await readMedia(tab.id), tab.url);
      }
      if (!items.length || (XClip.postId(tab.url) && items.some(item => !item.title))) {
        fallback = await publicFallback(tab, Boolean(message.force));
        items = XClip.forPage(await readMedia(tab.id), tab.url);
      }
      const latest = await currentTab(tab.id);
      if (latest.url !== tab.url) return {ok: true, items: XClip.forPage(await readMedia(tab.id), latest.url), pageUrl: latest.url, changed: true};
      return {ok: true, items, pageUrl: tab.url, diagnostics, fallback};
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
chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(keyFor(tabId)).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  if (!XClip.isXUrl(change.url)) {
    chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
    chrome.action.setBadgeText({tabId, text: ''}).catch(() => {});
  } else {
    readMedia(tabId).then(items => chrome.action.setBadgeText({tabId, text: String(XClip.forPage(items, change.url).length || '')})).catch(() => {});
  }
});
