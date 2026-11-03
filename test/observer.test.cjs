const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {tweet, pageUrl} = require('./fixtures.cjs');
function observer(response, videos = [], oldInstalled = false) {
  const events = [], listeners = {};
  class XHR { open() {} send() {} addEventListener() {} }
  const context = vm.createContext({URL, console, location: {href: pageUrl, origin: 'https://x.com'}, XMLHttpRequest: XHR,
    document: {querySelectorAll: () => videos}});
  const window = {__xClipObserverInstalled: oldInstalled, fetch: async () => response, postMessage: event => events.push(event), addEventListener: (name, callback) => {listeners[name] = callback;}};
  context.window = window;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/shared.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/page-observer.js'), 'utf8'), context);
  return {window, events, listeners};
}
test('network observer preserves original fetch response while detecting real variants', async () => {
  const response = {ok: true, url: 'https://x.com/i/api/graphql/fixture/TweetDetail', clone: () => ({json: async () => ({data: tweet()})})};
  const app = observer(response);
  assert.equal(await app.window.fetch(response.url), response);
  await new Promise(resolve => setImmediate(resolve));
  const media = () => app.events.filter(e => e.channel === 'XCLIP_MEDIA_V1');
  assert.equal(media().length, 1);
  assert.equal(media()[0].items[0].variants.length, 2);
  app.listeners.message({source: app.window, origin: 'https://x.com', data: {channel: 'XCLIP_REQUEST_V1'}});
  assert.equal(media().length, 2);
});
test('non-JSON and unrelated responses leave the website request intact', async () => {
  for (const url of ['https://x.com/i/api/graphql/fixture/TweetDetail', 'https://example.org/data']) {
    const response = {ok: true, url, clone: () => ({json: async () => { throw new Error('Not JSON'); }})};
    const app = observer(response);
    assert.equal(await app.window.fetch(url), response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V1').length, 0);
  }
});
test('late injection reads an already rendered player without waiting for another request', () => {
  const source = tweet().legacy.extended_entities.media[0].video_info;
  const article = {querySelectorAll: () => [{closest: () => ({href: pageUrl})}]};
  const video = {currentSrc: 'blob:https://x.com/player', parentElement: null,
    closest: selector => selector === 'article' ? article : null, matches: () => false,
    '__reactProps$fixture': {tweetId: '123450000001', video: source}};
  const app = observer({ok: false}, [video], true);
  const media = app.events.filter(e => e.channel === 'XCLIP_MEDIA_V1');
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
  assert.equal(app.events.filter(e => e.channel === 'XCLIP_MEDIA_V1').length, 0);
});
