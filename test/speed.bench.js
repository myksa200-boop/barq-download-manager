'use strict';
/**
 * قياس التسريع الحقيقي: node test/speed.bench.js
 * خوادم محلية تحاكي ظروفاً واقعية: حدّ سرعة لكل اتصال (مثل CDN)، عقدة CDN بطيئة،
 * خادم يرفض أكثر من 4 اتصالات، وخادمان (Mirrors) لكل منهما حدّ إجمالي.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HttpTask } = require('../src/main/engine');

const SIZE = 24 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const HASH = crypto.createHash('sha256').update(DATA).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-bench-'));

function server({ perConnKBps = 0, totalKBps = 0, slowFirst = 0, slowKBps = 64, maxConns = 0 }) {
  let connCount = 0; let active = 0;
  const bucket = { tokens: 0, last: Date.now() };
  const takeTotal = (n) => {
    if (!totalKBps) return 0;
    const rate = totalKBps * 1024; const now = Date.now();
    bucket.tokens = Math.min(rate * 0.2, bucket.tokens + (now - bucket.last) / 1000 * rate); bucket.last = now;
    bucket.tokens -= n;
    return bucket.tokens < 0 ? (-bucket.tokens / rate) * 1000 : 0;
  };
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    if (maxConns && active >= maxConns && m) { res.writeHead(503, { 'Retry-After': '1' }); return res.end(); }
    const idx = ++connCount;
    active++;
    res.on('close', () => { active--; });
    const kbps = m && idx <= slowFirst + 1 && idx > 1 ? slowKBps : perConnKBps;   // الاتصال الأول هو الاستكشاف
    res.writeHead(m ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}) });
    let pos = start; const chunk = 32 * 1024; let closed = false;
    res.on('close', () => { closed = true; });
    const pump = () => {
      if (closed) return;
      if (pos > end) return res.end();
      const e = Math.min(end + 1, pos + chunk);
      const ok = res.write(DATA.subarray(pos, e));
      const n = e - pos; pos = e;
      let wait = kbps ? (n / (kbps * 1024)) * 1000 : 0;
      wait = Math.max(wait, takeTotal(n));
      if (wait) setTimeout(pump, wait); else if (ok) setImmediate(pump); else res.once('drain', pump);
    };
    pump();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/file.bin` })));
}

async function run(name, url, opts, rec = {}) {
  const t = new HttpTask({ _id: name, url, fileName: name.replace(/\W+/g, '_') + '.bin', saveDir: tmp, size: -1, segments: [], ...rec }, { retries: 5, ...opts });
  const t0 = Date.now();
  const r = await new Promise((res, rej) => { t.on('complete', res); t.on('error', (e, m) => rej(new Error(m))); t.start(); });
  const secs = (Date.now() - t0) / 1000;
  const ok = crypto.createHash('sha256').update(fs.readFileSync(r.path)).digest('hex') === HASH;
  fs.rmSync(r.path, { force: true });
  return { secs, mbps: SIZE / 1048576 / secs, ok, stats: t.stats, cap: t.cap };
}
const fmt = (r) => (r.err ? '   فشل التنزيل' : `${r.secs.toFixed(1).padStart(5)} s  ${r.mbps.toFixed(2).padStart(6)} MB/s  ${r.ok ? 'SHA-256 ✓' : 'HASH ✗'}`);

(async () => {
  const rows = [];
  // 1) CDN يحدّ كل اتصال بـ 1 MB/s
  let s = await server({ perConnKBps: 1024 });
  const a1 = await run('one connection', s.url, { connections: 1, adaptive: false });
  const a2 = await run('barq 16 adaptive', s.url, { connections: 16 });
  s.srv.close();
  rows.push(['حد 1 MB/s لكل اتصال', 'اتصال واحد (متصفح عادي)', a1], ['', `برق (حتى 16، تكيّفي ← ${a2.cap})`, a2]);

  // 2) عقدة CDN بطيئة لاتصالين
  s = await server({ perConnKBps: 2048, slowFirst: 2, slowKBps: 48 });
  const b1 = await run('no slow restart', s.url, { connections: 6, adaptive: false, slowRestart: false, endgame: false });
  s.srv.close();
  s = await server({ perConnKBps: 2048, slowFirst: 2, slowKBps: 48 });
  const b2 = await run('slow restart', s.url, { connections: 6, adaptive: false });
  s.srv.close();
  rows.push(['اتصالان على عقدة بطيئة', '6 اتصالات (المحرك السابق)', b1], ['', `6 اتصالات + استبدال البطيء (${b2.stats.restarts}) + تقسيم النهاية`, b2]);

  // 3) خادم يرفض أكثر من 4 اتصالات (503)
  s = await server({ perConnKBps: 1024, maxConns: 4 });
  const c0 = await run('server limited old', s.url, { connections: 16, adaptive: false, slowRestart: false, endgame: false }).catch(e => ({ secs: NaN, mbps: 0, ok: false, err: e.message, stats: {} }));
  s.srv.close();
  s = await server({ perConnKBps: 1024, maxConns: 4 });
  const c1 = await run('server limited', s.url, { connections: 16 });
  s.srv.close();
  rows.push(['خادم يقبل 4 اتصالات فقط', c0.err ? `16 اتصالاً (المحرك السابق) ← فشل: ${c0.err.slice(0, 18)}` : '16 اتصالاً (المحرك السابق)', c0], ['', `برق يتكيّف إلى ${c1.cap} (${c1.stats.serverLimited} رفض)`, c1]);

  // 4) مصدران، لكل منهما حدّ إجمالي 3 MB/s
  const m1 = await server({ totalKBps: 3072 }); const m2 = await server({ totalKBps: 3072 });
  const d1 = await run('single source', m1.url, { connections: 8, adaptive: false });
  m1.srv.close();
  const m3 = await server({ totalKBps: 3072 });
  const d2 = await run('two mirrors', m3.url, { connections: 8, adaptive: false }, { mirrors: m2.url });
  m2.srv.close(); m3.srv.close();
  rows.push(['خادم بحد إجمالي 3 MB/s', 'مصدر واحد', d1], ['', `مصدران (Mirrors: ${d2.stats.mirrors})`, d2]);

  console.log('\nالسيناريو'.padEnd(28) + 'الطريقة'.padEnd(46) + 'النتيجة');
  for (const [a, b, r] of rows) console.log(a.padEnd(26) + b.padEnd(46) + fmt(r));
  console.log(`\nالتسريع: حدّ لكل اتصال ×${(a2.mbps / a1.mbps).toFixed(1)}   عقدة بطيئة ×${(b2.mbps / b1.mbps).toFixed(1)}   مصدران ×${(d2.mbps / d1.mbps).toFixed(1)}`);
  const all = [a1, a2, b1, b2, c1, d1, d2].every(r => r.ok);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(all ? 'all files verified' : 'HASH MISMATCH');
  process.exit(all ? 0 : 1);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
