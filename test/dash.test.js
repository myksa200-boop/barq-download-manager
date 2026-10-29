'use strict';
/** اختبار DASH بملفات حقيقية يولّدها FFmpeg: node test/dash.test.js  (يُتخطى إن لم يوجد FFmpeg) */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { DashTask, dashVariants } = require('../src/main/engine');
const { parseMpd } = require('../src/main/dash');
const { findFfmpeg } = require('../src/main/ffmpeg');

(async () => {
  const ff = await findFfmpeg();
  if (!ff) { console.log('FFmpeg not found — DASH test skipped'); process.exit(0); }
  let probeBin = ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  if (!fs.existsSync(probeBin)) probeBin = 'ffprobe';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-dash-'));
  const media = path.join(root, 'media');
  const run = (args) => execFileSync(ff, ['-loglevel', 'error', '-y', ...args]);
  fs.mkdirSync(media);
  const v = path.join(media, 'v.mp4'); const a = path.join(media, 'a.m4a');
  run(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '6', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-an', v]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', a]);
  const common = ['-i', v, '-i', a, '-map', '0:v', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-g', '25', '-b:v:0', '800k', '-s:v:0', '640x360', '-b:v:1', '300k', '-s:v:1', '320x180', '-c:a', 'aac', '-f', 'dash', '-seg_duration', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a'];
  for (const [dir, extra] of [['tpl', ['-use_template', '1', '-use_timeline', '1']], ['num', ['-use_template', '1', '-use_timeline', '0']], ['list', ['-use_template', '0', '-use_timeline', '0']], ['single', ['-single_file', '1']]]) {
    fs.mkdirSync(path.join(media, dir));
    run([...common, ...extra, path.join(media, dir, 'manifest.mpd')]);
  }
  // SegmentBase: ملف كامل لكل مسار
  fs.mkdirSync(path.join(media, 'base'));
  fs.copyFileSync(v, path.join(media, 'base', 'v.mp4')); fs.copyFileSync(a, path.join(media, 'base', 'a.m4a'));
  fs.writeFileSync(path.join(media, 'base', 'manifest.mpd'), `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S"><Period>
<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="500000" width="640" height="360"><BaseURL>v.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation></AdaptationSet>
<AdaptationSet mimeType="audio/mp4"><Representation id="a1" bandwidth="128000"><BaseURL>a.m4a</BaseURL></Representation></AdaptationSet></Period></MPD>`);
  // DRM sample
  fs.writeFileSync(path.join(media, 'drm.mpd'), `<MPD type="static" mediaPresentationDuration="PT6S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="1" bandwidth="1"><BaseURL>x.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`);

  const server = http.createServer((req, res) => {
    const f = path.join(media, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(media) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    const buf = fs.readFileSync(f);
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { const s = +m[1]; const e = m[2] ? +m[2] : buf.length - 1; res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${buf.length}`, 'Content-Length': e - s + 1 }); return res.end(buf.subarray(s, e + 1)); }
    res.writeHead(200, { 'Content-Length': buf.length }); res.end(buf);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const probe = (f) => {
    const out = execFileSync(probeBin, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]).toString();
    return JSON.parse(out);
  };

  for (const dir of ['tpl', 'num', 'list', 'single', 'base']) {
    const url = `${base}/${dir}/manifest.mpd`;
    const vars = await dashVariants(url, {}, 10000);
    const pick = vars[vars.length - 1];   // أقل جودة لإثبات اختيار الجودة
    const t = new DashTask({ _id: dir, url, fileName: `out-${dir}.mp4`, saveDir: root, kind: 'dash', hlsVariant: pick.url }, { connections: 4, ffmpeg: ff });
    const r = await new Promise((res, rej) => { t.on('complete', res); t.on('error', (e, m) => rej(new Error(m))); t.start(); });
    const p = probe(r.path);
    const types = p.streams.map(s => s.codec_type).sort().join('+');
    const vs = p.streams.find(s => s.codec_type === 'video');
    assert.strictEqual(types, 'audio+video', dir + ': ' + types);
    assert.ok(Math.abs(Number(p.format.duration) - 6) < 0.6, dir + ' duration ' + p.format.duration);
    assert.strictEqual(`${vs.width}x${vs.height}`, pick.resolution, dir + ' resolution');
    console.log(`  ✓ DASH ${dir.padEnd(6)} qualities: ${vars.map(x => x.resolution).join(', ')} → picked ${pick.resolution}, output ${types}, ${Number(p.format.duration).toFixed(1)}s`);
  }
  assert.throws(() => parseMpd(fs.readFileSync(path.join(media, 'drm.mpd'), 'utf8'), base + '/drm.mpd'), /DRM/);
  console.log('  ✓ DRM-protected manifest rejected with a clear message');
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nDASH tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
