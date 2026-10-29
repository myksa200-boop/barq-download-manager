'use strict';
/** اختبار تكامل yt-dlp بمحاكٍ محلي: node test/ytdlp.test.js (يتطلب FFmpeg) */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../src/main/db');
const { Manager } = require('../src/main/manager');
const { Components, ytdlpInfo, isYtdlpUrl } = require('../src/main/ytdlp');
const { findFfmpeg } = require('../src/main/ffmpeg');

const wait = (mgr, ev, pred = () => true, ms = 60000) => new Promise((res, rej) => {
  const tm = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
  const fn = (...a) => { if (pred(...a)) { clearTimeout(tm); mgr.off(ev, fn); res(a); } };
  mgr.on(ev, fn);
});

(async () => {
  const ff = await findFfmpeg();
  if (!ff) { console.log('FFmpeg not found — yt-dlp test skipped'); process.exit(0); }
  const probe = (f, what) => execFileSync(fs.existsSync(ff.replace(/ffmpeg$/, 'ffprobe')) ? ff.replace(/ffmpeg$/, 'ffprobe') : 'ffprobe', ['-v', 'error', '-show_entries', what, '-of', 'csv=p=0', f]).toString().trim().split('\n').sort().join('+');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-yt-'));
  const media = path.join(tmp, 'media'); fs.mkdirSync(media);
  execFileSync(ff, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', path.join(media, 'video_only.mp4')]);
  execFileSync(ff, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', path.join(media, 'audio_only.m4a')]);
  const fake = path.join(__dirname, 'fake-ytdlp.js');
  fs.chmodSync(fake, 0o755);
  const logFile = path.join(tmp, 'fake.log');
  process.env.FAKE_MEDIA_DIR = media; process.env.FAKE_LOG = logFile;
  const ok = (n) => console.log('  ✓', n);

  db.open(path.join(tmp, 'db.realm'));
  const settings = { ytdlpPath: fake, ffmpegPath: ff };
  db.settings.save({ ...settings, showProgressOnStart: false });
  const components = new Components({ binDir: path.join(tmp, 'bin'), getSettings: () => db.settings.all(), saveSettings: p => db.settings.save(p) });
  const mgr = new Manager(db, { defaultRoot: path.join(tmp, 'Downloads'), components });

  assert.ok(isYtdlpUrl('https://www.youtube.com/watch?v=abc') && isYtdlpUrl('https://youtu.be/abc') && isYtdlpUrl('https://x.com/u/status/1') && !isYtdlpUrl('https://example.com/a.zip'));
  ok('recognizes YouTube, youtu.be, X … and leaves direct files to the main engine');

  const info = await mgr.inspect({ url: 'https://www.youtube.com/watch?v=dQw4', cookies: 'SID=1; HSID=2; LOGIN_INFO=3' });
  assert.strictEqual(info.kind, 'ytdlp');
  assert.strictEqual(info.fileName, 'فيديو تجريبي_ شرح التقنية.mp4');
  assert.deepStrictEqual(info.variants.map(v => v.resolution + (v.label || '')), ['1080p', '720p', '360p', 'audioM4A', 'audioMP3']);
  ok(`inspect: title, ${info.variants.length} quality options (1080p/720p/360p/M4A/MP3), size ≈ ${(info.size / 1e6).toFixed(1)} MB`);

  const pl = await mgr.inspect({ url: 'https://www.youtube.com/playlist?list=PL123' });
  assert.ok(pl.playlist && pl.entries.length === 3);
  ok(`playlist: ${pl.entries.length} videos detected ("${pl.title}")`);

  // تنزيل 720p + الكوكيز
  const r1 = mgr.add({ url: 'https://www.youtube.com/watch?v=dQw4', fileName: info.fileName, hlsVariant: 'v:720', cookies: 'SID=1; HSID=2; LOGIN_INFO=3', start: 'now' });
  assert.strictEqual(r1.kind, 'ytdlp');
  let sawMerging = false; let maxPct = 0;
  const onUpd = (r) => { if (r._id === r1._id && r.status === 'merging') sawMerging = true; };
  const onProg = (id, s) => { if (id === r1._id && s.size > 0) maxPct = Math.max(maxPct, s.downloaded / s.size); };
  mgr.on('update', onUpd); mgr.on('progress', onProg);
  const [d1] = await wait(mgr, 'complete', r => r._id === r1._id);
  mgr.off('update', onUpd); mgr.off('progress', onProg);
  const f1 = path.join(d1.saveDir, d1.fileName);
  assert.strictEqual(probe(f1, 'stream=codec_type'), 'audio+video');
  const lg = fs.readFileSync(logFile, 'utf8').trim().split('\n').pop();
  assert.ok(/js=v2\d/.test(lg) && /cookies=3/.test(lg) && /N=\d+/.test(lg) && /chunk=10M/.test(lg) && /height<=720/.test(lg), lg);
  ok(`download 720p → ${d1.fileName} (video+audio merged), progress reached ${Math.round(maxPct * 100)}%, merging state shown: ${sawMerging}`);
  ok(`yt-dlp received: JS runtime ${lg.match(/js=(\S+)/)[1]}, 3 cookies, ${lg.match(/N=(\S+)/)[0]} parallel fragments, 10M chunks`);

  // إيقاف واستئناف
  process.env.FAKE_SLOW_MS = '150';
  const r2 = mgr.add({ url: 'https://www.youtube.com/watch?v=pause1', fileName: 'pause-test.mp4', hlsVariant: 'v:1080', start: 'now' });
  await wait(mgr, 'progress', (id, s) => id === r2._id && s.downloaded > 0);
  await new Promise(r => setTimeout(r, 900));
  await mgr.pause(r2._id);
  const p2 = db.downloads.get(r2._id);
  assert.strictEqual(p2.status, 'paused');
  const parts = fs.readdirSync(p2.saveDir).filter(f => f.startsWith('pause-test') && f.endsWith('.part'));
  assert.ok(parts.length >= 1, 'no .part kept');
  process.env.FAKE_SLOW_MS = '20';
  mgr.start(r2._id);
  const [d2] = await wait(mgr, 'complete', r => r._id === r2._id);
  assert.strictEqual(probe(path.join(d2.saveDir, d2.fileName), 'stream=codec_type'), 'audio+video');
  ok(`pause → process stopped, partial file kept (${parts.join(', ')}) → resume → complete`);

  // صوت MP3
  const r3 = mgr.add({ url: 'https://www.youtube.com/watch?v=song', fileName: 'song.mp3', hlsVariant: 'a:mp3', start: 'now' });
  const [d3] = await wait(mgr, 'complete', r => r._id === r3._id);
  assert.ok(/\.mp3$/.test(d3.fileName));
  assert.strictEqual(probe(path.join(d3.saveDir, d3.fileName), 'stream=codec_name'), 'mp3');
  ok(`audio only → ${d3.fileName} (codec mp3 via FFmpeg)`);

  // أخطاء مفهومة
  const r4 = mgr.add({ url: 'https://www.youtube.com/watch?v=bot', fileName: 'x.mp4', start: 'now' });
  const [, msg] = await wait(mgr, 'failed', id => id === r4._id);
  assert.ok(/تسجيل الدخول/.test(msg), msg);
  ok('bot-check error → clear Arabic message: "' + msg.slice(0, 60) + '…"');

  // قائمة تشغيل كاملة
  mgr.saveQueue({ ...db.queues.get('main'), maxConcurrent: 2 });
  mgr.addPlaylist(pl.entries, { variant: 'v:720', queueId: 'main', start: true });
  await wait(mgr, 'queue-done', () => true, 90000);
  const eps = db.downloads.all().filter(d => /الحلقة/.test(d.fileName));
  assert.strictEqual(eps.length, 3); assert.ok(eps.every(d => d.status === 'complete'));
  ok('playlist → 3 videos queued (2 at a time) → all complete');

  const st = await components.status();
  assert.ok(st.ytdlp && st.ytdlp.version === '2026.10.20' && st.ffmpeg);
  const up = await components.updateYtdlp();
  assert.ok(/up to date/.test(up));
  ok(`components: yt-dlp ${st.ytdlp.version}, FFmpeg found, update command works`);

  mgr.dispose(); db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nyt-dlp tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
