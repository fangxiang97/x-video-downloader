// Development-only UI preview. Never included in the extension archive.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../extension/shared.js');
const {tweet, pageUrl} = require('./fixtures.cjs');
const root = path.resolve(__dirname, '../extension');
const previewUrl = 'https://x.com/home';
const sample = tweet();
sample.legacy.full_text = '周末海边散步｜沿着海岸线走走，听一听海浪的声音。';
sample.core = {user_results: {result: {core: {name: '小林', screen_name: 'sample_lin'}}}};
const records = [...api.extractMedia(require('./nasa-syndication-public.json'), previewUrl), ...api.extractMedia(sample, previewUrl)];
const mock = `
const sampleItems=${JSON.stringify(records)};
const empty=new URLSearchParams(location.search).has('empty');
let sampleDownload=null, askWhere=false;
window.chrome={
 runtime:{sendMessage:async message=>{
   if(message.type==='GET_MEDIA')return {ok:true,items:empty?[]:sampleItems,pageUrl:${JSON.stringify(previewUrl)},diagnostics:{reader:true,observer:true,responses:0,domScans:1},fallback:{state:'no-mp4'}};
   if(message.type==='DOWNLOAD'){
     const selected=sampleItems.find(item=>item.key===message.key);
     sampleDownload={id:1,title:selected?.title,filename:'示例视频.mp4',state:'in_progress',bytesReceived:2200000,totalBytes:5178622,exists:true};
     setTimeout(()=>{sampleDownload={...sampleDownload,state:'complete',bytesReceived:5178622};},1400);
     return {ok:true,id:1};
   }
   if(message.type==='GET_DOWNLOADS')return {ok:true,items:sampleDownload?[sampleDownload]:[]};
   return {ok:false,error:'Unknown preview message'};
 }},
 storage:{local:{get:async()=>({askWhere}),set:async value=>{askWhere=value.askWhere;}}},
 tabs:{query:async()=>[{id:1,url:${JSON.stringify(previewUrl)}}],sendMessage:async()=>({ok:true}),reload:async()=>{},create:async()=>{}},
 downloads:{cancel:async()=>{sampleDownload.state='interrupted';sampleDownload.error='USER_CANCELED';},show:()=>{}}
};
`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>插件界面测试 · 示例数据</title><style>body{margin:0;background:#e9edf5;font-family:system-ui;padding:24px;text-align:center;color:#64748b}p{font-size:12px;margin:0 0 16px}iframe{width:402px;height:750px;border:1px solid #d7dfed;border-radius:16px;box-shadow:0 15px 50px #20304f14;background:#f6f8fc}</style><p>插件界面测试 · 示例数据，不执行真实下载</p><iframe title="下载助手预览" src="/popup.html' + (url.search || '') + '"></iframe></html>');
  }
  if (url.pathname === '/__mock.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(mock); }
  const file = path.resolve(root, '.' + url.pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png'};
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  if (file.endsWith('/popup.html')) return res.end(fs.readFileSync(file, 'utf8').replace('<script src="shared.js">', '<script src="/__mock.js"></script><script src="shared.js">'));
  fs.createReadStream(file).pipe(res);
});
server.listen(18766, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:18766 (mock data only)'));
