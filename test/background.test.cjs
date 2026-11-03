const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../extension/shared.js');
const {tweet, pageUrl, mp4} = require('./fixtures.cjs');

function background(options = {}) {
  const state = {}, calls = [], ids = new Map(), injections = [], requests = [];
  const listeners = {};
  const local = {askWhere: true};
  let nextId = 10;
  const chrome = {
    runtime: {id: 'test-extension', onMessage: {addListener: callback => listeners.message = callback}},
    storage: {
      session: {get: async key => { await new Promise(resolve => setImmediate(resolve)); return {[key]: structuredClone(state[key])}; },
        set: async value => { Object.assign(state, structuredClone(value)); }, remove: async key => { delete state[key]; }},
      local: {get: async key => ({[key]: local[key]})}
    },
    tabs: {get: async id => ({id, url: pageUrl}),
      sendMessage: async (id, message) => {
        if (options.readerError) throw new Error(options.readerError);
        if (message.type === 'PING' && options.missingBridge && !injections.some(i => i.world === 'ISOLATED')) throw new Error('No receiver');
        return {ok: true, version: '1.0.2', diagnostics: {version: '1.0.2', responses: 0, domScans: 1}};
      },
      onRemoved: {addListener() {}}, onUpdated: {addListener() {}}},
    scripting: {executeScript: async request => { injections.push(request); if (options.injectionError) throw new Error(options.injectionError); return []; }},
    action: {setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}},
    downloads: {
      download: async options => { const id = nextId++; calls.push(options); ids.set(id, {id, filename: options.filename, state: 'in_progress', bytesReceived: 0, totalBytes: 200, exists: true}); return id; },
      search: async ({id}) => ids.has(id) ? [ids.get(id)] : []
    }
  };
  const context = vm.createContext({chrome, URL, console, setTimeout, clearTimeout, AbortController,
    fetch: async (url, request) => { requests.push({url, request}); return {ok: options.httpError ? false : true, status: options.httpError || 200, json: async () => options.publicData || {}}; }});
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const send = (message, sender = {id: 'test-extension', url: 'chrome-extension://test-extension/popup.html'}) => new Promise(resolve => listeners.message(message, sender, resolve));
  const found = items => send({type: 'MEDIA_FOUND', items}, {id: 'test-extension', frameId: 0, tab: {id: 1}, url: pageUrl});
  return {send, found, calls, state, local, injections, requests};
}
test('concurrent response arrivals keep both videos in the account-free cache', async () => {
  const app = background();
  const first = api.extractMedia(tweet(), pageUrl);
  const t = tweet('123450000001', '7_second');
  t.legacy.extended_entities.media[0].video_info.variants = [{url: mp4('640x360', 'second')}];
  const second = api.extractMedia(t, pageUrl);
  const responses = await Promise.all([app.found(first), app.found(second)]);
  assert.ok(responses.every(r => r.ok));
  const result = await app.send({type: 'GET_MEDIA', tabId: 1});
  assert.equal(result.items.length, 2);
});
test('download honors selected variant, save dialog, and non-overwrite behavior', async () => {
  const app = background();
  const [item] = api.extractMedia(tweet(), pageUrl);
  await app.found([item]);
  const result = await app.send({type: 'DOWNLOAD', tabId: 1, key: item.key, variantIndex: 1});
  assert.equal(result.ok, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, item.variants[1].url);
  assert.equal(app.calls[0].saveAs, true);
  assert.equal(app.calls[0].conflictAction, 'uniquify');
  assert.match(app.calls[0].filename, /320x568\.mp4$/);
  const history = await app.send({type: 'GET_DOWNLOADS'});
  assert.equal(history.items[0].id, result.id);
});
test('a quoted tweet or bad variant cannot silently download a different video', async () => {
  const app = background();
  const quote = api.extractMedia(tweet('123450000002', '7_quote'), pageUrl);
  await app.found(quote);
  const wrong = await app.send({type: 'DOWNLOAD', tabId: 1, key: quote[0].key});
  assert.equal(wrong.ok, false);
  const [current] = api.extractMedia(tweet(), pageUrl);
  await app.found([current]);
  const invalid = await app.send({type: 'DOWNLOAD', tabId: 1, key: current.key, variantIndex: 100});
  assert.equal(invalid.ok, false);
  assert.equal(app.calls.length, 0);
});
test('page scripts cannot invoke privileged downloads via the content bridge', async () => {
  const app = background();
  const [item] = api.extractMedia(tweet(), pageUrl);
  await app.found([item]);
  const response = await app.send({type: 'DOWNLOAD', tabId: 1, key: item.key}, {id: 'test-extension', tab: {id: 1}, frameId: 0, url: pageUrl});
  assert.equal(response.ok, false);
  assert.equal(app.calls.length, 0);
  const foreign = await app.send({type: 'GET_MEDIA', tabId: 1}, {id: 'not-this-extension'});
  assert.equal(foreign.ok, false);
});
test('already open tab without a content script is actively connected, then uses public metadata', async () => {
  const t = tweet();
  const app = background({missingBridge: true, publicData: {id_str: t.rest_id, mediaDetails: t.legacy.extended_entities.media}});
  const response = await app.send({type: 'GET_MEDIA', tabId: 1, rescan: true});
  assert.equal(response.ok, true);
  assert.equal(response.items.length, 1);
  assert.equal(response.fallback.state, 'found');
  assert.deepEqual(app.injections.map(item => item.world), ['ISOLATED', 'MAIN']);
  assert.equal(app.requests[0].request.credentials, 'omit');
  assert.match(app.requests[0].url, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?/);
});
test('page injection errors remain visible while public metadata can still recover a video', async () => {
  const t = tweet();
  const app = background({readerError: 'No receiver', injectionError: 'Cannot access this page',
    publicData: {id_str: t.rest_id, mediaDetails: t.legacy.extended_entities.media}});
  const response = await app.send({type: 'GET_MEDIA', tabId: 1});
  assert.equal(response.items.length, 1);
  assert.match(response.diagnostics.lastError, /Cannot access/);
});
test('public API errors and unrelated responses never create a false video', async () => {
  for (const options of [{httpError: 503}, {publicData: {id_str: '123450000002', mediaDetails: tweet().legacy.extended_entities.media}}]) {
    const app = background(options);
    const result = await app.send({type: 'GET_MEDIA', tabId: 1});
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 0);
    assert.notEqual(result.fallback.state, 'found');
    assert.equal(app.calls.length, 0);
  }
});
