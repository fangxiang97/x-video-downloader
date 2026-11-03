const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../extension/shared.js');
const {pageUrl} = require('./fixtures.cjs');

function bridge(sendMessage = async () => ({ok: true})) {
  const listeners = {}, posted = [], sent = [];
  const window = {postMessage: value => posted.push(value),
    addEventListener: (name, callback) => listeners[name] = callback, removeEventListener() {}};
  const chrome = {runtime: {sendMessage: async value => { sent.push(value); return sendMessage(value); },
    onMessage: {addListener: callback => listeners.runtime = callback, removeListener() {}}}};
  const context = vm.createContext({window, chrome, URL, console, Date, setTimeout, clearTimeout,
    location: {href: pageUrl, origin: 'https://x.com'},
    document: {addEventListener() {}, removeEventListener() {}}});
  for (const file of ['shared.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
  const emit = data => listeners.message({source: window, origin: 'https://x.com', data});
  return {listeners, emit, posted, sent};
}
test('rescan waits for an empty fresh snapshot to be stored before replying', async () => {
  let release;
  const stored = new Promise(resolve => { release = resolve; });
  const app = bridge(() => stored);
  let response;
  app.listeners.runtime({type: 'RESCAN'}, {}, value => { response = value; });
  const request = app.posted.at(-1);
  assert.equal(request.reset, true);
  app.emit({channel: 'XCLIP_DIAGNOSTICS_V2', diagnostics: {version: api.VERSION, domScans: 1}});
  app.emit({channel: 'XCLIP_MEDIA_V2', pageUrl, revision: 1, requestId: request.requestId, items: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response, undefined);
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].items.length, 0);
  assert.equal(app.sent[0].revision, 1);
  release({ok: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(response.version, api.VERSION);
});
test('old-version and previous-route page messages are not relayed to the background', async () => {
  const app = bridge();
  app.emit({channel: 'XCLIP_MEDIA_V1', items: []});
  app.emit({channel: 'XCLIP_MEDIA_V2', pageUrl: 'https://x.com/previous_profile', revision: 10, items: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.sent.length, 0);
});
