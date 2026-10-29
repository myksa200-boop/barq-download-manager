'use strict';
/**
 * محرك التنزيل — التقطيع الديناميكي (Dynamic File Segmentation)
 * ---------------------------------------------------------------
 * 1) طلب استكشافي بـ Range: bytes=0- لمعرفة الحجم ودعم الاستئناف (206).
 * 2) تقسيم الملف إلى N قطعة، لكل قطعة اتصال يكتب مباشرة في موضعه داخل ملف .part
 *    (لا حاجة لدمج أجزاء في النهاية).
 * 3) حين ينهي اتصالٌ قطعته، تُقسم أكبر قطعة متبقية لدى أبطأ اتصال إلى نصفين
 *    ويأخذ الاتصال الحر النصف الثاني عبر Range: bytes=x-y جديد.
 * 4) مواضع البايتات (segments) تُحفظ في Realm فيستأنف التنزيل بعد الإيقاف أو إغلاق البرنامج.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request, fetchBuffer, HttpError } = require('./net');
const { fileNameFromDisposition, fileNameFromUrl, sleep } = require('./utils');

const MIN_SEG = 256 * 1024;          // أصغر قطعة يُسمح بتقسيمها
const TICK_MS = 500;

/* ------------------------------------------------------------------ */
class Limiter {
  constructor(kbps = 0) { this.set(kbps); }
  set(kbps) { this.bps = Math.max(0, Number(kbps) || 0) * 1024; this.tokens = this.bps; this.last = Date.now(); }
  take(n) {
    if (!this.bps) return Promise.resolve();
    const now = Date.now();
    this.tokens = Math.min(this.bps, this.tokens + ((now - this.last) * this.bps) / 1000);
    this.last = now;
    this.tokens -= n;
    if (this.tokens >= 0) return Promise.resolve();
    return sleep((-this.tokens * 1000) / this.bps);
  }
}

/* ------------------------------------------------------------------ */
async function probe(url, headers = {}, timeout = 30000) {
  let { res, url: finalUrl } = await request(url, { headers: { ...headers, Range: 'bytes=0-' }, timeout });
  if (res.statusCode === 416) {
    res.destroy();
    ({ res, url: finalUrl } = await request(url, { headers, timeout }));
  }
  try {
    if (res.statusCode >= 400) throw new HttpError(res.statusCode);
    let size = -1;
    let resumable = false;
    if (res.statusCode === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
      if (m) { size = Number(m[1]); resumable = true; }
    } else if (res.headers['content-length'] !== undefined) {
      size = Number(res.headers['content-length']);
    }
    const mime = String(res.headers['content-type'] || '').split(';')[0].trim();
    const fileName = fileNameFromDisposition(res.headers['content-disposition']) || fileNameFromUrl(finalUrl, mime);
    return {
      size, resumable: resumable && size > 0, finalUrl, mime, fileName,
      etag: res.headers.etag || '', lastModified: res.headers['last-modified'] || '', status: res.statusCode,
    };
  } finally { res.destroy(); }
}

/** يتحقق من المساحة الحرة قبل حجز الملف على القرص */
async function checkSpace(dir, needed) {
  if (!(needed > 0) || typeof fsp.statfs !== 'function') return;
  let free;
  try { const st = await fsp.statfs(dir); free = st.bavail * st.bsize; } catch { return; }
  if (free < needed + 16 * 1024 * 1024) {
    throw Object.assign(new Error(`ENOSPC: need ${needed}, free ${free}`), { code: 'ENOSPC' });
  }
}

function buildHeaders(rec, auth) {
  const h = {};
  if (rec.referer) h.Referer = rec.referer;
  if (rec.cookies) h.Cookie = rec.cookies;
  if (rec.userAgent) h['User-Agent'] = rec.userAgent;
  if (auth) h.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
  try { Object.assign(h, JSON.parse(rec.headers || '{}')); } catch { /* ignore */ }
  return h;
}

function friendlyError(e) {
  if (e instanceof HttpError) {
    const map = {
      401: 'HTTP 401 — يتطلب الخادم تسجيل دخول (أضف بيانات الموقع في الخيارات)',
      403: 'HTTP 403 Forbidden — الرابط منتهي الصلاحية أو محمي. حدّث الرابط من الخصائص',
      404: 'HTTP 404 — الملف غير موجود على الخادم',
      410: 'HTTP 410 — الملف لم يعد متاحاً',
      416: 'HTTP 416 — نطاق غير صالح',
    };
    return map[e.status] || `HTTP ${e.status} — خطأ من الخادم`;
  }
  if (e.code === 'ENOTFOUND') return 'تعذر العثور على الخادم (DNS)';
  if (e.code === 'ECONNREFUSED') return 'رفض الخادم الاتصال';
  if (e.code === 'ETIMEDOUT') return 'انتهت مهلة الاتصال';
  if (e.code === 'ENOSPC') return 'لا توجد مساحة كافية على القرص لحفظ هذا الملف';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'لا توجد صلاحية للكتابة في مجلد الحفظ';
  return e.message || String(e);
}

/* ------------------------------------------------------------------ */
class BaseTask extends EventEmitter {
  constructor(rec, opts = {}) {
    super();
    this.rec = rec;
    this.id = rec._id;
    this.conns = Math.max(1, Math.min(32, opts.connections || 8));
    this.retries = opts.retries ?? 5;
    this.timeout = (opts.timeout || 30) * 1000;
    this.limiters = opts.limiters || [];
    this.own = new Limiter(rec.speedLimit || 0);
    this.auth = opts.auth || null;
    this.running = false;
    this.downloaded = 0;
    this.size = rec.size;
    this.speed = 0;
    this.workers = [];
    this.lastError = null;
    this._samples = [];
  }
  setSpeedLimit(kbps) { this.own.set(kbps); }
  async throttle(n) { await this.own.take(n); for (const l of this.limiters) await l.take(n); }
  _startTicker() {
    this._lastBytes = this.downloaded;
    this._lastT = Date.now();
    this._ticker = setInterval(() => this._tick(), TICK_MS);
  }
  _stopTicker() { clearInterval(this._ticker); this._ticker = null; }
  _tick() {
    const now = Date.now();
    const inst = ((this.downloaded - this._lastBytes) * 1000) / Math.max(1, now - this._lastT);
    this._lastBytes = this.downloaded; this._lastT = now;
    this._samples.push(inst);
    if (this._samples.length > 8) this._samples.shift();
    this.speed = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    this.emit('progress', this.snapshot());
  }
  eta() { return this.size > 0 && this.speed > 1 ? Math.max(0, (this.size - this.downloaded) / this.speed) : -1; }
}

/* ------------------------------------------------------------------ */
class HttpTask extends BaseTask {
  constructor(rec, opts) {
    super(rec, opts);
    this.segments = (rec.segments || []).map(s => ({ ...s }));
    this.finalPath = path.join(rec.saveDir, rec.fileName);
    this.partPath = this.finalPath + '.part';
    // التسريع: عدد اتصالات متكيّف يبدأ بـ 4 ويزيد ما دامت السرعة الكلية تتحسن
    this.maxConns = this.conns;
    this.cap = Math.min(this.maxConns, opts.adaptive === false ? this.maxConns : 6);
    this.adaptive = opts.adaptive !== false;
    this.slowRestart = opts.slowRestart !== false;
    this.endgame = opts.endgame !== false;
    this.stats = { restarts: 0, rampUps: 0, serverLimited: 0, mirrors: 0 };
  }

  snapshot() {
    return {
      id: this.id, downloaded: this.downloaded, size: this.size, speed: this.speed, eta: this.eta(),
      resumable: this.resumable, segments: this.segments.map(s => ({ ...s })),
      conns: this.workers.map(w => ({ n: w.n, bytes: w.bytes, info: w.info, start: w.seg.start, host: w.host || '' })),
      cap: this.cap, stats: this.stats,
    };
  }

  headers() { return buildHeaders(this.rec, this.auth); }

  /** مصادر إضافية (Mirrors) لنفس الملف: تُقبل فقط إذا طابق الحجم ودعمت الاستئناف */
  async _probeMirrors(size) {
    const list = String(this.rec.mirrors || '').split(/\s+/).filter(u => /^https?:\/\//i.test(u) && u !== this.rec.url);
    if (!list.length || !(size > 0)) return;
    const ok = await Promise.all(list.map(u => probe(u, this.headers(), Math.min(this.timeout, 15000)).then(m => (m.resumable && m.size === size ? m.finalUrl : null)).catch(() => null)));
    for (const u of ok) if (u && !this.urls.includes(u)) this.urls.push(u);
    this.stats.mirrors = this.urls.length - 1;
  }

  async start() {
    this.running = true;
    this.abort = new AbortController();
    this.emit('status', 'connecting');
    let meta;
    try {
      meta = await probe(this.rec.url, this.headers(), this.timeout);
    } catch (e) {
      this.running = false;
      this.emit('error', e, friendlyError(e));
      return;
    }
    if (!this.running) return;
    this.url = meta.finalUrl;
    this.urls = [meta.finalUrl];
    this.resumable = meta.resumable;
    if (this.resumable) await this._probeMirrors(meta.size);
    if (!this.running) return;
    // الملف تغيّر على الخادم؟ ابدأ من الصفر
    const changed = this.rec.size > 0 && (meta.size !== this.rec.size || (this.rec.etag && meta.etag && this.rec.etag !== meta.etag));
    if (changed || !this.resumable) this.segments = [];
    this.size = meta.size;
    this.emit('meta', { size: meta.size, resumable: meta.resumable, finalUrl: meta.finalUrl, mime: meta.mime, etag: meta.etag });

    try {
      await fsp.mkdir(this.rec.saveDir, { recursive: true });
      const exists = fs.existsSync(this.partPath);
      await checkSpace(this.rec.saveDir, this.size - (exists ? this.segments.reduce((a, x) => a + (x.pos - x.start), 0) : 0));
      if (this.resumable) {
        let reuse = exists && this.segments.length > 0;
        if (reuse) { const st = await fsp.stat(this.partPath); if (st.size !== this.size) reuse = false; }
        if (!reuse) this.segments = this._initialSegments();
        this.fh = await fsp.open(this.partPath, reuse ? 'r+' : 'w');
        if (!reuse) await this.fh.truncate(this.size);
      } else {
        this.segments = [];
        this.fh = await fsp.open(this.partPath, 'w');
      }
    } catch (e) {
      this.running = false;
      this.emit('error', e, friendlyError(e));
      return;
    }
    this.downloaded = this.segments.reduce((a, s) => a + (s.pos - s.start), 0);
    this.emit('status', 'downloading');
    this._startTicker();
    this._done = new Promise(r => { this._resolveDone = r; });
    if (this.resumable) this._fill();
    else this._spawn({ start: 0, end: this.size > 0 ? this.size - 1 : Number.MAX_SAFE_INTEGER, pos: 0 }, true);
    if (this.resumable && this.segments.every(s => s.pos > s.end)) this._finish();
  }

  _initialSegments() {
    const n = Math.max(1, Math.min(this.cap, Math.floor(this.size / MIN_SEG) || 1));
    const base = Math.floor(this.size / n);
    const segs = [];
    for (let i = 0; i < n; i++) {
      const start = i * base;
      const end = i === n - 1 ? this.size - 1 : start + base - 1;
      segs.push({ start, end, pos: start });
    }
    return segs;
  }

  _alive() { return this.workers.filter(w => w.alive); }

  _fill() {
    while (this.running && this._alive().length < this.cap) {
      const busy = new Set(this._alive().map(w => w.seg));
      let seg = this.segments.find(s => s.pos <= s.end && !busy.has(s));
      if (!seg) seg = this._split(busy);
      if (!seg) break;
      this._spawn(seg, false);
    }
  }

  /** يقسم أكبر جزء متبقٍّ لدى اتصال نشط إلى نصفين */
  _split(busy) {
    let best = null;
    const at = (s) => (s.recv != null ? s.recv : s.pos);
    for (const s of busy) {
      const rem = s.end - at(s) + 1;
      if (rem >= 2 * MIN_SEG && (!best || rem > best.end - at(best) + 1)) best = s;
    }
    if (!best && this.endgame) {
      // نهاية التنزيل: اقسم حتى القطع الصغيرة إذا كان اتصالها بطيئاً (سيتأخر أكثر من ثانيتين)
      const rateOf = (s) => (this.workers.find(w => w.alive && w.seg === s) || {}).rate || 0;
      for (const s of busy) {
        const rem = s.end - at(s) + 1;
        if (rem >= 64 * 1024 && rem / Math.max(rateOf(s), 1) > 1 && (!best || rem > best.end - at(best) + 1)) best = s;
      }
      if (best) this.stats.endgame = (this.stats.endgame || 0) + 1;
    }
    if (!best) return null;
    const rem = best.end - at(best) + 1;
    const mid = at(best) + Math.floor(rem / 2);
    const seg = { start: mid, end: best.end, pos: mid };
    best.end = mid - 1;
    const idx = this.segments.indexOf(best);
    this.segments.splice(idx + 1, 0, seg);
    return seg;
  }

  _spawn(seg, single) {
    const used = new Set(this._alive().map(w => w.n));
    let n = 1; while (used.has(n)) n++;
    // أعد استخدام سطر الاتصال القديم في الجدول بدل إضافة أسطر لا نهائية
    const old = this.workers.findIndex(w => !w.alive && w.n === n);
    const w = { n, seg, bytes: 0, info: 'connecting', alive: true, req: null, restarts: 0, rate: 0, lastBytes: 0, recvSince: 0 };
    if (old >= 0) this.workers[old] = w; else this.workers.push(w);
    this.workers.sort((a, b) => a.n - b.n);
    w.promise = (single ? this._runSingle(w) : this._runRanged(w)).finally(() => this._onExit(w));
  }

  async _runRanged(w) {
    let attempt = 0;
    const FLUSH = 512 * 1024;           // كتابة مجمّعة: أقل عمليات قرص عند السرعات العالية
    while (this.running && w.seg.pos <= w.seg.end) {
      const urlIdx = (w.n - 1) % this.urls.length;
      const url = this.urls[urlIdx];
      try { w.host = new URL(url).hostname; } catch { w.host = ''; }
      let pend = []; let pendLen = 0;
      const flush = async () => {
        if (!pendLen) return;
        const b = pend.length === 1 ? pend[0] : Buffer.concat(pend, pendLen);
        pend = []; pendLen = 0;
        const room = w.seg.end - w.seg.pos + 1;
        const n = Math.max(0, Math.min(b.length, room));
        if (n < b.length) { const drop = b.length - n; this.downloaded -= drop; w.bytes -= drop; }   // تجاوز حدّ القطعة بعد إعادة التقسيم
        if (n > 0) await this.fh.write(b, 0, n, w.seg.pos);
        w.seg.pos += n;
        w.seg.recv = w.seg.pos;
      };
      try {
        w.info = 'connecting';
        w.restartFlag = false;
        const { res, req } = await request(url, {
          headers: { ...this.headers(), Range: `bytes=${w.seg.pos}-${w.seg.end}` }, timeout: this.timeout, signal: this.abort.signal,
        });
        w.req = req;
        if (res.statusCode >= 400) { res.resume(); throw new HttpError(res.statusCode); }
        if (res.statusCode !== 206) { res.destroy(); throw Object.assign(new Error('الخادم تجاهل طلب النطاق'), { code: 'NORANGE' }); }
        w.info = 'receiving';
        w.recvSince = Date.now(); w.lastBytes = w.bytes; w.rate = 0;
        try {
          for await (const chunk of res) {
            if (!this.running) break;
            const remain = w.seg.end - (w.seg.pos + pendLen) + 1;
            if (remain <= 0) break;
            const buf = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
            await this.throttle(buf.length);
            if (!this.running) { pend.push(buf); pendLen += buf.length; break; }
            pend.push(buf); pendLen += buf.length;
            w.seg.recv = w.seg.pos + pendLen;
            w.bytes += buf.length; this.downloaded += buf.length;
            attempt = 0;
            if (pendLen >= FLUSH) await flush();
            if (w.seg.pos + pendLen > w.seg.end) break;
          }
        } finally {
          await flush().catch(() => {});
          res.destroy();
        }
        if (this.running && w.seg.pos <= w.seg.end) throw Object.assign(new Error('انقطع الاتصال قبل اكتمال الجزء'), { code: 'ECONNRESET' });
      } catch (e) {
        await flush().catch(() => {});
        if (!this.running || (e.code === 'ABORTED' && !w.restartFlag)) break;
        if (w.restartFlag) { w.restarts++; this.stats.restarts++; continue; }   // اتصال بطيء: أعد فتحه فوراً
        // مصدر إضافي (Mirror) فشل: أزله وتابع من المصدر الرئيسي
        if (urlIdx > 0 && this.urls.length > 1) { this.urls.splice(urlIdx, 1); this.stats.mirrors = this.urls.length - 1; continue; }
        if (e instanceof HttpError && [401, 403, 404, 410].includes(e.status)) { this._fatal(e); break; }
        // الخادم يحدّ عدد الاتصالات (429/503 أو رفض): قلّل العدد بدل الفشل
        if ((e instanceof HttpError && [429, 503].includes(e.status)) || e.code === 'ECONNREFUSED') {
          const working = this._alive().filter(x => x !== w && x.info === 'receiving').length;
          if (working >= 1) {
            this.cap = Math.max(1, working);
            this.saturatedAt = Date.now();
            this.stats.serverLimited++;
            w.info = 'limited';
            break;
          }
        }
        if (++attempt > this.retries) { w.info = 'error'; w.failed = true; this.lastError = e; break; }
        w.info = 'retry:' + attempt;
        await sleep(Math.min(8000, 800 * attempt));
      }
    }
  }

  /** يُستدعى كل نصف ثانية: زيادة الاتصالات تدريجياً + استبدال الاتصال البطيء */
  _tick() {
    super._tick();
    if (!this.running || !this.resumable) return;
    const now = Date.now();
    const alive = this._alive();
    for (const w of alive) {
      const inst = (w.bytes - w.lastBytes) * 2;   // بايت/ث (نافذة 500ms)
      w.lastBytes = w.bytes;
      w.rate = w.rate ? w.rate * 0.7 + inst * 0.3 : inst;
    }
    // 1) زيادة تدريجية للاتصالات ما دامت السرعة تتحسن
    if (this.adaptive && this.cap < this.maxConns && alive.length >= this.cap) {
      if (!this._rampAt) { this._rampAt = now; this._rampSpeed = 0; }
      const sinceSat = this.saturatedAt ? now - this.saturatedAt : Infinity;
      if (now - this._rampAt >= 1000 && sinceSat > 8000) {
        if (this.speed > this._rampSpeed * 1.05) {
          const big = this._rampSpeed && this.speed > this._rampSpeed * 1.25;
          this._rampSpeed = this.speed;
          this.cap = Math.min(this.maxConns, this.cap + (big || !this.stats.rampUps ? 4 : 2));
          this.stats.rampUps++;
          this._fill();
        } else {
          this.saturatedAt = now;   // لا تحسّن: ثبّت العدد الحالي، وجرّب مجدداً بعد 15 ثانية
        }
        this._rampAt = now;
      }
    }
    // 2) اتصال أبطأ بكثير من أفضل اتصال لهذا الخادم: أعد فتحه (غالباً يصل لعقدة أسرع في الـ CDN)
    const best = Math.max(0, ...alive.map(w => w.rate));
    this.refRate = Math.max(best, (this.refRate || 0) * 0.97);
    if (this.slowRestart && this.refRate > 64 * 1024) {
      for (const w of alive) {
        if (w.info !== 'receiving' || now - w.recvSince < 1500 || !w.req || w.restarts >= 3) continue;
        const left = w.seg.end - (w.seg.recv ?? w.seg.pos);
        if (w.rate < this.refRate * 0.25 && left > 64 * 1024 && left / Math.max(w.rate, 1) > 1.5) {
          w.restartFlag = true;
          w.info = 'connecting';
          w.req.destroy(Object.assign(new Error('slow connection restart'), { code: 'SLOW' }));
          break;   // واحد في كل مرة
        }
      }
    }
  }

  /** خادم لا يدعم الاستئناف: اتصال واحد من البداية */
  async _runSingle(w) {
    let attempt = 0;
    while (this.running) {
      try {
        w.info = 'connecting';
        const { res, req } = await request(this.url, { headers: this.headers(), timeout: this.timeout, signal: this.abort.signal });
        w.req = req;
        if (res.statusCode >= 400) { res.resume(); throw new HttpError(res.statusCode); }
        if (attempt > 0) { await this.fh.truncate(0); this.downloaded = 0; w.seg.pos = 0; w.bytes = 0; }
        w.info = 'receiving';
        try {
          for await (const chunk of res) {
            if (!this.running) break;
            await this.throttle(chunk.length);
            await this.fh.write(chunk, 0, chunk.length, w.seg.pos);
            w.seg.pos += chunk.length; w.bytes += chunk.length; this.downloaded += chunk.length;
          }
        } finally { res.destroy(); }
        if (!this.running) break;
        if (this.size > 0 && this.downloaded < this.size) throw Object.assign(new Error('انقطع الاتصال'), { code: 'ECONNRESET' });
        if (this.size <= 0) this.size = this.downloaded;
        w.seg.end = w.seg.pos - 1;
        w.complete = true;
        break;
      } catch (e) {
        if (!this.running || e.code === 'ABORTED') break;
        if (e instanceof HttpError && [401, 403, 404, 410].includes(e.status)) { this._fatal(e); break; }
        if (++attempt > this.retries) { w.info = 'error'; w.failed = true; this.lastError = e; break; }
        w.info = 'retry:' + attempt;
        await sleep(Math.min(8000, 800 * attempt));
      }
    }
  }

  _onExit(w) {
    w.alive = false;
    w.req = null;
    if (w.seg.pos > w.seg.end || w.complete) w.info = 'done';
    if (!this.running) { if (!this._alive().length) this._resolveDone?.(); return; }
    if (!this.resumable) {
      if (w.complete) this._finish(); else this._failAll(this.lastError || new Error('Download failed'));
      return;
    }
    if (this.segments.every(s => s.pos > s.end)) { if (!this._alive().length) this._finish(); return; }
    this._fill();
    if (!this._alive().length) this._failAll(this.lastError || new Error('Download failed'));
  }

  _fatal(e) { this._failAll(e); }

  async _failAll(e) {
    if (!this.running) return;
    await this._halt();
    this.emit('error', e, friendlyError(e));
  }

  async _halt() {
    this.running = false;
    this._stopTicker();
    this.abort?.abort();
    await Promise.allSettled(this.workers.map(w => w.promise));
    if (this.fh) { try { await this.fh.close(); } catch { /* ignore */ } this.fh = null; }
  }

  async _finish() {
    if (this._finishing) return;
    this._finishing = true;
    this.running = false;
    this._stopTicker();
    try {
      if (this.fh) { await this.fh.close(); this.fh = null; }
      if (fs.existsSync(this.finalPath)) await fsp.rm(this.finalPath, { force: true });
      await fsp.rename(this.partPath, this.finalPath);
      this.downloaded = this.size > 0 ? this.size : this.downloaded;
      this.speed = 0;
      this.emit('progress', this.snapshot());
      this.emit('complete', { path: this.finalPath, size: this.downloaded });
    } catch (e) {
      this.emit('error', e, friendlyError(e));
    }
  }

  async pause() {
    if (!this.running) return;
    await this._halt();
    this.speed = 0;
    this.emit('paused', this.snapshot());
  }
}

/* ------------------------------------------------------------------ */
/* HLS (m3u8) — يدعم القوائم الرئيسية واختيار الجودة وتشفير AES-128     */
function parseM3u8(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('ليس ملف M3U8 صالحاً');
  const attrs = (s) => {
    const o = {};
    s.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, k, v) => { o[k] = v.replace(/^"|"$/g, ''); return ''; });
    return o;
  };
  const abs = (u) => new URL(u, base).toString();
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(lines[i].slice(18));
        let j = i + 1; while (j < lines.length && lines[j].startsWith('#')) j++;
        if (lines[j]) variants.push({ url: abs(lines[j]), bandwidth: Number(a.BANDWIDTH || 0), resolution: a.RESOLUTION || '', codecs: a.CODECS || '' });
      }
    }
    variants.sort((x, y) => y.bandwidth - x.bandwidth);
    return { master: true, variants };
  }
  const segs = [];
  let seq = 0; let key = null; let map = null; let dur = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? abs(a.URI) : '', iv: a.IV || '' };
    } else if (l.startsWith('#EXT-X-MAP:')) { const a = attrs(l.slice(11)); map = abs(a.URI); }
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (!l.startsWith('#')) { segs.push({ url: abs(l), seq: seq + segs.length, key, duration: dur }); dur = 0; }
  }
  return { master: false, segments: segs, map };
}

async function hlsVariants(url, headers = {}, timeout = 30000) {
  const text = (await fetchBuffer(url, { headers, timeout })).toString('utf8');
  const p = parseM3u8(text, url);
  return p.master ? p.variants : [];
}

class HlsTask extends BaseTask {
  constructor(rec, opts) {
    super(rec, opts);
    this.finalPath = path.join(rec.saveDir, rec.fileName);
    this.partDir = this.finalPath + '.parts';
    this.ffmpeg = opts.ffmpeg || null;
    this.toMp4 = opts.hlsToMp4 !== false;
    this.resumable = true;
    this.segments = [];
  }
  headers() { return buildHeaders(this.rec, this.auth); }
  snapshot() {
    return {
      id: this.id, downloaded: this.downloaded, size: this.size, speed: this.speed, eta: this.eta(), resumable: true, hls: true,
      segments: this.segments, conns: this.workers.map(w => ({ n: w.n, bytes: w.bytes, info: w.info, start: 0 })),
      hlsDone: this.doneCount || 0, hlsTotal: this.list ? this.list.length : 0, hlsMap: this.segMap || [],
    };
  }
  async start() {
    this.running = true;
    this.abort = new AbortController();
    this.emit('status', 'connecting');
    try {
      let url = this.rec.url;
      let p = parseM3u8((await fetchBuffer(url, { headers: this.headers(), timeout: this.timeout })).toString('utf8'), url);
      if (p.master) {
        const v = p.variants.find(x => x.url === this.rec.hlsVariant) || p.variants[0];
        if (!v) throw new Error('لا توجد جودات في القائمة');
        url = v.url;
        p = parseM3u8((await fetchBuffer(url, { headers: this.headers(), timeout: this.timeout })).toString('utf8'), url);
      }
      this.list = p.segments;
      this.map = p.map;
      if (!this.list.length) throw new Error('القائمة لا تحتوي على مقاطع');
      await fsp.mkdir(this.partDir, { recursive: true });
    } catch (e) {
      this.running = false;
      this.emit('error', e, friendlyError(e));
      return;
    }
    if (!this.running) return;
    this.emit('meta', { size: -1, resumable: true, finalUrl: this.rec.url, mime: 'video/mp2t' });
    // ما اكتمل مسبقاً (استئناف)
    this.done = new Array(this.list.length).fill(false);
    this.downloaded = 0;
    for (let i = 0; i < this.list.length; i++) {
      const f = path.join(this.partDir, `${i}.seg`);
      if (fs.existsSync(f)) { this.done[i] = true; this.downloaded += fs.statSync(f).size; }
    }
    this.doneCount = this.done.filter(Boolean).length;
    this._syncSegs();
    this.next = 0;
    this.keys = new Map();
    this.emit('status', 'downloading');
    this._startTicker();
    const n = Math.min(this.conns, this.list.length);
    for (let i = 1; i <= n; i++) {
      const w = { n: i, bytes: 0, info: 'connecting', alive: true, seg: { start: 0 } };
      this.workers.push(w);
      w.promise = this._work(w).finally(() => { w.alive = false; this._onExit(); });
    }
    if (this.map) this.mapBuf = await this._withRetry(() => fetchBuffer(this.map, { headers: this.headers(), timeout: this.timeout })).catch(() => null);
  }
  _syncSegs() {
    // تمثيل بصري: كل مقطع كقطعة
    const total = this.list.length;
    if (this.doneCount) this.size = Math.round((this.downloaded / this.doneCount) * total);
    this.segments = [{ start: 0, end: total - 1, pos: 0 }];
    this.segMap = this.done.slice();
  }
  async _withRetry(fn) {
    let a = 0;
    for (;;) {
      try { return await fn(); } catch (e) {
        if (!this.running) throw e;
        if (e instanceof HttpError && [401, 403, 404, 410].includes(e.status)) throw e;
        if (++a > this.retries) throw e;
        await sleep(Math.min(8000, 800 * a));
      }
    }
  }
  async _key(k) {
    if (!this.keys.has(k.uri)) this.keys.set(k.uri, this._withRetry(() => fetchBuffer(k.uri, { headers: this.headers(), timeout: this.timeout })));
    return this.keys.get(k.uri);
  }
  async _work(w) {
    while (this.running) {
      const i = this.next++;
      if (i >= this.list.length) break;
      if (this.done[i]) continue;
      const s = this.list[i];
      try {
        w.info = 'receiving';
        let buf = await this._withRetry(() => fetchBuffer(s.url, { headers: this.headers(), timeout: this.timeout, signal: this.abort.signal }));
        if (s.key && s.key.method === 'AES-128') {
          const key = await this._key(s.key);
          let iv;
          if (s.key.iv) iv = Buffer.from(s.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
          else { iv = Buffer.alloc(16); iv.writeUInt32BE(s.seq >>> 0, 12); }
          const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
          buf = Buffer.concat([d.update(buf), d.final()]);
        } else if (s.key && s.key.method !== 'AES-128') {
          throw new Error('تشفير غير مدعوم: ' + s.key.method + ' (محتوى محمي بـ DRM)');
        }
        await this.throttle(buf.length);
        if (!this.running) break;
        const f = path.join(this.partDir, `${i}.seg`);
        await fsp.writeFile(f + '.tmp', buf);
        await fsp.rename(f + '.tmp', f);
        this.done[i] = true; this.doneCount++;
        this.downloaded += buf.length; w.bytes += buf.length;
        this._syncSegs();
      } catch (e) {
        if (!this.running || e.code === 'ABORTED') break;
        this.lastError = e;
        w.info = 'error';
        if (!this._failing) { this._failing = true; this._halt().then(() => this.emit('error', e, friendlyError(e))); }
        break;
      }
    }
    if (w.info !== 'error') w.info = 'done';
  }
  _onExit() {
    if (!this.running || this.workers.some(w => w.alive)) return;
    if (this.doneCount === this.list.length) this._finish();
  }
  async _halt() {
    this.running = false;
    this._stopTicker();
    this.abort?.abort();
    await Promise.allSettled(this.workers.map(w => w.promise));
  }
  async _finish() {
    this.running = false;
    this._stopTicker();
    this.emit('status', 'merging');
    try {
      const tsPath = this.finalPath + '.part';
      const out = fs.createWriteStream(tsPath);
      if (this.mapBuf) out.write(this.mapBuf);
      for (let i = 0; i < this.list.length; i++) {
        await new Promise((res, rej) => {
          const r = fs.createReadStream(path.join(this.partDir, `${i}.seg`));
          r.on('error', rej); r.on('end', res); r.pipe(out, { end: false });
        });
      }
      await new Promise((res, rej) => { out.on('error', rej); out.end(res); });
      let finalPath = this.finalPath;
      if (this.ffmpeg && this.toMp4 && !this.mapBuf) {
        const mp4 = finalPath.replace(/\.(ts|m3u8)$/i, '') + '.mp4';
        const { remux } = require('./ffmpeg');
        try { await remux(this.ffmpeg, tsPath, mp4); await fsp.rm(tsPath, { force: true }); finalPath = mp4; } catch { await fsp.rename(tsPath, finalPath); }
      } else {
        await fsp.rename(tsPath, finalPath);
      }
      await fsp.rm(this.partDir, { recursive: true, force: true });
      const st = await fsp.stat(finalPath);
      this.size = this.downloaded = st.size;
      this.speed = 0;
      this.emit('progress', this.snapshot());
      this.emit('complete', { path: finalPath, size: st.size, fileName: path.basename(finalPath) });
    } catch (e) {
      this.emit('error', e, friendlyError(e));
    }
  }
  async pause() {
    if (!this.running) return;
    await this._halt();
    this.speed = 0;
    this.emit('paused', this.snapshot());
  }
}

const { makeDashTask, dashVariants } = require('./dash');
const DashTask = makeDashTask(BaseTask, { buildHeaders, friendlyError, sleep });
const { makeYtdlpTask } = require('./ytdlp');
const YtdlpTask = makeYtdlpTask(BaseTask, { friendlyError });

module.exports = { HttpTask, HlsTask, DashTask, YtdlpTask, Limiter, probe, hlsVariants, dashVariants, parseM3u8, friendlyError, buildHeaders, MIN_SEG };
