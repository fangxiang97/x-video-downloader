const {test} = require('node:test');
const assert = require('node:assert/strict');
const api = require('../extension/shared.js');
const {tweet, pageUrl, mp4} = require('./fixtures.cjs');

test('GraphQL timeline: current tweet and quoted tweet stay separate', () => {
  const main = tweet();
  main.quoted_status_result = {result: tweet('123450000002', '7_900002')};
  const result = api.extractMedia({data: {threaded_conversation_with_injections_v2: {instructions: [{entries: [{content: {itemContent: {tweet_results: {result: main}}}}]}]}}}, pageUrl);
  assert.equal(result.length, 2);
  const current = api.forPage(result, pageUrl);
  assert.equal(current.length, 1);
  assert.equal(current[0].tweetId, '123450000001');
  assert.equal(current[0].variants.length, 2);
  assert.equal(current[0].variants[0].height, 1280);
});
test('missing legacy id never assigns a quote video to the open tweet', () => {
  const quoted = tweet('123450000002', '7_quote');
  delete quoted.legacy.id_str;
  const main = tweet();
  main.quoted_status_result = {result: quoted};
  const result = api.extractMedia(main, pageUrl);
  assert.equal(api.forPage(result, pageUrl).length, 1);
  assert.equal(api.forPage(result, pageUrl)[0].mediaId, '7_900001');
  assert.equal(result.length, 2);
});
test('HLS and foreign or credential-bearing URLs are excluded', () => {
  const t = tweet();
  t.legacy.extended_entities.media[0].video_info.variants = [
    {url: 'https://video.twimg.com/p/master.m3u8', content_type: 'application/x-mpegURL'},
    {url: 'https://video.twimg.com.evil.test/a.mp4'},
    {url: 'https://video.twimg.com@evil.test/a.mp4'},
    {url: 'http://video.twimg.com/a.mp4'},
    {url: 'https://user:password@video.twimg.com/a.mp4'},
    {url: 'https://video.twimg.com:8443/a.mp4'},
    {url: 'javascript:alert(1)'}
  ];
  assert.deepEqual(api.extractMedia(t, pageUrl), []);
});
test('repeated page responses deduplicate without mixing different media', () => {
  const main = tweet();
  const a = api.extractMedia(main, pageUrl);
  const again = api.extractMedia(main, pageUrl);
  const second = tweet('123450000001', '7_second');
  second.legacy.extended_entities.media[0].video_info.variants = [{url: mp4('640x360', 'another-video'), bitrate: 600000}];
  const all = api.mergeMedia([...a, ...again], api.extractMedia(second, pageUrl));
  assert.equal(all.length, 2);
  assert.equal(all[0].variants.length, 2);
});
test('parser bounds traversal and handles cyclic or malformed responses', () => {
  const value = {data: tweet()};
  value.self = value;
  assert.equal(api.extractMedia(value, pageUrl).length, 1);
  assert.deepEqual(api.extractMedia(value, 'https://unrelated.test'), []);
  assert.deepEqual(api.extractMedia(null, pageUrl), []);
});
test('download filenames cannot traverse directories and retain chosen resolution', () => {
  const item = api.cleanItem({pageUrl, tweetId: '123450000001', mediaId: '../../escape / file', variants: [{url: mp4('720x1280', 'sample')} ]});
  const name = api.filename(item, item.variants[0]);
  assert.match(name, /^X视频\/X_123450000001_[A-Za-z0-9_-]+_720x1280\.mp4$/);
  assert.ok(!name.includes('..'));
});
test('real NASA public embed data yields one correctly associated video and four qualities', () => {
  const data = require('./nasa-syndication-public.json');
  const result = api.extractMedia(data, 'https://x.com/NASA/status/2117335720645759113');
  assert.equal(result.length, 1);
  assert.equal(result[0].tweetId, '2117335720645759113');
  assert.equal(result[0].variants.length, 4);
  assert.equal(result[0].variants[0].width, 1920);
  assert.equal(result[0].variants[0].height, 1080);
  assert.match(result[0].title, /night sky for November/);
  assert.equal(result[0].authorHandle, 'NASA');
  assert.match(result[0].posterUrl, /^https:\/\/pbs\.twimg\.com\//);
});
test('embed video src/type format and player props work without a GraphQL legacy object', () => {
  const choices = [{src: mp4('1280x720', 'embedded'), type: 'video/mp4'}];
  const result = api.extractMedia({id_str: '123450000001', video: {variants: choices, durationMs: 30000}}, pageUrl);
  assert.equal(result.length, 1);
  assert.equal(result[0].variants[0].width, 1280);
  const player = api.extractPlayerMedia({video: {variants: choices}, tweetId: '123450000001'}, pageUrl, '123450000001');
  assert.equal(player.length, 1);
});
test('current post and quoted post keep their own title, author and cover', () => {
  const current = tweet();
  current.legacy.full_text = '海边日落 &amp; 晚风';
  current.core = {user_results: {result: {legacy: {name: '小林', screen_name: 'lin_sample'}}}};
  current.legacy.extended_entities.media[0].media_url_https = 'https://pbs.twimg.com/media/current.jpg';
  const quote = tweet('123450000002', '7_quote');
  quote.legacy.full_text = '城市夜景';
  quote.core = {user_results: {result: {core: {name: '阿青', screen_name: 'qing_sample'}}}};
  quote.legacy.extended_entities.media[0].media_url_https = 'https://pbs.twimg.com/media/quote.jpg';
  current.quoted_status_result = {result: quote};
  const result = api.extractMedia(current, pageUrl);
  const own = result.find(item => item.tweetId === current.rest_id);
  const other = result.find(item => item.tweetId === quote.rest_id);
  assert.equal(own.title, '海边日落 & 晚风');
  assert.equal(own.authorHandle, 'lin_sample');
  assert.match(own.posterUrl, /current\.jpg$/);
  assert.equal(other.title, '城市夜景');
  assert.equal(other.authorHandle, 'qing_sample');
  assert.match(other.posterUrl, /quote\.jpg$/);
});
test('metadata survives repeated normalization and later title-less player updates', () => {
  const [original] = api.extractMedia(tweet(), pageUrl);
  Object.assign(original, {title: '海边日落', authorName: '小林', authorHandle: 'lin_sample', posterUrl: 'https://pbs.twimg.com/media/current.jpg'});
  const blank = {...original, title: '', authorName: '', authorHandle: '', posterUrl: ''};
  const [merged] = api.mergeMedia([api.cleanItem(original)], [blank]);
  assert.equal(merged.title, '海边日落');
  assert.equal(merged.authorHandle, 'lin_sample');
  assert.equal(merged.posterUrl, original.posterUrl);
});
test('title-bearing filenames stay within a single safe filename component', () => {
  const [item] = api.extractMedia(tweet(), pageUrl);
  item.title = '海边/日落: "晚风" <测试> ? * ' + '🌅'.repeat(90);
  const filename = api.filename(item, item.variants[0]);
  const basename = filename.slice('X视频/'.length);
  assert.match(basename, /^海边 日落/);
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(basename));
  assert.ok(Buffer.byteLength(basename) <= 255);
  assert.match(basename, /123450000001/);
});
