'use strict';
const $ = id => document.getElementById(id);
let activeTab = null;
let historyBusy = false;
let scanBusy = false;
let scanGeneration = 0;
let navigationTimer = null;

function notice(text, success = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('success', success);
  $('notice').hidden = !text;
}
async function message(data) {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw new Error(result?.error || '没有收到响应，请重新打开扩展。');
  return result;
}
function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB';
}
function duration(value) {
  if (!value) return 'MP4 视频';
  const s = Math.floor(value / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function qualityLabel(variant, index) {
  const label = variant.width ? `${variant.width} × ${variant.height}` : '原始画质';
  return label + (index === 0 ? ' · 最高' : '');
}
function renderMedia(items, context = null) {
  const tabId = activeTab?.id;
  $('media-list').replaceChildren();
  $('count').textContent = String(items.length);
  $('status').textContent = items.length ? `找到 ${items.length} 个视频` : '未识别';
  $('empty').hidden = Boolean(items.length);
  $('media-section').hidden = !items.length;
  items.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'media-card';
    card.innerHTML = '<div class="media-top"><div class="video-cover"><span class="cover-fallback" aria-hidden="true">▷</span><img class="cover-image" alt="视频封面" hidden><span class="clip-index"></span></div><div class="media-info"><h3></h3><p class="author"></p><p class="meta"></p><a class="source-link" target="_blank" rel="noopener noreferrer">查看原帖 ↗</a></div></div><div class="media-controls"><select class="quality" aria-label="下载画质"></select><button class="button primary">↓ 下载视频</button></div>';
    const title = item.title || (item.tweetId ? `帖子 ${item.tweetId}` : '未提供标题的视频');
    card.querySelector('h3').textContent = title;
    card.querySelector('h3').title = title;
    card.querySelector('.clip-index').textContent = String(index + 1).padStart(2, '0');
    const author = [item.authorName, item.authorHandle ? '@' + item.authorHandle : ''].filter(Boolean).join(' ');
    card.querySelector('.author').textContent = author;
    card.querySelector('.author').hidden = !author;
    card.querySelector('.meta').textContent = `MP4 · ${duration(item.durationMs)} · ${item.variants.length} 种画质`;
    const link = card.querySelector('.source-link');
    link.hidden = !item.tweetId;
    if (item.tweetId) link.href = `https://x.com/${item.authorHandle || 'i'}/status/${item.tweetId}`;
    if (XClip.posterUrl(item.posterUrl)) {
      const image = card.querySelector('img');
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('load', () => { image.hidden = false; card.querySelector('.video-cover').classList.add('has-image'); });
      image.addEventListener('error', () => { image.hidden = true; card.querySelector('.video-cover').classList.remove('has-image'); });
      image.src = item.posterUrl;
    }
    const select = card.querySelector('select');
    item.variants.forEach((variant, optionIndex) => {
      const option = document.createElement('option');
      option.value = String(optionIndex);
      option.textContent = qualityLabel(variant, optionIndex);
      select.append(option);
    });
    const button = card.querySelector('button');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '正在开始…';
      notice('');
      try {
        await message({type: 'DOWNLOAD', tabId, key: item.key, context, variantIndex: Number(select.value)});
        notice('已加入浏览器下载列表。', true);
        await updateDownloads();
      } catch (error) {
        notice(/cancel/i.test(error.message) ? '已取消保存。' : error.message);
      } finally {
        button.disabled = false;
        button.textContent = '↓ 下载视频';
      }
    });
    $('media-list').append(card);
  });
}
function renderDownloads(items) {
  $('downloads-section').hidden = !items.length;
  $('downloads-list').replaceChildren();
  items.slice(0, 5).forEach(item => {
    const row = document.createElement('article');
    row.className = 'download-row';
    row.innerHTML = '<div class="download-heading"><span class="download-title"></span><span class="download-state"></span></div><div class="progress-track"><div class="progress-fill"></div></div><div class="download-actions"><span></span><button class="text-button"></button></div>';
    row.querySelector('.download-title').textContent = item.title || item.filename || 'X 视频';
    row.querySelector('.download-title').title = item.filename || '';
    const state = row.querySelector('.download-state');
    state.classList.add(item.state);
    const percent = item.totalBytes > 0 ? Math.min(100, Math.floor(item.bytesReceived / item.totalBytes * 100)) : 0;
    state.textContent = item.state === 'complete' ? (item.exists === false ? '文件已移走' : '已完成') : item.state === 'interrupted' ? '已中断' : (percent ? `${percent}%` : '下载中');
    row.querySelector('.progress-track').hidden = item.state !== 'in_progress';
    row.querySelector('.progress-fill').style.width = `${percent || 5}%`;
    row.querySelector('.download-actions span').textContent = [bytes(item.bytesReceived), item.state === 'interrupted' ? errorLabel(item.error) : ''].filter(Boolean).join(' · ');
    const action = row.querySelector('button');
    action.textContent = item.state === 'in_progress' ? '取消' : item.state === 'complete' && item.exists !== false ? '在文件夹中显示' : '下载记录 ↗';
    action.addEventListener('click', async () => {
      try {
        if (item.state === 'in_progress') await chrome.downloads.cancel(item.id);
        else if (item.state === 'complete' && item.exists !== false) chrome.downloads.show(item.id);
        else await chrome.tabs.create({url: 'chrome://downloads/'});
        await updateDownloads();
      } catch (error) { notice(error.message); }
    });
    $('downloads-list').append(row);
  });
}
function errorLabel(value) {
  if (value === 'USER_CANCELED') return '已取消';
  if (/NETWORK/.test(value)) return '网络连接失败';
  if (/FORBIDDEN|UNAUTHORIZED/.test(value)) return '地址不可用，请刷新视频页面重试';
  if (/FILE/.test(value)) return '文件保存失败';
  return '请查看浏览器下载记录';
}
async function updateDownloads() {
  if (historyBusy) return;
  historyBusy = true;
  try { renderDownloads((await message({type: 'GET_DOWNLOADS'})).items); }
  catch { /* The main action shows actionable errors. */ }
  finally { historyBusy = false; }
}
async function scan(force = false) {
  if (scanBusy) return;
  const generation = ++scanGeneration;
  scanBusy = true;
  renderMedia([]);
  $('empty').hidden = true;
  $('empty-title').textContent = '还没识别到视频';
  $('diagnostics').hidden = true;
  $('status').textContent = '检测中';
  for (const id of ['rescan', 'rescan-empty']) $(id).disabled = true;
  notice('');
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (generation !== scanGeneration) return;
    activeTab = tab;
    if (!tab || !XClip.isXUrl(tab.url)) throw new Error('请先打开要下载的 X / Twitter 视频页面。');
    const result = await message({type: 'GET_MEDIA', tabId: tab.id, rescan: true, force: Boolean(force)});
    if (generation !== scanGeneration) return;
    const [latest] = await chrome.tabs.query({active: true, currentWindow: true});
    if (generation !== scanGeneration) return;
    if (latest?.id !== tab.id || XClip.pageKey(latest?.url) !== XClip.pageKey(result.pageUrl) || result.changed) {
      scanBusy = false;
      void scan(force);
      return;
    }
    if (result.pageUrl) {
      activeTab.url = result.pageUrl;
      const id = XClip.postId(result.pageUrl);
      $('page-label').textContent = id ? `帖子 ${id}` : '当前页面中已加载的视频';
    }
    renderMedia(result.items, result.context);
    const details = result.diagnostics;
    $('diagnostics').hidden = !details || Boolean(result.items.length);
    if (details) $('diagnostics').textContent = `页面连接：${details.reader ? '正常' : '未连接'} · 播放器检测：${details.observer ? '已运行' : '未运行'} · 已读取 ${details.responses || 0} 次响应`;
    if (!result.items.length) {
      $('empty-description').textContent = !details?.reader
        ? `插件还没有连接到这个页面。请在扩展管理页确认已重新加载 ${XClip.VERSION} 版，然后刷新当前 X 页面。`
        : '已主动检查播放器和公开帖子数据，暂未找到可下载的 MP4。请播放视频后再检测；仅提供 HLS 的视频暂不支持。';
      if (details?.lastError) notice(`页面检测失败：${details.lastError}`);
      else if (result.fallback?.error) notice(result.fallback.error);
    }
  } catch (error) {
    if (generation !== scanGeneration) return;
    notice(error.message);
    $('status').textContent = '检测失败';
    $('empty').hidden = false;
    $('empty-title').textContent = '这次检测没有完成';
    $('empty-description').textContent = '请确认扩展已重新加载，再点击重新检测。';
  } finally {
    if (generation === scanGeneration) {
      scanBusy = false;
      for (const id of ['rescan', 'rescan-empty']) $(id).disabled = false;
    }
  }
}
function pageChanged() {
  scanGeneration++;
  scanBusy = false;
  renderMedia([]);
  $('empty').hidden = true;
  $('status').textContent = '页面已变化，正在重新检测';
  notice('');
  clearTimeout(navigationTimer);
  navigationTimer = setTimeout(() => scan(true), 150);
}
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (tabId === activeTab?.id && (change.url || change.status)) pageChanged();
});
chrome.tabs.onActivated?.addListener(pageChanged);
function saveHint() {
  $('save-hint').textContent = $('ask-where').checked ? '下载时会弹出保存窗口，由你选择文件夹和文件名。' : '默认保存到浏览器下载目录中的「X视频」文件夹。';
}
$('ask-where').addEventListener('change', async () => {
  try { await chrome.storage.local.set({askWhere: $('ask-where').checked}); saveHint(); }
  catch (error) { notice(error.message); }
});
$('rescan').addEventListener('click', () => scan(true));
$('rescan-empty').addEventListener('click', () => scan(true));
$('reload').addEventListener('click', async () => {
  if (!activeTab) return;
  try { await chrome.tabs.reload(activeTab.id); window.close(); }
  catch (error) { notice(error.message); }
});
$('open-downloads').addEventListener('click', () => chrome.tabs.create({url: 'chrome://downloads/'}));
async function init() {
  try {
    const {askWhere = false} = await chrome.storage.local.get('askWhere');
    $('ask-where').checked = Boolean(askWhere);
    saveHint();
    [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!activeTab || !XClip.isXUrl(activeTab.url)) {
      $('page-label').textContent = '请先打开 X / Twitter 视频页面';
      $('status').textContent = '等待打开';
      $('empty').hidden = false;
      $('empty-title').textContent = '在视频页面打开我';
      $('empty-description').textContent = '进入你要保存的帖子，播放视频，再点浏览器工具栏里的扩展图标。';
      $('reload').hidden = true;
      $('rescan-empty').hidden = true;
    } else {
      const id = XClip.postId(activeTab.url);
      $('page-label').textContent = id ? `帖子 ${id}` : '当前页面中已加载的视频';
      await scan();
    }
    await updateDownloads();
    setInterval(updateDownloads, 1000);
  } catch (error) { notice(error.message); $('status').textContent = '初始化失败'; }
}
init();
