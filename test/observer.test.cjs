const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {tweet, pageUrl} = require('./fixtures.cjs');
function observer(response, initialVideos = [], oldInstalled = false) {
  const events = [], listeners = {}, timers = new Map();
  let videos = initialVideos, nextTimer = 0, mutationCallback;
  class XHR { open() {} send() {} addEventListener() {} }
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const location = {href: pageUrl, origin: 'https://x.com'};
  const document = {querySelectorAll: selector => selector === 'video' ? videos : [],
    addEventListener() {}, removeEventListener() {}};
  const history = {};
  for (const name of ['pushState', 'replaceState']) history[name] = (state, title, url) => {
    location.href = new URL(url, location.href).href;
  };
  const context = vm.createContext({URL, console, location, document, history, XMLHttpRequest: XHR, MutationObserver,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)});
  const window = {__xClipObserverInstalled: oldInstalled, fetch: async () => response,
    postMessage: event => events.push(event), addEventListener: (name, callback) => {listeners[name] = callback;},
    removeEventListener: (name, callback) => { if (listeners[name] === callback) delete listeners[name]; }};
  context.window = window;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/shared.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/page-observer.js'), 'utf8'), context);
  const flush = () => { const scheduled = [...timers.values()]; timers.clear(); for (const callback of scheduled) callback(); };
  const request = (reset = false) => listeners.message({source: window, origin: location.origin,
    data: {channel: 'XCLIP_REQUEST_V2', reset, requestId: 'test-scan'}});
  return {window, events, listeners, history, request, flush, location,
    setVideos: next => { videos = next; mutationCallback(); }};
}
test('network observer preserves original fetch response while detecting real variants', async () => {
  const response = {ok: true, url: 'https://x.com/i/api/graphql/fixture/TweetDetail', clone: () => ({json: async () => ({data: tweet()})})};
  const app = observer(response);
  assert.equal(await app.window.fetch(response.url), response);
  await new Promise(resolve => setImmediate(resolve));
  const media = () => app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2' && e.items.length);
  assert.equal(media().length, 1);
  assert.equal(media()[0].items[0].variants.length, 2);
  app.listeners.message({source: app.window, origin: 'https://x.com', data: {channel: 'XCLIP_REQUEST_V2'}});
  assert.equal(media().length, 2);
});
test('non-JSON and unrelated responses leave the website request intact', async () => {
  for (const url of ['https://x.com/i/api/graphql/fixture/TweetDetail', 'https://example.org/data']) {
    const response = {ok: true, url, clone: () => ({json: async () => { throw new Error('Not JSON'); }})};
    const app = observer(response);
    assert.equal(await app.window.fetch(url), response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2' && e.items.length).length, 0);
  }
});
test('late injection reads an already rendered player without waiting for another request', () => {
  const source = tweet().legacy.extended_entities.media[0].video_info;
  const article = {querySelectorAll: () => [{closest: () => ({href: pageUrl})}]};
  const video = {currentSrc: 'blob:https://x.com/player', parentElement: null,
    closest: selector => selector === 'article' ? article : null, matches: () => false,
    '__reactProps$fixture': {tweetId: '123450000001', video: source}};
  const app = observer({ok: false}, [video], true);
  const media = app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2' && e.items.length);
  assert.equal(media.length, 1);
  assert.equal(media[0].items[0].tweetId, '123450000001');
  assert.equal(media[0].items[0].variants[0].width, 720);
});
test('player metadata belonging to a different tweet is not reassigned to current page', () => {
  const source = tweet().legacy.extended_entities.media[0].video_info;
  const article = {querySelectorAll: () => [{closest: () => ({href: pageUrl})}]};
  const video = {currentSrc: 'blob:https://x.com/player', parentElement: null,
    closest: selector => selector === 'article' ? article : null, matches: () => false,
    '__reactProps$fixture': {tweetId: '123450000002', video: source}};
  const app = observer({ok: false}, [video]);
  assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2' && e.items.length).length, 0);
});

test('SPA navigation clears the cache instead of replaying the previous page', async () => {
  const response = {ok: true, url: 'https://x.com/i/api/graphql/fixture/TweetDetail', clone: () => ({json: async () => ({data: tweet()})})};
  const app = observer(response);
  await app.window.fetch(response.url);
  await new Promise(resolve => setImmediate(resolve));
  app.history.pushState(null, '', '/another_user');
  app.request();
  const latest = app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2').at(-1);
  assert.equal(latest.pageUrl, 'https://x.com/another_user');
  assert.equal(latest.items.length, 0);
});
test('late network JSON from the previous route is discarded', async () => {
  let release;
  const data = new Promise(resolve => { release = resolve; });
  const response = {ok: true, url: 'https://x.com/i/api/graphql/fixture/TweetDetail', clone: () => ({json: () => data})};
  const app = observer(response);
  await app.window.fetch(response.url);
  app.history.replaceState(null, '', '/new_profile');
  release({data: tweet()});
  await new Promise(resolve => setImmediate(resolve));
  app.request();
  assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2').at(-1).items.length, 0);
});
test('explicit rescan drops old response cache and ignores pre-rescan pending responses', async () => {
  const response = {ok: true, url: 'https://x.com/i/api/graphql/fixture/TweetDetail', clone: () => ({json: async () => ({data: tweet()})})};
  const app = observer(response);
  await app.window.fetch(response.url);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2').at(-1).items.length, 1);
  app.request(true);
  const latest = app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2').at(-1);
  assert.equal(latest.items.length, 0);
  assert.equal(latest.requestId, 'test-scan');
});
test('players left mounted during navigation are not relabeled as the new timeline', () => {
  const video = {currentSrc: 'https://video.twimg.com/sample.mp4', parentElement: null,
    closest: () => null, matches: () => false};
  const app = observer({ok: false}, [video]);
  app.history.pushState(null, '', '/new_profile');
  app.request(true);
  assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2').at(-1).items.length, 0);
});
test('a newly mounted player is detected after a route change without a page reload', () => {
  const app = observer({ok: false});
  app.history.pushState(null, '', '/example/status/123450000002');
  const article = {querySelectorAll: () => [{closest: () => ({href: app.location.href})}]};
  const video = {currentSrc: 'https://video.twimg.com/fresh.mp4', parentElement: null,
    closest: selector => selector === 'article' ? article : null, matches: () => false};
  app.setVideos([video]);
  app.flush();
  const latest = app.events.filter(e => e.channel === 'XCLIP_MEDIA_V2').at(-1);
  assert.equal(latest.items.length, 1);
  assert.equal(latest.items[0].tweetId, '123450000002');
});
