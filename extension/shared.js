(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.XClip = api;
})(globalThis, function () {
  'use strict';
  const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

  function isXUrl(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && X_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port; }
    catch { return false; }
  }
  function postId(value) {
    if (!isXUrl(value)) return null;
    return new URL(value).pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d{5,25})(?:\/|$)/)?.[1] || null;
  }
  function mp4Url(value) {
    if (typeof value !== 'string' || value.length > 8192) return null;
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && u.hostname === 'video.twimg.com' && !u.port && !u.username && !u.password && /\.mp4$/i.test(u.pathname) ? u.href : null;
    } catch { return null; }
  }
  function dimensions(url) {
    const match = new URL(url).pathname.match(/\/(\d{2,5})x(\d{2,5})\//);
    return match ? {width: Number(match[1]), height: Number(match[2])} : {width: 0, height: 0};
  }
  function cleanText(value, limit = 500) {
    if (typeof value !== 'string') return '';
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[name]))
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }
  function posterUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) return '';
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' && !u.username && !u.password && !u.port ? u.href : '';
    } catch { return ''; }
  }
  function description(node, legacy = node) {
    const user = node.core?.user_results?.result || node.user || node.author || {};
    const userLegacy = user.legacy || {};
    const userCore = user.core || {};
    return {
      title: cleanText(node.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || legacy.text || node.title || node.caption || ''),
      authorName: cleanText(userCore.name || userLegacy.name || user.name || '', 80),
      authorHandle: cleanText(userCore.screen_name || userLegacy.screen_name || user.screen_name || '', 30)
    };
  }
  function variants(input) {
    if (!Array.isArray(input)) return [];
    const result = new Map();
    for (const item of input.slice(0, 30)) {
      if (!item || typeof item !== 'object') continue;
      const url = mp4Url(item.url || item.src);
      const type = item.content_type || item.type;
      if (!url || (type && type !== 'video/mp4')) continue;
      const {width, height} = dimensions(url);
      const bitrate = Number.isFinite(Number(item.bitrate)) ? Math.max(0, Number(item.bitrate)) : 0;
      const key = new URL(url).pathname;
      if (!result.has(key) || result.get(key).bitrate < bitrate) result.set(key, {url, width, height, bitrate});
    }
    return [...result.values()].sort((a, b) => (b.width * b.height - a.width * a.height) || b.bitrate - a.bitrate);
  }
  function cleanItem(item) {
    if (!item || typeof item !== 'object' || !isXUrl(item.pageUrl)) return null;
    const choices = variants(item.variants);
    if (!choices.length) return null;
    const tweetId = /^\d{5,25}$/.test(String(item.tweetId)) ? String(item.tweetId) : postId(item.pageUrl);
    const mediaId = typeof item.mediaId === 'string' ? item.mediaId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) : '';
    const fallbackKey = new URL(choices[0].url).pathname;
    return {
      key: `${tweetId || 'page'}:${mediaId || fallbackKey}`,
      tweetId, mediaId,
      pageUrl: new URL(item.pageUrl).origin + new URL(item.pageUrl).pathname,
      durationMs: Math.min(86400000, Math.max(0, Number(item.durationMs) || 0)),
      title: cleanText(item.title),
      authorName: cleanText(item.authorName, 80),
      authorHandle: typeof item.authorHandle === 'string' ? item.authorHandle.replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 30) : '',
      posterUrl: posterUrl(item.posterUrl),
      variants: choices
    };
  }
  function extractMedia(payload, pageUrl) {
    if (!isXUrl(pageUrl)) return [];
    const found = [], visited = new WeakSet();
    let budget = 30000;
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || depth > 50 || --budget < 0 || visited.has(node)) return;
      visited.add(node);
      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node;
      const details = description(node, legacy);
      const media = legacy.extended_entities?.media || legacy.entities?.media || node.mediaDetails;
      if (Array.isArray(media)) {
        const id = String(node.rest_id || legacy.id_str || '');
        for (const entry of media) {
          if (!/^\d{5,25}$/.test(id)) continue;
          if (!entry?.video_info) continue;
          const item = cleanItem({...details, tweetId: id, mediaId: String(entry.media_key || entry.id_str || ''),
            posterUrl: entry.media_url_https || entry.poster || '',
            durationMs: entry.video_info.duration_millis, variants: entry.video_info.variants, pageUrl});
          if (item) found.push(item);
        }
      }
      if (node.video?.variants && /^\d{5,25}$/.test(String(node.id_str || ''))) {
        const item = cleanItem({...details, tweetId: node.id_str, mediaId: String(node.video.videoId || ''),
          posterUrl: typeof node.video.poster === 'string' ? node.video.poster : node.video.poster?.src,
          durationMs: node.video.durationMs, variants: node.video.variants, pageUrl});
        if (item) found.push(item);
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value, depth + 1);
    }
    visit(payload, 0);
    return mergeMedia([], found);
  }
  function directMedia(url, pageUrl) {
    if (!postId(pageUrl)) return null;
    return cleanItem({pageUrl, tweetId: postId(pageUrl), variants: [{url, content_type: 'video/mp4'}]});
  }
  function extractPlayerMedia(payload, pageUrl, ownerId) {
    if (!isXUrl(pageUrl) || !/^\d{5,25}$/.test(String(ownerId))) return [];
    const found = [], visited = new WeakSet();
    let budget = 3000;
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || depth > 10 || --budget < 0 || visited.has(node)) return;
      visited.add(node);
      const declaredId = node.tweetId || node.tweet_id || node.statusId;
      if (declaredId && /^\d{5,25}$/.test(String(declaredId)) && String(declaredId) !== String(ownerId)) return;
      const choices = node.video_info?.variants || node.variants || node.sources;
      if (Array.isArray(choices)) {
        const item = cleanItem({...description(node), tweetId: String(ownerId), pageUrl, mediaId: String(node.media_key || node.mediaId || node.videoId || ''),
          posterUrl: node.media_url_https || node.poster || node.posterUrl,
          durationMs: node.duration_millis || node.durationMs, variants: choices});
        if (item) found.push(item);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === '_owner' || key === 'return' || key === 'stateNode' || key === 'alternate') continue;
        if (value && typeof value === 'object') visit(value, depth + 1);
      }
    }
    visit(payload, 0);
    return mergeMedia([], found);
  }
  function syndicationUrl(id) {
    if (!/^\d{5,25}$/.test(String(id))) throw new Error('帖子编号无效。');
    const token = (Number(id) / 1e15 * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    return `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`;
  }
  function mergeMedia(existing, incoming) {
    const result = [];
    for (const raw of [...existing, ...incoming]) {
      const item = cleanItem(raw);
      if (!item) continue;
      const paths = new Set(item.variants.map(v => new URL(v.url).pathname));
      const other = result.find(old => old.key === item.key || (old.tweetId === item.tweetId && old.variants.some(v => paths.has(new URL(v.url).pathname))));
      if (other) {
        const joined = variants([...other.variants, ...item.variants]);
        if (!other.mediaId && item.mediaId) { other.mediaId = item.mediaId; other.key = item.key; }
        other.durationMs = item.durationMs || other.durationMs;
        if (item.title && (!other.title || item.title.length > other.title.length)) other.title = item.title;
        other.authorName = item.authorName || other.authorName;
        other.authorHandle = item.authorHandle || other.authorHandle;
        other.posterUrl = other.posterUrl || item.posterUrl;
        other.variants = joined;
      } else result.push(item);
    }
    return result.slice(-80);
  }
  function forPage(items, pageUrl) {
    const id = postId(pageUrl);
    return id ? items.filter(item => item.tweetId === id) : items;
  }
  function filename(item, variant) {
    const id = item.tweetId || 'video';
    const media = item.mediaId ? '_' + item.mediaId : '';
    const size = variant.width && variant.height ? `_${variant.width}x${variant.height}` : '';
    const title = Array.from(cleanText(item.title).replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 32).join('').replace(/[ .]+$/g, '');
    return `X视频/${title ? title + '_' : 'X_'}${id}${media}${size}.mp4`;
  }
  return Object.freeze({isXUrl, postId, mp4Url, variants, cleanText, posterUrl, cleanItem, extractMedia, extractPlayerMedia, syndicationUrl, directMedia, mergeMedia, forPage, filename});
});
