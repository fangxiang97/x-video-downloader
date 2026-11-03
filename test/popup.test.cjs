const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../extension/shared.js');
const {tweet} = require('./fixtures.cjs');
class Element {
  constructor() { this.children = []; this.handlers = {}; this.parts = new Map(); this.value = '';
    this.classList = {add() {}, remove() {}, toggle() {}}; this.style = {}; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  replaceChildren(...children) { this.children = children; }
  append(child) { this.children.push(child); if (this.value === '') this.value = child.value; }
  querySelector(selector) { if (!this.parts.has(selector)) this.parts.set(selector, new Element()); return this.parts.get(selector); }
}
function popup(getMedia) {
  const elements = new Map(), listeners = {}, timers = new Map();
  let nextTimer = 0;
  const tab = {id: 1, url: 'https://x.com/home'};
  const chrome = {
    runtime: {sendMessage: async request => request.type === 'GET_MEDIA' ? getMedia(request) : {ok: true, items: []}},
    storage: {local: {get: async () => ({askWhere: false}), set: async () => {}}},
    tabs: {query: async () => [{...tab}], onUpdated: {addListener: callback => listeners.updated = callback},
      onActivated: {addListener: callback => listeners.activated = callback}}, downloads: {}
  };
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({chrome, console, URL, window: {},
    document: {getElementById: get, createElement: () => new Element()},
    setInterval() {}, setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)});
  for (const file of ['shared.js', 'popup.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
  return {get, tab, listeners, flush: () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); }};
}
function result(title, pageUrl = 'https://x.com/home') {
  const [item] = api.extractMedia(tweet(), pageUrl);
  item.title = title;
  return {ok: true, items: [item], pageUrl, context: {pageUrl, documentId: 'current', revision: 1, generation: 1}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('failed rescan clears old cards immediately and keeps them cleared on error', async () => {
  let fail, requests = 0;
  const app = popup(async () => ++requests === 1 ? result('previous video') : new Promise((resolve, reject) => { fail = reject; }));
  await tick();
  assert.equal(app.get('media-list').children.length, 1);
  const pending = app.get('rescan').handlers.click();
  assert.equal(app.get('media-list').children.length, 0);
  await tick();
  fail(new Error('Page reader unavailable'));
  await pending;
  assert.equal(app.get('media-list').children.length, 0);
  assert.equal(app.get('media-section').hidden, true);
  assert.equal(app.get('status').textContent, '检测失败');
});
test('late popup response cannot overwrite the new page after navigation', async () => {
  let release, requests = 0;
  const app = popup(async () => ++requests === 1 ? new Promise(resolve => { release = resolve; }) : result('new video', app.tab.url));
  await tick();
  app.tab.url = 'https://x.com/new_profile';
  app.listeners.updated(1, {url: app.tab.url});
  app.flush();
  await tick();
  assert.equal(app.get('media-list').children[0].querySelector('h3').textContent, 'new video');
  release(result('previous video'));
  await tick();
  assert.equal(app.get('media-list').children.length, 1);
  assert.equal(app.get('media-list').children[0].querySelector('h3').textContent, 'new video');
});
