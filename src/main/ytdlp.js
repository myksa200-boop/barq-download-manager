'use strict';
/**
 * تكامل yt-dlp — YouTube وأكثر من 1000 موقع (X، Instagram، TikTok، Facebook، Vimeo…)
 * ------------------------------------------------------------------------------------
 * - Components: يجلب yt-dlp وFFmpeg من مصادرهما الرسمية عند أول حاجة، ويحدّث yt-dlp تلقائياً.
 * - بيئة JavaScript المطلوبة لـ YouTube: نستخدم Node المدمج في Electron نفسه
 *   (ELECTRON_RUN_AS_NODE=1 + --js-runtimes node:<execPath>) فلا حاجة لتثبيت Deno/Node.
 * - تسريع: --concurrent-fragments لمقاطع HLS/DASH و--http-chunk-size لتجاوز تقييد السرعة لكل اتصال.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';
const YTDLP_ASSET = { win32: 'yt-dlp.exe', linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', darwin: 'yt-dlp_macos' }[process.platform];
const FFMPEG_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-${process.platform}-${process.arch}.gz`;

/** مواقع معروفة يعالجها yt-dlp (الروابط الأخرى تُجرَّب أيضاً عبر المستخرج العام) */
const YTDLP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|x\.com|twitter\.com|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|vimeo\.com|dailymotion\.com|dai\.ly|twitch\.tv|reddit\.com|redd\.it|soundcloud\.com|bilibili\.com|streamable\.com|ok\.ru|vk\.com|vkvideo\.ru|rumble\.com|kick\.com|threads\.net|pinterest\.com|linkedin\.com|9gag\.com|imgur\.com|bandcamp\.com|mixcloud\.com|ted\.com|aparat\.com|snapchat\.com|bitchute\.com|odysee\.com|nicovideo\.jp|weibo\.com|douyin\.com|likee\.video|tumblr\.com|vimeo\.com)$/i;
function isYtdlpUrl(url) { try { return YTDLP_HOSTS.test(new URL(url).hostname); } catch { return false; } }

/* ------------------------------------------------------------------ */
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Barq-Download-Manager' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 10) {
        res.resume(); return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class Components {
  constructor({ binDir, getSettings, saveSettings }) {
    this.binDir = binDir;
    this.getSettings = getSettings || (() => ({}));
    this.saveSettings = saveSettings || (() => {});
    this.pending = {};
    this.listeners = new Set();
  }
  get ytdlpPath() { return path.join(this.binDir, 'yt-dlp' + EXE); }
  get ffmpegLocal() { return path.join(this.binDir, 'ffmpeg' + EXE); }
  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(p) { for (const fn of this.listeners) { try { fn(p); } catch { /* ignore */ } } }

  async _download(name, url, dest, gunzip) {
    await fsp.mkdir(this.binDir, { recursive: true });
    const res = await httpsGet(url);
    const total = Number(res.headers['content-length'] || 0);
    let got = 0;
    res.on('data', (d) => { got += d.length; this._emit({ name, got, total }); });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest + '.download');
      (gunzip ? res.pipe(zlib.createGunzip()) : res).pipe(out);
      out.on('finish', resolve); out.on('error', reject); res.on('error', reject);
    });
    await fsp.rename(dest + '.download', dest);
    if (!EXE) await fsp.chmod(dest, 0o755);
    this._emit({ name, got: total, total, done: true });
  }

  /** yt-dlp: من الإعدادات أو مجلد البرنامج، وإلا يُنزَّل */
  async ensureYtdlp() {
    const custom = this.getSettings().ytdlpPath;
    if (custom && fs.existsSync(custom)) return custom;
    if (fs.existsSync(this.ytdlpPath)) return this.ytdlpPath;
    if (!YTDLP_ASSET) throw new Error('yt-dlp غير متاح لهذا النظام');
    this.pending.ytdlp = this.pending.ytdlp || this._download('yt-dlp', `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`, this.ytdlpPath, false)
      .then(() => { this.saveSettings({ ytdlpCheckedAt: Date.now() }); })
      .finally(() => { delete this.pending.ytdlp; });
    try { await this.pending.ytdlp; } catch (e) { throw new Error('تعذر تنزيل مكوّن yt-dlp: ' + e.message + ' — تحقق من اتصال الإنترنت'); }
    return this.ytdlpPath;
  }

  /** FFmpeg: الإعدادات ← مجلد البرنامج ← PATH ← تنزيل */
  async findFfmpeg() {
    const custom = this.getSettings().ffmpegPath;
    if (custom && fs.existsSync(custom)) return custom;
    if (fs.existsSync(this.ffmpegLocal)) return this.ffmpegLocal;
    return new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], (err, out) => resolve(err ? null : (String(out).split(/\r?\n/)[0].trim() || null)));
    });
  }
  async ensureFfmpeg() {
    const found = await this.findFfmpeg();
    if (found) return found;
    this.pending.ffmpeg = this.pending.ffmpeg || this._download('FFmpeg', FFMPEG_URL, this.ffmpegLocal, true).finally(() => { delete this.pending.ffmpeg; });
    try { await this.pending.ffmpeg; } catch (e) { throw new Error('تعذر تنزيل مكوّن FFmpeg: ' + e.message); }
    return this.ffmpegLocal;
  }

  version(bin) {
    return new Promise((resolve) => execFile(bin, ['--version'], { timeout: 30000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().split(/\r?\n/)[0])));
  }
  async status() {
    const y = fs.existsSync(this.ytdlpPath) ? this.ytdlpPath : (this.getSettings().ytdlpPath || null);
    const f = await this.findFfmpeg();
    return {
      ytdlp: y && fs.existsSync(y) ? { path: y, version: await this.version(y) } : null,
      ffmpeg: f ? { path: f } : null,
      jsRuntime: `Node ${process.versions.node} (${process.versions.electron ? 'Electron' : 'system'})`,
      checkedAt: this.getSettings().ytdlpCheckedAt || 0,
    };
  }
  /** تحديث yt-dlp (YouTube يتغير باستمرار) */
  async updateYtdlp() {
    const bin = await this.ensureYtdlp();
    const out = await new Promise((resolve) => execFile(bin, ['-U'], { timeout: 180000, windowsHide: true }, (err, so, se) => resolve(String(so || '') + String(se || '') + (err ? '\n' + err.message : ''))));
    this.saveSettings({ ytdlpCheckedAt: Date.now() });
    return out.trim();
  }
  autoUpdate() {
    const last = this.getSettings().ytdlpCheckedAt || 0;
    if (fs.existsSync(this.ytdlpPath) && Date.now() - last > 24 * 3600 * 1000) this.updateYtdlp().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
function baseEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}
function commonArgs(rec) {
  const a = ['--js-runtimes', `node:${process.execPath}`, '--no-colors', '--encoding', 'utf-8'];
  if (rec.referer) a.push('--referer', rec.referer);
  if (rec.userAgent) a.push('--user-agent', rec.userAgent);
  try {
    for (const [k, v] of Object.entries(JSON.parse(rec.headers || '{}'))) if (!/^(referer|user-agent|cookie|range|host)$/i.test(k)) a.push('--add-headers', `${k}:${v}`);
  } catch { /* ignore */ }
  return a;
}
/** ملف كوكيز بصيغة Netscape من سلسلة "a=1; b=2" القادمة من المتصفح */
async function writeCookies(rec, dir) {
  if (!rec.cookies) return null;
  let host = '';
  try { host = new URL(rec.url).hostname; } catch { return null; }
  const domain = '.' + host.replace(/^www\.|^m\.|^music\./, '');
  const lines = ['# Netscape HTTP Cookie File'];
  for (const part of rec.cookies.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    lines.push([domain, 'TRUE', '/', 'TRUE', '0', part.slice(0, i).trim(), part.slice(i + 1).trim()].join('\t'));
  }
  await fsp.mkdir(dir, { recursive: true });
  const f = path.join(dir, `cookies-${rec._id || Date.now()}.txt`);
  await fsp.writeFile(f, lines.join('\n') + '\n');
  return f;
}

function friendlyYtdlpError(text) {
  const t = String(text || '');
  if (/Sign in to confirm|not a bot/i.test(t)) return 'يطلب YouTube التحقق بتسجيل الدخول: افتح YouTube في متصفحك وأنت مسجّل الدخول، ثم أرسل الفيديو من إضافة برق (تُمرَّر الكوكيز تلقائياً)';
  if (/Private video|members-only|Join this channel/i.test(t)) return 'الفيديو خاص أو للأعضاء فقط';
  if (/age|inappropriate|confirm your age/i.test(t) && /sign in/i.test(t)) return 'الفيديو مقيد بالعمر: أرسله من الإضافة وأنت مسجّل الدخول في YouTube';
  if (/Video unavailable|not available|has been removed/i.test(t)) return 'الفيديو غير متاح أو محذوف';
  if (/DRM/i.test(t)) return 'هذا الفيديو محمي بنظام DRM ولا يمكن تنزيله';
  if (/Unsupported URL|No video formats found|Unable to extract/i.test(t)) return 'لم يتم العثور على فيديو قابل للتنزيل في هذه الصفحة';
  if (/HTTP Error 403/i.test(t)) return 'رفض الخادم الطلب (403). حدّث yt-dlp من الخيارات ← التنزيلات، ثم أعد المحاولة';
  if (/HTTP Error 429|Too Many Requests/i.test(t)) return 'طلبات كثيرة (429): انتظر قليلاً ثم أعد المحاولة';
  const m = t.match(/ERROR:\s*(?:\[[^\]]+\]\s*)?(?:[\w-]+:\s*)?(.+)/);
  return m ? m[1].trim().slice(0, 300) : (t.trim().split(/\r?\n/).pop() || 'فشل yt-dlp').slice(0, 300);
}

/** معلومات الفيديو أو قائمة التشغيل (yt-dlp -J) */
async function ytdlpInfo(components, rec, { timeout = 120000 } = {}) {
  const bin = await components.ensureYtdlp();
  const cookieFile = await writeCookies(rec, path.join(components.binDir, '..', 'tmp'));
  let u;
  try { u = new URL(rec.url); } catch { throw new Error('رابط غير صالح'); }
  const isList = u.searchParams.has('list') && !u.searchParams.has('v') || /\/playlist$/.test(u.pathname);
  const args = ['-J', ...(isList ? ['--flat-playlist'] : ['--no-playlist']), ...commonArgs(rec)];
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', rec.url);
  const out = await new Promise((resolve, reject) => {
    execFile(bin, args, { env: baseEnv(), maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (err, so, se) => {
      if (cookieFile) fs.rm(cookieFile, { force: true }, () => {});
      if (err) return reject(new Error(friendlyYtdlpError(se || err.message)));
      resolve(so);
    });
  });
  const j = JSON.parse(String(out));
  if (j._type === 'playlist') {
    const entries = (j.entries || []).filter(Boolean).map(e => ({
      url: e.url && /^https?:/.test(e.url) ? e.url : (e.webpage_url || (e.ie_key === 'Youtube' || /youtube/i.test(j.extractor || '') ? `https://www.youtube.com/watch?v=${e.id}` : e.url)),
      title: e.title || e.id, duration: e.duration || 0,
    })).filter(e => e.url);
    return { playlist: true, title: j.title || 'playlist', entries };
  }
  const formats = j.formats || [];
  const audio = formats.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none').sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
  const asz = audio ? (audio.filesize || audio.filesize_approx || 0) : 0;
  const byH = new Map();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    const sz = (f.filesize || f.filesize_approx || 0) + (f.acodec && f.acodec !== 'none' ? 0 : asz);
    const cur = byH.get(f.height);
    if (!cur || (f.tbr || 0) > cur.tbr) byH.set(f.height, { tbr: f.tbr || 0, size: sz, fps: f.fps || 0 });
  }
  const variants = [...byH.entries()].sort((a, b) => b[0] - a[0]).map(([h, v]) => ({ url: 'v:' + h, resolution: `${h}p${v.fps > 30 ? Math.round(v.fps) : ''}`, bandwidth: Math.round(v.tbr * 1000), size: v.size }));
  if (!variants.length && formats.length) variants.push({ url: 'best', resolution: 'best', bandwidth: 0, size: j.filesize_approx || 0 });
  if (audio || formats.some(f => f.acodec && f.acodec !== 'none')) {
    variants.push({ url: 'a:m4a', resolution: 'audio', label: 'M4A', bandwidth: audio ? Math.round((audio.tbr || 0) * 1000) : 0, size: asz });
    variants.push({ url: 'a:mp3', resolution: 'audio', label: 'MP3', bandwidth: 0, size: asz });
  }
  return { playlist: false, title: j.title || j.id || 'video', thumbnail: j.thumbnail || '', duration: j.duration || 0, uploader: j.uploader || j.channel || '', extractor: j.extractor_key || j.extractor || '', variants, webpageUrl: j.webpage_url || rec.url };
}

function formatArgs(variant, conns) {
  const v = String(variant || 'best');
  const sort = ['-S', 'res,ext:mp4:m4a'];
  if (v.startsWith('v:')) {
    const h = Number(v.slice(2)) || 1080;
    return ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`, ...sort, '--merge-output-format', 'mp4'];
  }
  if (v === 'a:m4a' || v === 'a:mp3') return ['-f', 'ba[ext=m4a]/ba/b'];
  return ['-f', 'bv*+ba/b', ...sort, '--merge-output-format', 'mp4'];
}

/* ------------------------------------------------------------------ */
function makeYtdlpTask(BaseTask, { friendlyError }) {
  return class YtdlpTask extends BaseTask {
    constructor(rec, opts) {
      super(rec, opts);
      this.components = opts.components;
      this.resumable = true;
      this.parts = new Map();   // format_id -> {downloaded,total,status}
      this.phase = '';
    }
    snapshot() {
      return {
        id: this.id, downloaded: this.downloaded, size: this.size, speed: this.speed, eta: this.eta(), resumable: true, ytdlp: true,
        segments: [], phase: this.phase,
        conns: [{ n: 1, bytes: this.downloaded, info: this.info || 'connecting', start: 0 }],
      };
    }
    _killTree() {
      const p = this.proc;
      if (!p || p.exitCode !== null) return;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch { /* ignore */ } } }
    }
    async start() {
      this.running = true;
      this.paused = false;
      this.emit('status', 'connecting');
      this.info = 'preparing';
      let bin; let ffmpeg; let cookieFile;
      const off = this.components.onProgress((p) => { this.info = `preparing:${p.name}:${p.total ? Math.round((p.got / p.total) * 100) : 0}`; this.emit('progress', this.snapshot()); });
      try {
        bin = await this.components.ensureYtdlp();
        ffmpeg = await this.components.ensureFfmpeg();
        cookieFile = await writeCookies(this.rec, path.join(this.components.binDir, '..', 'tmp'));
      } catch (e) {
        off(); this.running = false; this.emit('error', e, e.message); return;
      } finally { off(); }
      if (!this.running) return;
      await fsp.mkdir(this.rec.saveDir, { recursive: true }).catch(() => {});
      const base = this.rec.fileName.replace(/\.[^.\\/]{1,5}$/, '').replace(/%/g, '%%');
      const variant = this.rec.hlsVariant || 'best';
      const args = [
        ...formatArgs(variant, this.conns),
        '--no-playlist', '--newline', '--progress', '--continue', '--no-mtime', '--windows-filenames',
        '--progress-template', 'download:[barq]%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(info.vcodec)s',
        '--print', 'after_move:[barqfile]%(filepath)s',
        '-o', path.join(this.rec.saveDir, base + '.%(ext)s'),
        '--ffmpeg-location', ffmpeg,
        '-N', String(Math.min(16, Math.max(4, this.conns))),
        '--http-chunk-size', '10M',
        '--retries', String(Math.max(3, this.retries)), '--fragment-retries', String(Math.max(3, this.retries)),
        ...commonArgs(this.rec),
      ];
      if (this.rec.speedLimit > 0) args.push('-r', `${this.rec.speedLimit}K`);
      if (cookieFile) args.push('--cookies', cookieFile);
      args.push('--', this.rec.url);

      this.emit('meta', { size: -1, resumable: true, finalUrl: this.rec.url, mime: 'video/mp4' });
      this.emit('status', 'downloading');
      this.info = 'receiving';
      this._startTicker();
      let stderr = '';
      let finalPath = null;
      this.proc = spawn(bin, args, { env: baseEnv(), windowsHide: true, detached: process.platform !== 'win32' });
      const onLine = (line) => {
        if (line.startsWith('[barqfile]')) { finalPath = line.slice(10).trim(); return; }
        if (!line.startsWith('[barq]')) return;
        const [status, dl, total, est, , , fid, vcodec] = line.slice(6).split('|');
        const num = (x) => (x && x !== 'NA' && x !== 'None' ? Number(x) : NaN);
        const p = this.parts.get(fid) || { downloaded: 0, total: 0, status: '' };
        if (isFinite(num(dl))) p.downloaded = num(dl);
        const tt = isFinite(num(total)) ? num(total) : num(est);
        if (isFinite(tt)) p.total = Math.max(tt, p.downloaded);
        p.status = status;
        this.parts.set(fid, p);
        this.phase = vcodec && vcodec !== 'none' && vcodec !== 'NA' ? 'video' : 'audio';
        let d = 0; let s = 0;
        for (const x of this.parts.values()) { d += x.downloaded; s += x.total || x.downloaded; }
        this.downloaded = d; this.size = s || -1;
        if (status === 'finished' && [...this.parts.values()].every(x => x.status === 'finished') && this._expectParts() <= this.parts.size) {
          this.info = 'merging'; this.emit('status', 'merging');
        }
      };
      let buf = '';
      this.proc.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.search(/\r?\n/)) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1).replace(/^\n/, ''); } });
      this.proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
      this.proc.on('error', (e) => { stderr += '\nERROR: ' + e.message; });
      this.proc.on('close', async (code) => {
        if (buf) onLine(buf);
        if (cookieFile) fs.rm(cookieFile, { force: true }, () => {});
        this._stopTicker();
        const wasRunning = this.running;
        this.running = false;
        if (this.paused) { this.speed = 0; this.emit('paused', this.snapshot()); return; }
        if (code !== 0 || !wasRunning) { const msg = friendlyYtdlpError(stderr); this.emit('error', new Error(msg), msg); return; }
        try {
          if (!finalPath || !fs.existsSync(finalPath)) throw new Error('لم يُعثر على الملف الناتج');
          if (variant === 'a:mp3' && !/\.mp3$/i.test(finalPath)) {
            const mp3 = finalPath.replace(/\.[^.\\/]+$/, '') + '.mp3';
            this.emit('status', 'merging');
            await new Promise((res, rej) => {
              const p = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-i', finalPath, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', mp3], { windowsHide: true });
              let e = ''; p.stderr.on('data', d => { e += d; });
              p.on('close', c => (c === 0 ? res() : rej(new Error('FFmpeg: ' + e.slice(-300)))));
            });
            await fsp.rm(finalPath, { force: true });
            finalPath = mp3;
          }
          const st = await fsp.stat(finalPath);
          this.size = this.downloaded = st.size; this.speed = 0;
          this.emit('progress', this.snapshot());
          this.emit('complete', { path: finalPath, size: st.size, fileName: path.basename(finalPath) });
        } catch (e) { this.emit('error', e, friendlyError(e)); }
      });
    }
    _expectParts() { const v = String(this.rec.hlsVariant || 'best'); return v.startsWith('a:') ? 1 : 2; }
    async pause() {
      if (!this.running) return;
      this.paused = true;
      await new Promise((resolve) => {
        if (!this.proc || this.proc.exitCode !== null) { this.running = false; this._stopTicker(); this.emit('paused', this.snapshot()); return resolve(); }
        this.once('paused', resolve);
        this._killTree();
      });
    }
  };
}

module.exports = { Components, ytdlpInfo, makeYtdlpTask, isYtdlpUrl, friendlyYtdlpError, formatArgs, writeCookies };
