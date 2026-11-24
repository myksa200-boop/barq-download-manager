'use strict';
/**
 * البدائل عند رفض الخادم + إعادة المحاولة عند 429/503: node test/net-fallback.test.js
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const NET = require('../src/main/net');
const { HttpTask, probe } = require('../src/main/engine');

const DATA = crypto.randomBytes(6 * 1024 * 1024);
const stats = { resets: 0, browserServed: 0, honestServed: 0, limited: 0, flaky: 0 };
let limitLeft = 0; let flakyLeft = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ua = req.headers['user-agent'] || '';
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const send = () => {
    if (range) {
      const s = Number(range[1]); const e = range[2] ? Number(range[2]) : DATA.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${DATA.length}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
      return res.end(DATA.subarray(s, e + 1));
    }
    res.writeHead(200, { 'Content-Length': DATA.length }); res.end(DATA);
  };
  if (u.pathname === '/nobrowser.bin') {         // مثل خوادم اختبار السرعة: تقطع الاتصال على هوية المتصفح
    if (/Mozilla/.test(ua)) { stats.resets++; return req.socket.destroy(); }
    stats.honestServed++; return send();
  }
  if (u.pathname === '/limited.bin') {
    if (limitLeft > 0) { limitLeft--; stats.limited++; res.writeHead(429, { 'Retry-After': '1' }); return res.end(); }
    return send();
  }
  if (u.pathname === '/flaky.bin') {
    if (flakyLeft > 0) { flakyLeft--; stats.flaky++; return req.socket.destroy(); }
    return send();
  }
  if (u.pathname === '/forbidden.bin') { res.writeHead(403); return res.end(); }
  stats.browserServed++; send();
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-netfb-'));
const run = (task) => new Promise((resolve) => { task.on('complete', r => resolve({ ok: true, r })); task.on('error', (e, m) => resolve({ ok: false, m })); task.start(); });

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1) خادم يقطع الاتصال على هوية المتصفح: الفحص ينجح بالهوية الصريحة، والتنزيل كله يستخدمها
  const m = await probe(base + '/nobrowser.bin', {}, 5000);
  assert.strictEqual(m.size, DATA.length);
  assert.strictEqual(m.userAgent, NET.HONEST_UA);
  const t = new HttpTask({ _id: 'a', url: base + '/nobrowser.bin', fileName: 'a.bin', saveDir: tmp, size: -1, segments: [], headers: '{}' }, { connections: 8 });
  const resetsBefore = stats.resets;
  let r = await run(t);
  assert.ok(r.ok, r.m);
  assert.ok(fs.readFileSync(path.join(tmp, 'a.bin')).equals(DATA), 'file intact');
  assert.strictEqual(stats.resets, resetsBefore, 'download connections must reuse the accepted identity (no new resets)');
  console.log(`  ✓ server that resets browser identities: download completes with "${NET.HONEST_UA}" (${stats.honestServed} requests served, ${stats.resets} reset)`);

  // 2) يُتذكَّر لكل خادم: الطلب التالي يذهب مباشرة بالهوية المقبولة
  const before = stats.resets;
  await NET.fetchBuffer(base + '/nobrowser.bin', { headers: { Range: 'bytes=0-9' } });
  assert.strictEqual(stats.resets, before, 'host preference remembered');
  console.log('  ✓ accepted identity remembered for the host (no second reset)');

  // 3) هوية حددها المستخدم لا تُستبدل
  NET._hostPrefs.clear();
  await assert.rejects(probe(base + '/nobrowser.bin', { 'User-Agent': 'Mozilla/5.0 custom' }, 5000, { retries: 0 }));
  console.log('  ✓ a user-chosen User-Agent is never replaced');

  // 4) 429 مع Retry-After: ينتظر ثم ينجح بدل الفشل فوراً
  limitLeft = 2;
  let t0 = Date.now();
  const m4 = await probe(base + '/limited.bin', {}, 5000);
  const waited = Date.now() - t0;
  assert.strictEqual(m4.size, DATA.length);
  assert.ok(waited >= 1800 && waited < 6000, 'honours Retry-After: waited ' + waited);
  console.log(`  ✓ HTTP 429 + Retry-After:1 twice → waited ${(waited / 1000).toFixed(1)}s, then succeeded`);

  // 5) 429 دائم: يتوقف بعد عدد المحاولات برسالة واضحة
  limitLeft = 100;
  t0 = Date.now();
  await assert.rejects(probe(base + '/limited.bin', {}, 5000, { retries: 2 }), e => e.status === 429);
  console.log(`  ✓ persistent 429 → gives up after 2 retries (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 6) الفحص السريع (retries: 0) لا ينتظر
  t0 = Date.now();
  await assert.rejects(probe(base + '/limited.bin', {}, 5000, { retries: 0 }));
  assert.ok(Date.now() - t0 < 1000);
  limitLeft = 0;
  console.log('  ✓ quick check (retries: 0) does not wait');

  // 7) 429 أثناء بدء التنزيل نفسه: التنزيل يكمل
  limitLeft = 1;
  r = await run(new HttpTask({ _id: 'b', url: base + '/limited.bin', fileName: 'b.bin', saveDir: tmp, size: -1, segments: [], headers: '{}' }, { connections: 8 }));
  assert.ok(r.ok, r.m);
  assert.ok(fs.readFileSync(path.join(tmp, 'b.bin')).equals(DATA));
  console.log('  ✓ download that starts with a 429 completes');

  // 8) انقطاع عابر في أول اتصال
  NET._hostPrefs.clear();
  flakyLeft = 1;
  const m8 = await probe(base + '/flaky.bin', {}, 5000);
  assert.strictEqual(m8.size, DATA.length);
  console.log('  ✓ one transient reset on the first request is retried');

  // 9) 403 حقيقي: خطأ سريع بلا تعليق
  t0 = Date.now();
  await assert.rejects(probe(base + '/forbidden.bin', {}, 5000), e => e.status === 403);
  assert.ok(Date.now() - t0 < 2000);
  console.log('  ✓ real 403 still fails fast');

  // 10) خادم عادي: هوية كروم الحديثة، بلا تغيير
  NET._hostPrefs.clear();
  const m10 = await probe(base + '/normal.bin', {}, 5000);
  assert.strictEqual(m10.userAgent, '');
  assert.ok(/Chrome\/1[5-9]\d\./.test(NET.DEFAULT_UA), NET.DEFAULT_UA);
  console.log('  ✓ normal server: default identity ' + NET.DEFAULT_UA.split(') ').pop());

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nnet fallback tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED', e.stack); process.exit(1); });
