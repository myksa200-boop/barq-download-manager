'use strict';
/** خادم اختبار محلي: يدعم Range، تحويلات، 403، خادم بدون استئناف، وHLS مشفر */
const http = require('http');
const crypto = require('crypto');

function makeServer({ size = 8 * 1024 * 1024, perConnKBps = 0, unevenSlow = false } = {}) {
  const data = crypto.randomBytes(size);
  const key = crypto.randomBytes(16);
  const hlsSegs = Array.from({ length: 12 }, () => crypto.randomBytes(50000 + Math.floor(Math.random() * 20000)));
  const stats = { rangeRequests: [], conns: 0 };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/redirect') { res.writeHead(302, { Location: '/files/test.bin' }); return res.end(); }
    if (u.pathname === '/forbidden') { res.writeHead(403); return res.end('no'); }
    if (u.pathname === '/norange') {
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
      return send(res, data, 0, size - 1, 0);
    }
    if (u.pathname === '/files/test.bin' || u.pathname === '/dl') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', ETag: '"v1"' };
      if (u.pathname === '/dl') headers['Content-Disposition'] = "attachment; filename=\"file.zip\"; filename*=UTF-8''" + encodeURIComponent('ملف عربي.zip');
      if (!range) { res.writeHead(200, { ...headers, 'Content-Length': size }); return send(res, data, 0, size - 1, perConnKBps); }
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      stats.rangeRequests.push([start, end]);
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      // الاتصال الأول أبطأ لإظهار إعادة التقسيم الديناميكي
      const slow = unevenSlow && start === 0 ? perConnKBps / 4 : perConnKBps;
      return send(res, data, start, end, slow);
    }
    if (u.pathname === '/hls/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\nhigh.m3u8\n');
    }
    if (u.pathname === '/hls/high.m3u8' || u.pathname === '/hls/low.m3u8') {
      let t = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n';
      hlsSegs.forEach((_, i) => { t += `#EXTINF:4.0,\nseg${i}.ts\n`; });
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(t + '#EXT-X-ENDLIST\n');
    }
    if (u.pathname === '/hls/key.bin') { res.writeHead(200); return res.end(key); }
    const m = /^\/hls\/seg(\d+)\.ts$/.exec(u.pathname);
    if (m) {
      const i = Number(m[1]);
      const iv = Buffer.alloc(16); iv.writeUInt32BE(i, 12);
      const c = crypto.createCipheriv('aes-128-cbc', key, iv);
      const enc = Buffer.concat([c.update(hlsSegs[i]), c.final()]);
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': enc.length });
      return res.end(enc);
    }
    res.writeHead(404); res.end();
  });
  server.on('connection', () => stats.conns++);

  function send(res, buf, start, end, kbps) {
    let pos = start;
    const chunk = 16 * 1024;
    const interval = kbps ? (chunk / (kbps * 1024)) * 1000 : 0;
    const pump = () => {
      while (pos <= end) {
        const e = Math.min(end + 1, pos + chunk);
        const ok = res.write(buf.subarray(pos, e));
        pos = e;
        if (interval) { if (pos <= end) setTimeout(pump, interval); else res.end(); return; }
        if (!ok) { res.once('drain', pump); return; }
      }
      res.end();
    };
    res.on('close', () => { pos = end + 1; });
    pump();
  }

  return { server, data, stats, hlsPlain: Buffer.concat(hlsSegs) };
}

module.exports = { makeServer };
