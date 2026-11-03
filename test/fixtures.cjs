const mp4 = (size, name) => `https://video.twimg.com/ext_tw_video/900001/pu/vid/avc1/${size}/${name}.mp4?tag=12`;
function tweet(id = '123450000001', mediaId = '7_900001') {
  return {__typename: 'Tweet', rest_id: id, legacy: {id_str: id, full_text: 'A public sample video',
    extended_entities: {media: [{type: 'video', media_key: mediaId, video_info: {duration_millis: 30400, variants: [
      {content_type: 'video/mp4', bitrate: 256000, url: mp4('320x568', `${id}-small`)},
      {content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/900001/pu/pl/master.m3u8'},
      {content_type: 'video/mp4', bitrate: 2176000, url: mp4('720x1280', `${id}-large`)}
    ]}}]}}};
}
const pageUrl = 'https://x.com/example/status/123450000001/video/1';
module.exports = {tweet, pageUrl, mp4};
