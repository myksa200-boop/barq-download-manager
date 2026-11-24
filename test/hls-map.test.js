'use strict';
/**
 * اختبارات HLS: مقطع التهيئة (EXT-X-MAP / fMP4) وتراكم مستمعي الإيقاف.
 * تشغيل: node test/hls-map.test.js
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getEventListeners } = require('events');
const { HlsTask } = require('../src/main/engine');

const SEGS = Array.from({ length: 60 }, (_, i) => crypto.randomBytes(20000 + i));
const MAP = Buffer.from('INIT-SEGMENT-' + 'x'.repeat(100));
let mapDelay = 0; let mapStatus = 200;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/v.m3u8') {
    let t = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' + (u.searchParams.has('map') ? '#EXT-X-MAP:URI="init.mp4"\n' : '');
    SEGS.forEach((_, i) => { t += `#EXTINF:2.0,\nseg${i}.ts\n`; });
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(t + '#EXT-X-ENDLIST\n');
  }
  if (u.pathname === '/init.mp4') return setTimeout(() => { res.writeHead(mapStatus); res.end(mapStatus === 200 ? MAP : ''); }, mapDelay);
  const m = /^\/seg(\d+)\.ts$/.exec(u.pathname);
  if (m) { res.writeHead(200); return res.end(SEGS[Number(m[1])]); }
  res.writeHead(404); res.end();
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-hlsmap-'));
const rec = (o) => ({ _id: crypto.randomUUID(), saveDir: root, size: -1, segments: [], headers: '{}', ...o });
const run = (task) => new Promise((resolve) => {
  task.on('complete', (r) => resolve({ ok: true, r }));
  task.on('error', (e, msg) => resolve({ ok: false, msg }));
  task.start();
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const all = Buffer.concat(SEGS);

  // 1) مستمعو الإيقاف لا يتراكمون مع كل مقطع
  const t1 = new HlsTask(rec({ url: base + '/v.m3u8', fileName: 'a.ts' }), { connections: 4, hlsToMp4: false });
  let peak = 0;
  const iv = setInterval(() => { if (t1.abort) peak = Math.max(peak, getEventListeners(t1.abort.signal, 'abort').length); }, 2);
  let r = await run(t1);
  clearInterval(iv);
  assert.ok(r.ok, r.msg);
  assert.ok(fs.readFileSync(path.join(root, 'a.ts')).equals(all), 'HLS merge');
  assert.ok(peak <= 4 * 2, `abort listeners peaked at ${peak} for 60 segments`);
  console.log(`  ✓ HLS 60 segments merged, abort listeners stay bounded (peak ${peak})`);

  // 2) استئناف وكل المقاطع موجودة على القرص: مقطع التهيئة يبقى في أول الملف
  const r2 = rec({ url: base + '/v.m3u8?map=1', fileName: 'b.mp4' });
  const partDir = path.join(root, 'b.mp4.parts'); fs.mkdirSync(partDir, { recursive: true });
  SEGS.forEach((b, i) => fs.writeFileSync(path.join(partDir, `${i}.seg`), b));
  mapDelay = 300;
  r = await run(new HlsTask(r2, { connections: 4, hlsToMp4: false }));
  assert.ok(r.ok, r.msg);
  assert.ok(fs.readFileSync(path.join(root, 'b.mp4')).equals(Buffer.concat([MAP, all])), 'init segment missing after resume');
  console.log('  ✓ EXT-X-MAP kept when resuming with every segment already on disk');

  // 3) مقطع تهيئة أبطأ من كل المقاطع
  mapDelay = 1200;
  r = await run(new HlsTask(rec({ url: base + '/v.m3u8?map=1', fileName: 'c.mp4' }), { connections: 8, hlsToMp4: false }));
  assert.ok(r.ok, r.msg);
  assert.ok(fs.readFileSync(path.join(root, 'c.mp4')).equals(Buffer.concat([MAP, all])), 'slow init segment missing');
  console.log('  ✓ EXT-X-MAP kept when the init segment arrives after the media segments');

  // 4) تعذّر جلب مقطع التهيئة: خطأ واضح بدل ملف تالف
  mapDelay = 0; mapStatus = 404;
  r = await run(new HlsTask(rec({ url: base + '/v.m3u8?map=1', fileName: 'd.mp4' }), { connections: 4, hlsToMp4: false }));
  assert.ok(!r.ok, 'must fail when the init segment is unavailable');
  assert.ok(!fs.existsSync(path.join(root, 'd.mp4')), 'no corrupt output');
  console.log('  ✓ missing init segment → error, no corrupt file (' + r.msg + ')');

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nHLS map tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED', e.stack); process.exit(1); });
