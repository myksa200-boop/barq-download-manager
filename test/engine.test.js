'use strict';
/** اختبارات المحرك: node test/engine.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeServer } = require('./server');
const { HttpTask, HlsTask, probe, hlsVariants } = require('../src/main/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let n = 0;
const rec = (url, extra = {}) => ({ _id: 't' + (++n), url, fileName: `f${n}.bin`, saveDir: tmp, size: -1, segments: [], ...extra });

function run(task) {
  return new Promise((resolve, reject) => {
    task.on('complete', resolve);
    task.on('error', (e, msg) => reject(Object.assign(e, { friendly: msg })));
    task.start();
  });
}

async function main() {
  const { server, data, stats, hlsPlain } = makeServer({ size: 6 * 1024 * 1024, perConnKBps: 1500, unevenSlow: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  const ok = (name) => { results.push(name); console.log('  ✓', name); };

  // 1) probe + redirect + filename from Content-Disposition
  const p = await probe(base + '/redirect');
  assert.strictEqual(p.size, data.length); assert.ok(p.resumable); assert.ok(p.finalUrl.endsWith('/files/test.bin'));
  const p2 = await probe(base + '/dl');
  assert.strictEqual(p2.fileName, 'ملف عربي.zip');
  ok('probe: size, resume support, redirects, Content-Disposition (UTF-8)');

  // 2) multi-connection + dynamic split
  stats.rangeRequests.length = 0;
  const t1 = new HttpTask(rec(base + '/files/test.bin'), { connections: 4 });
  let maxSegs = 0;
  t1.on('progress', s => { maxSegs = Math.max(maxSegs, s.segments.length); });
  const r1 = await run(t1);
  assert.strictEqual(sha(fs.readFileSync(r1.path)), sha(data));
  assert.ok(maxSegs > 4, 'expected dynamic re-split, got ' + maxSegs);
  ok(`dynamic segmentation: 4 connections → ${maxSegs} segments, file hash matches`);

  // 3) pause / resume using persisted segments
  const r2rec = rec(base + '/files/test.bin');
  const t2 = new HttpTask(r2rec, { connections: 6 });
  let paused;
  await new Promise((resolve, reject) => {
    t2.on('error', reject);
    t2.on('paused', s => { paused = s; resolve(); });
    t2.on('progress', s => { if (s.downloaded > data.length * 0.3 && !t2._p) { t2._p = 1; t2.pause(); } });
    t2.start();
  });
  assert.ok(paused.downloaded > 0 && paused.downloaded < data.length);
  const before = paused.downloaded;
  const t2b = new HttpTask({ ...r2rec, size: paused.size, segments: paused.segments }, { connections: 6 });
  let firstDl = -1;
  t2b.on('progress', s => { if (firstDl < 0) firstDl = s.downloaded; });
  const r2 = await run(t2b);
  assert.strictEqual(sha(fs.readFileSync(r2.path)), sha(data));
  assert.ok(firstDl >= before, 'resume should continue, not restart');
  ok(`pause/resume: paused at ${(before / 1048576).toFixed(1)} MB, resumed and completed with matching hash`);

  // 4) server without range support
  const t3 = new HttpTask(rec(base + '/norange'), { connections: 8 });
  const r3 = await run(t3);
  assert.strictEqual(t3.resumable, false);
  assert.strictEqual(sha(fs.readFileSync(r3.path)), sha(data));
  ok('single-connection fallback for servers without Range');

  // 5) speed limiter
  const t4 = new HttpTask(rec(base + '/files/test.bin', { speedLimit: 1024 }), { connections: 4 });
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    t4.on('error', reject);
    t4.on('progress', s => { if (s.downloaded > 2 * 1048576 && !t4._p) { t4._p = 1; t4.pause().then(resolve); } });
    t4.start();
  });
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs > 1.5, 'limiter too fast: ' + secs);
  ok(`speed limiter 1024 KB/s: 2 MB took ${secs.toFixed(1)}s`);

  // 6) 403 handling
  const t5 = new HttpTask(rec(base + '/forbidden'), {});
  await assert.rejects(run(t5), e => /403/.test(e.friendly));
  ok('HTTP 403 reported with a friendly message');

  // 7) HLS master → variants, AES-128
  const vars = await hlsVariants(base + '/hls/master.m3u8');
  assert.strictEqual(vars.length, 2); assert.strictEqual(vars[0].resolution, '1280x720');
  const t6 = new HlsTask(rec(base + '/hls/master.m3u8', { fileName: 'video.ts', kind: 'hls' }), { connections: 4, ffmpeg: null });
  const r6 = await run(t6);
  assert.strictEqual(sha(fs.readFileSync(r6.path)), sha(hlsPlain));
  ok('HLS: variant selection, AES-128 decryption, segment merge');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${results.length} tests passed`);
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.friendly || '', e); process.exit(1); });
