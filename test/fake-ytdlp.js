#!/usr/bin/env node
'use strict';
/**
 * محاكي yt-dlp للاختبار فقط: يطبع نفس صيغ المخرجات التي يطلبها برق
 * (--progress-template / --print after_move / -J) ويتحقق من الخيارات المرسلة إليه.
 * لا يتصل بأي موقع. الملفات الناتجة تُنسخ من FAKE_MEDIA_DIR.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const url = argv[argv.indexOf('--') + 1] || argv[argv.length - 1];
const MEDIA = process.env.FAKE_MEDIA_DIR || '/tmp/media';
const log = (m) => fs.appendFileSync(process.env.FAKE_LOG || '/tmp/fake-ytdlp.log', m + '\n');

if (has('--version')) { console.log('2026.10.20'); process.exit(0); }
if (has('-U')) { console.log('Latest version: 2026.10.20 from yt-dlp/yt-dlp\nyt-dlp is up to date (2026.10.20 from yt-dlp/yt-dlp)'); process.exit(0); }

// تحقق: بيئة JavaScript (Node المدمج في Electron) تعمل ونسختها ≥ 22
const js = opt('--js-runtimes') || '';
if (!/^node:/.test(js)) { console.error('ERROR: test: missing --js-runtimes node:<path>'); process.exit(2); }
const nodeVer = execFileSync(js.slice(5), ['--version'], { env: process.env }).toString().trim();
if (Number(nodeVer.replace(/^v/, '').split('.')[0]) < 22) { console.error('ERROR: test: JS runtime too old ' + nodeVer); process.exit(2); }
log(`run ${has('-J') ? 'info' : 'download'} js=${nodeVer} electron_run_as_node=${process.env.ELECTRON_RUN_AS_NODE} cookies=${opt('--cookies') ? fs.readFileSync(opt('--cookies'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).length : 0} N=${opt('-N')} chunk=${opt('--http-chunk-size')} f=${opt('-f')}`);

if (/bot/.test(url)) { console.error("ERROR: [youtube] abc123: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."); process.exit(1); }
if (/private/.test(url)) { console.error('ERROR: [youtube] xyz: Private video. Sign in if you\'ve been granted access to this video'); process.exit(1); }

if (has('-J')) {
  if (/list=/.test(url) && !/[?&]v=/.test(url)) {
    console.log(JSON.stringify({ _type: 'playlist', title: 'قائمة تجريبية', extractor: 'youtube:tab', entries: [
      { id: 'aaa111', title: 'الحلقة 1', ie_key: 'Youtube', url: 'https://www.youtube.com/watch?v=aaa111' },
      { id: 'bbb222', title: 'الحلقة 2', ie_key: 'Youtube', url: 'https://www.youtube.com/watch?v=bbb222' },
      { id: 'ccc333', title: 'الحلقة 3', ie_key: 'Youtube', url: 'https://www.youtube.com/watch?v=ccc333' }] }));
  } else {
    const fmt = (id, h, v, a, tbr, size) => ({ format_id: id, height: h, vcodec: v, acodec: a, tbr, filesize: size, ext: v === 'none' ? 'm4a' : 'mp4', fps: 30 });
    console.log(JSON.stringify({ id: 'dQw4', title: process.env.FAKE_TITLE || 'فيديو تجريبي: شرح التقنية', thumbnail: process.env.FAKE_THUMB || 'https://i.ytimg.com/vi/x/hq.jpg', duration: Number(process.env.FAKE_DURATION || 6), uploader: process.env.FAKE_UPLOADER || 'Barq Test', extractor_key: 'Youtube',
      webpage_url: url, formats: [fmt('140', null, 'none', 'mp4a', 128, 96000), fmt('137', 1080, 'avc1', 'none', 4000, 3000000), fmt('136', 720, 'avc1', 'none', 2000, 1500000), fmt('18', 360, 'avc1', 'mp4a', 600, 450000)] }));
  }
  process.exit(0);
}

// وضع التنزيل
const out = opt('-o');
const tpl = opt('--progress-template');
const printTpl = opt('--print');
if (!tpl || !tpl.includes('%(progress.downloaded_bytes)s') || !printTpl || !printTpl.startsWith('after_move:')) { console.error('ERROR: test: wrong template args'); process.exit(2); }
if (!opt('--ffmpeg-location') || !fs.existsSync(opt('--ffmpeg-location'))) { console.error('ERROR: test: ffmpeg not passed'); process.exit(2); }
const audioOnly = /^ba/.test(opt('-f') || '');
const parts = audioOnly ? [['140', 'none', path.join(MEDIA, 'audio_only.m4a')]] : [['137', 'avc1', path.join(MEDIA, 'video_only.mp4')], ['140', 'none', path.join(MEDIA, 'audio_only.m4a')]];
const finalExt = audioOnly ? 'm4a' : 'mp4';
const finalPath = out.replace('%(ext)s', finalExt).replace(/%%/g, '%');
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
const SLOW = Number(process.env.FAKE_SLOW_MS || 60);

(async () => {
  for (const [fid, vcodec, src] of parts) {
    const total = fs.statSync(src).size;
    const part = finalPath + `.f${fid}.part`;
    let got = fs.existsSync(part) ? fs.readFileSync(part).length : 0;
    if (got >= total && fs.existsSync(part)) continue;
    const data = fs.readFileSync(src);
    const step = Math.ceil(total / 25);
    while (got < total) {
      if (stopped) process.exit(143);
      const n = Math.min(step, total - got);
      fs.appendFileSync(part, data.subarray(got, got + n));
      got += n;
      console.log(`[barq]downloading|${got}|${total}|NA|${(n * 1000 / SLOW).toFixed(1)}|${Math.ceil((total - got) / n * SLOW / 1000)}|${fid}|${vcodec}`);
      await new Promise(r => setTimeout(r, SLOW));
    }
    console.log(`[barq]finished|${total}|${total}|NA|NA|NA|${fid}|${vcodec}`);
  }
  // دمج حقيقي بـ FFmpeg مثل yt-dlp
  const ff = opt('--ffmpeg-location');
  if (audioOnly) fs.renameSync(finalPath + '.f140.part', finalPath);
  else {
    execFileSync(ff, ['-y', '-loglevel', 'error', '-i', finalPath + '.f137.part', '-i', finalPath + '.f140.part', '-c', 'copy', '-map', '0:v', '-map', '1:a', '-f', 'mp4', finalPath]);
    fs.rmSync(finalPath + '.f137.part'); fs.rmSync(finalPath + '.f140.part');
  }
  console.log('[barqfile]' + finalPath);
  process.exit(0);
})();
