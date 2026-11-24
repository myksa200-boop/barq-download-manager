'use strict';
/**
 * محرك Chromium (HTTP/2 وHTTP/3) داخل Electron نفسه:
 *   electron test/electron            (المجلد فيه package.json يشير إلى هذا الملف)
 * يكتب النتائج إلى stdout وإلى test/electron/result.txt. REAL=1 لاختبارات الإنترنت (السرعة وHTTP/3).
 */
const { app, session } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

app.disableHardwareAcceleration();
const OUT = path.join(__dirname, 'electron', 'result.txt');
const log = (s) => { process.stdout.write(s + '\n'); fs.appendFileSync(OUT, s + '\n'); };

const NET = require('../src/main/net');
const { HttpTask, HlsTask } = require('../src/main/engine');

const DATA = crypto.randomBytes(16 * 1024 * 1024);
const SEGS = Array.from({ length: 40 }, (_, i) => crypto.randomBytes(50000 + i));
const INIT = Buffer.from('INIT-fmp4-segment');
const seen = { referer: new Set(), cookie: new Set(), ua: new Set(), conns: new Set(), redirectAuth: [] };

function startServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.conns.add(req.socket.remotePort);
    if (req.headers.referer) seen.referer.add(req.headers.referer);
    if (req.headers.cookie) seen.cookie.add(req.headers.cookie);
    if (req.headers['user-agent']) seen.ua.add(req.headers['user-agent']);
    if (u.pathname === '/redir') { res.writeHead(302, { Location: `http://localhost:${srv.address().port}/landing` }); return res.end(); }
    if (u.pathname === '/landing') { seen.redirectAuth.push(req.headers.authorization || ''); }
    if (u.pathname === '/v.m3u8') {
      let m = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n';
      for (let i = 0; i < 40; i++) m += `#EXTINF:2.0,\nseg${i}.ts\n`;
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m + '#EXT-X-ENDLIST\n');
    }
    if (u.pathname === '/init.mp4') { res.writeHead(200); return res.end(INIT); }
    const sm = /^\/seg(\d+)\.ts$/.exec(u.pathname);
    if (sm) { res.writeHead(200); return res.end(SEGS[Number(sm[1])]); }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const s = Number(range[1]); const e = range[2] ? Number(range[2]) : DATA.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${DATA.length}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
      // تدفق بطيء قليلاً ليظهر أثر تعدد الاتصالات ويمكن الإيقاف في المنتصف
      const body = DATA.subarray(s, e + 1); let off = 0;
      const step = () => { if (res.destroyed) return; if (off >= body.length) return res.end(); const n = Math.min(128 * 1024, body.length - off); res.write(body.subarray(off, off + n)); off += n; setTimeout(step, 4); };
      return step();
    }
    res.writeHead(200, { 'Content-Length': DATA.length }); res.end(DATA);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const run = (task) => new Promise((resolve) => { task.on('complete', r => resolve({ ok: true, r })); task.on('error', (e, m) => resolve({ ok: false, m })); task.start(); });

async function local(tmp) {
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  // 1) تنزيل متعدد الاتصالات عبر Chromium: سلامة الملف + أكثر من 6 اتصالات (مسارات مستقلة) + الترويسات
  const rec = { _id: 'c1', url: base + '/file.bin', fileName: 'c1.bin', saveDir: tmp, size: -1, segments: [], referer: 'https://example.com/page', cookies: 'sid=abc123', headers: '{}' };
  const t = new HttpTask(rec, { connections: 16, adaptive: false });
  seen.conns.clear();
  let r = await run(t);
  assert.ok(r.ok, r.m);
  assert.strictEqual(t.transport, 'chromium');
  assert.ok(fs.readFileSync(path.join(tmp, 'c1.bin')).equals(DATA), 'chromium download intact');
  assert.ok(seen.referer.has('https://example.com/page'), 'Referer reached the server: ' + [...seen.referer]);
  assert.ok(seen.cookie.has('sid=abc123'), 'Cookie reached the server');
  log(`  ✓ chromium engine: 16 MB intact over ${seen.conns.size} TCP connections (>6 thanks to lanes); Referer and Cookie delivered`);
  assert.ok(seen.conns.size > 6, 'more than 6 parallel connections');

  // 2) إيقاف واستئناف عبر Chromium
  const rec2 = { _id: 'c2', url: base + '/file.bin', fileName: 'c2.bin', saveDir: tmp, size: -1, segments: [], headers: '{}' };
  const t2 = new HttpTask(rec2, { connections: 8 });
  let snap = null; t2.on('paused', s => { snap = s; });
  t2.start();
  for (let i = 0; i < 400 && !(t2.downloaded > 2 * 1048576); i++) await new Promise(res => setTimeout(res, 5));
  const t0 = Date.now(); await t2.pause(); const pauseMs = Date.now() - t0;
  assert.ok(snap && snap.downloaded > 0 && snap.downloaded < DATA.length, 'paused mid-way');
  r = await run(new HttpTask({ ...rec2, size: DATA.length, segments: snap.segments }, { connections: 8 }));
  assert.ok(r.ok, r.m);
  assert.ok(fs.readFileSync(path.join(tmp, 'c2.bin')).equals(DATA), 'resume intact');
  log(`  ✓ chromium engine: pause at ${(snap.downloaded / 1048576).toFixed(1)} MB (took ${pauseMs} ms) → resume → file intact`);

  // 3) التحويل إلى خادم آخر لا يحمل Authorization
  seen.redirectAuth = [];
  const { res } = await NET.request(base + '/redir', { headers: { Authorization: 'Basic eDp5', Range: 'bytes=0-9' }, transport: 'chromium' });
  res.resume();
  assert.deepStrictEqual(seen.redirectAuth, [''], 'Authorization stripped on cross-host redirect');
  log('  ✓ chromium engine: cross-host redirect followed, Authorization not forwarded');

  // 4) HLS بمقطع تهيئة عبر محرك Chromium
  r = await run(new HlsTask({ _id: 'h', url: base + '/v.m3u8', fileName: 'h.mp4', saveDir: tmp, size: -1, segments: [], headers: '{}' }, { connections: 6, hlsToMp4: false }));
  assert.ok(r.ok, r.m);
  assert.ok(fs.readFileSync(path.join(tmp, 'h.mp4')).equals(Buffer.concat([INIT, ...SEGS])), 'HLS intact');
  log('  ✓ chromium engine: HLS 40 segments + EXT-X-MAP merged intact');
  srv.close();
}

async function real(tmp) {
  const results = [];
  const speed = async (label, url, engine, conns) => {
    NET._hostPrefs.clear();
    NET.configure({ engine: () => engine });
    const rec = { _id: crypto.randomUUID(), url, fileName: `${engine}-${conns}.bin`, saveDir: tmp, size: -1, segments: [], headers: '{}' };
    const t = new HttpTask(rec, { connections: conns });
    const t0 = Date.now();
    const r = await run(t);
    if (!r.ok) { log(`  ${label} ${engine} x${conns}: ERROR ${r.m}`); return null; }
    const sec = (Date.now() - t0) / 1000;
    const h = crypto.createHash('sha256').update(fs.readFileSync(r.r.path)).digest('hex').slice(0, 12);
    fs.rmSync(r.r.path, { force: true });
    log(`  ${label.padEnd(8)} ${engine.padEnd(8)} x${String(conns).padEnd(2)} via ${t.transport.padEnd(8)} ${sec.toFixed(1).padStart(5)} s  ${(r.r.size / 1048576 / sec).toFixed(1).padStart(5)} MB/s  sha ${h}`);
    results.push({ label, engine, conns, sec, h });
    return h;
  };
  const targets = [
    ['GitHub', 'https://github.com/myksa200-boop/barq-download-manager/releases/download/v1.4.1/Barq-Setup-1.4.1.exe'],
    ['Google', 'https://dl.google.com/go/go1.23.4.windows-amd64.zip'],
  ];
  for (const [label, url] of targets) {
    for (const [engine, conns] of [['auto', 8], ['chromium', 8], ['auto', 8], ['chromium', 8]]) await speed(label, url, engine, conns);
  }
  // HTTP/3: سجل الشبكة لمسار واحد يجب أن يحوي جلسة QUIC مع خادم Google
  NET._hostPrefs.clear();
  NET.configure({ engine: () => 'chromium' });
  const logFile = path.join(tmp, 'lane1.netlog.json');
  const ses = session.fromPartition('barq-net-1', { cache: false });
  await ses.netLog.startLogging(logFile, { captureMode: 'default' });
  const rec = { _id: 'q', url: targets[1][1], fileName: 'q.bin', saveDir: tmp, size: -1, segments: [], headers: '{}' };
  const r = await run(new HttpTask(rec, { connections: 8 }));
  await ses.netLog.stopLogging();
  const nl = fs.readFileSync(logFile, 'utf8');
  const quic = (nl.match(/"QUIC_SESSION/g) || []).length;
  const quicHost = /dl\.google\.com/.test(nl) && /quic/i.test(nl);
  log(`  HTTP/3 check: download ${r.ok ? 'ok' : 'failed ' + r.m}; lane-1 netlog QUIC_SESSION events = ${quic}${quicHost ? ' (dl.google.com over QUIC)' : ''}`);
  if (r.ok) fs.rmSync(r.r.path, { force: true });
  return results;
}

app.whenReady().then(async () => {
  fs.writeFileSync(OUT, '');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-chromium-'));
  try {
    assert.ok(NET.enableChromium(), 'electron net available');
    NET.configure({ engine: () => 'chromium' });
    log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`);
    await local(tmp);
    if (process.env.REAL) await real(tmp);
    log('\nchromium engine tests passed');
  } catch (e) {
    log('FAILED ' + (e && e.stack));
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  }
});
