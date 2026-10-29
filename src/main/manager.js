'use strict';
/**
 * مدير التنزيلات: يربط المحرك بقاعدة Realm، ويدير قوائم الانتظار والجدولة والتصنيفات.
 * لا يعتمد على Electron — يمكن تشغيله واختباره في Node مباشرة.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { HttpTask, HlsTask, DashTask, YtdlpTask, Limiter, probe, hlsVariants, dashVariants, friendlyError } = require('./engine');
const { findFfmpeg, mux } = require('./ffmpeg');
const { ytdlpInfo, isYtdlpUrl } = require('./ytdlp');
const U = require('./utils');

const ACTIVE = ['connecting', 'downloading', 'merging'];

class Manager extends EventEmitter {
  constructor(db, { defaultRoot, components }) {
    super();
    this.db = db;
    this.components = components || null;
    this.defaultRoot = defaultRoot;
    this.tasks = new Map();
    this.progress = new Map();
    this.runningQueues = new Set();
    this.retryCounts = new Map();
    this._persistAt = new Map();
    this.settings = db.settings.all();
    this.global = new Limiter(this.settings.speedLimit);
    this.ffmpeg = null;
    this._refreshFfmpeg();
    this._lastSched = {};
    this._sched = setInterval(() => this._scheduler(), 15000);
  }

  dispose() { clearInterval(this._sched); }
  _refreshFfmpeg() {
    const f = this.components ? this.components.findFfmpeg() : findFfmpeg(this.settings.ffmpegPath);
    return f.then(p => { this.ffmpeg = p; this.emit('settings', this.settings); return p; });
  }

  /* ------------ state ------------ */
  root() { return this.settings.downloadsRoot || this.defaultRoot; }
  dirFor(category) {
    const c = this.db.categories.all().find(x => x.name === category);
    if (!c) return this.root();
    return path.isAbsolute(c.folder) ? c.folder : path.join(this.root(), c.folder);
  }
  state() {
    return {
      downloads: this.db.downloads.all(),
      categories: this.db.categories.all(),
      queues: this.db.queues.all(),
      settings: this.settings,
      logins: this.db.logins.all(),
      runningQueues: [...this.runningQueues],
      progress: Object.fromEntries(this.progress),
      ffmpeg: this.ffmpeg,
      root: this.root(),
      bridgePort: this.bridgePort || null,
    };
  }
  _emitUpdate(rec) { if (rec) this.emit('update', rec); }

  saveSettings(patch) {
    this.settings = this.db.settings.save(patch);
    this.global.set(this.settings.speedLimit);
    if ('ffmpegPath' in patch) this._refreshFfmpeg();
    this.emit('settings', this.settings);
    return this.settings;
  }

  /* ------------ inspect a link before adding (Download File Info) ------------ */
  async inspect({ url, referer, cookies, userAgent, headers, kind }) {
    url = String(url || '').trim();
    if (!U.isHttpUrl(url)) throw new Error('رابط غير صالح');
    const rec = { referer, cookies, userAgent, headers: headers ? JSON.stringify(headers) : '{}' };
    const h = require('./engine').buildHeaders(rec, this._auth(url));
    if (this.components && (kind === 'ytdlp' || isYtdlpUrl(url))) return this._inspectYtdlp({ url, referer, cookies, userAgent, headers });
    if (/\.mpd(\?|$)/i.test(url)) return this._inspectDash(url, h);
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls) {
      let variants = [];
      try { variants = await hlsVariants(url, h, this.settings.timeout * 1000); } catch (e) { throw new Error(friendlyError(e)); }
      const fileName = U.sanitizeFileName(U.fileNameFromUrl(url).replace(/\.m3u8$/i, '') + '.ts');
      return { url, fileName, size: -1, resumable: true, kind: 'hls', mime: 'application/vnd.apple.mpegurl', variants, category: 'Video', saveDir: this.dirFor('Video') };
    }
    let p;
    try { p = await probe(url, h, this.settings.timeout * 1000); } catch (e) { throw new Error(friendlyError(e)); }
    if (/dash\+xml/i.test(p.mime)) return this._inspectDash(p.finalUrl, h);
    // صفحة ويب وليست ملفاً: نحاول استخراج الفيديو منها عبر yt-dlp (المستخرج العام)
    if (this.components && /text\/html|xhtml/i.test(p.mime)) {
      try { return await this._inspectYtdlp({ url, referer, cookies, userAgent, headers }); } catch { /* ليست صفحة فيديو: نتابع كملف عادي */ }
    }
    if (/mpegurl/i.test(p.mime)) {
      const variants = await hlsVariants(p.finalUrl, h).catch(() => []);
      return { url, fileName: p.fileName.replace(/\.m3u8$/i, '') + '.ts', size: -1, resumable: true, kind: 'hls', mime: p.mime, variants, category: 'Video', saveDir: this.dirFor('Video') };
    }
    const category = U.categoryFor(p.fileName, this.db.categories.all());
    return { url, finalUrl: p.finalUrl, fileName: p.fileName, size: p.size, resumable: p.resumable, mime: p.mime, kind: 'http', category, saveDir: this.dirFor(category) };
  }

  async _inspectYtdlp(o) {
    const rec = { _id: 'inspect', url: o.url, referer: o.referer || '', cookies: o.cookies || '', userAgent: o.userAgent || '', headers: o.headers ? JSON.stringify(o.headers) : '{}' };
    const info = await ytdlpInfo(this.components, rec);
    if (info.playlist) return { url: o.url, kind: 'ytdlp', playlist: true, title: info.title, entries: info.entries, category: 'Video', saveDir: this.dirFor('Video'), fileName: U.sanitizeFileName(info.title), size: -1, resumable: true, variants: [
      { url: 'v:2160', resolution: '2160p' }, { url: 'v:1440', resolution: '1440p' }, { url: 'v:1080', resolution: '1080p' }, { url: 'v:720', resolution: '720p' }, { url: 'v:480', resolution: '480p' }, { url: 'v:360', resolution: '360p' }, { url: 'a:m4a', resolution: 'audio', label: 'M4A' }, { url: 'a:mp3', resolution: 'audio', label: 'MP3' }] };
    const fileName = U.sanitizeFileName(info.title).slice(0, 150) + '.mp4';
    const best = info.variants[0];
    return { url: o.url, kind: 'ytdlp', title: info.title, thumbnail: info.thumbnail, duration: info.duration, uploader: info.uploader, extractor: info.extractor,
      fileName, size: best && best.size ? best.size : -1, resumable: true, mime: 'video/mp4', variants: info.variants, category: 'Video', saveDir: this.dirFor('Video') };
  }

  addPlaylist(entries, { variant = 'v:1080', queueId = 'main', start = true, saveDir } = {}) {
    const ext = String(variant).startsWith('a:') ? (variant === 'a:mp3' ? '.mp3' : '.m4a') : '.mp4';
    const added = entries.map(e => this.add({ url: e.url, fileName: U.sanitizeFileName(e.title || 'video').slice(0, 150) + ext, kind: 'ytdlp', hlsVariant: variant, category: 'Video', saveDir, start: 'later', queueId }));
    if (start) this.startQueue(queueId);
    return added;
  }

  async _inspectDash(url, h) {
    let variants;
    try { variants = await dashVariants(url, h, this.settings.timeout * 1000); } catch (e) { throw new Error(friendlyError(e)); }
    const fileName = U.sanitizeFileName(U.fileNameFromUrl(url).replace(/\.mpd$/i, '') + '.mp4');
    return { url, fileName, size: -1, resumable: true, kind: 'dash', mime: 'application/dash+xml', variants, category: 'Video', saveDir: this.dirFor('Video') };
  }

  _auth(url) { try { return this.db.logins.forHost(new URL(url).hostname); } catch { return null; } }

  /* ------------ add ------------ */
  add(o) {
    const url = String(o.url || '').trim();
    if (!U.isHttpUrl(url)) throw new Error('رابط غير صالح');
    let fileName = U.sanitizeFileName(o.fileName || U.fileNameFromUrl(url, o.mime));
    const categories = this.db.categories.all();
    const category = o.category || U.categoryFor(fileName, categories);
    const saveDir = o.saveDir || this.dirFor(category);
    if (this.settings.duplicate !== 'overwrite') {
      const taken = new Set(this.db.downloads.all().map(d => path.join(d.saveDir, d.fileName).toLowerCase()));
      fileName = path.basename(U.uniquePath(saveDir, fileName, taken));
    }
    const mode = o.start || 'now';  // now | later
    const rec = this.db.downloads.create({
      url, fileName, saveDir, category,
      size: Number.isFinite(o.size) ? o.size : -1,
      resumable: !!o.resumable,
      mime: o.mime || '',
      description: o.description || '',
      referer: o.referer || '',
      cookies: o.cookies || '',
      userAgent: o.userAgent || this.settings.userAgent || '',
      headers: o.headers ? JSON.stringify(o.headers) : '{}',
      kind: o.kind || (/\.m3u8(\?|$)/i.test(url) ? 'hls' : /\.mpd(\?|$)/i.test(url) ? 'dash' : (this.components && isYtdlpUrl(url)) ? 'ytdlp' : 'http'),
      hlsVariant: o.hlsVariant || '',
      mirrors: o.mirrors || '',
      queueId: o.queueId !== undefined && o.queueId !== null ? o.queueId : (mode === 'later' ? 'main' : ''),
      status: 'stopped',
    });
    this._emitUpdate(rec);
    if (mode === 'now') this.start(rec._id);
    return rec;
  }

  addBatch(urls, { queueId = 'main', start = false, saveDir } = {}) {
    const added = [];
    for (const url of urls) {
      if (!U.isHttpUrl(url)) continue;
      added.push(this.add({ url, queueId, start: 'later', saveDir }));
    }
    if (start) this.startQueue(queueId);
    return added;
  }

  /* ------------ control ------------ */
  start(id) {
    if (this.tasks.has(id)) return;
    const rec = this.db.downloads.get(id);
    if (!rec || rec.status === 'complete') return;
    const opts = {
      connections: rec.connections || this.settings.maxConnections,
      retries: this.settings.retries,
      timeout: this.settings.timeout,
      limiters: [this.global],
      auth: this._auth(rec.url),
      ffmpeg: this.ffmpeg,
      hlsToMp4: this.settings.hlsToMp4,
      components: this.components,
    };
    const task = rec.kind === 'hls' ? new HlsTask(rec, opts) : rec.kind === 'dash' ? new DashTask(rec, opts) : rec.kind === 'ytdlp' ? new YtdlpTask(rec, opts) : new HttpTask(rec, opts);
    this.tasks.set(id, task);
    this._emitUpdate(this.db.downloads.update(id, { status: 'connecting', error: '', lastTry: Date.now() }));
    this.emit('started', id);

    task.on('meta', (m) => {
      const patch = { resumable: m.resumable, finalUrl: m.finalUrl || '', etag: m.etag || '' };
      if (m.size > 0) patch.size = m.size;
      if (m.mime) patch.mime = m.mime;
      this._emitUpdate(this.db.downloads.update(id, patch));
    });
    task.on('status', (s) => this._emitUpdate(this.db.downloads.update(id, { status: s })));
    task.on('progress', (snap) => {
      this.progress.set(id, snap);
      this.emit('progress', id, snap);
      const now = Date.now();
      if (now - (this._persistAt.get(id) || 0) > 2000) {
        this._persistAt.set(id, now);
        const patch = { downloaded: snap.downloaded };
        if (!snap.hls) patch.segments = snap.segments;
        if (snap.size > 0) patch.size = snap.size;
        this.db.downloads.update(id, patch);
      }
    });
    task.on('paused', (snap) => {
      this.tasks.delete(id);
      this.progress.set(id, snap);
      const patch = { status: 'paused', downloaded: snap.downloaded };
      if (!snap.hls) patch.segments = snap.segments;
      this._emitUpdate(this.db.downloads.update(id, patch));
      this.emit('progress', id, snap);
      this._pump();
    });
    task.on('complete', (r) => {
      this.tasks.delete(id);
      this.retryCounts.delete(id);
      const patch = { status: 'complete', size: r.size, downloaded: r.size, segments: [], completedAt: Date.now(), error: '' };
      if (r.fileName) patch.fileName = r.fileName;
      if (r.note) patch.description = r.note;
      const done = this.db.downloads.update(id, patch);
      this.progress.set(id, { ...(this.progress.get(id) || {}), id, downloaded: r.size, size: r.size, speed: 0, eta: 0, done: true });
      this._emitUpdate(done);
      this.emit('complete', done);
      if (done.afterComplete && done.afterComplete !== 'none' && !this._anyActive()) this.emit('system-action', done.afterComplete);
      this._pump();
    });
    task.on('error', (e, msg) => {
      this.tasks.delete(id);
      const snap = task.snapshot ? task.snapshot() : null;
      const patch = { status: 'error', error: msg || friendlyError(e) };
      if (snap && !snap.hls && task.resumable) { patch.segments = snap.segments; patch.downloaded = snap.downloaded; }
      this._emitUpdate(this.db.downloads.update(id, patch));
      this.emit('failed', id, patch.error);
      // داخل قائمة الانتظار: أعد المحاولة لاحقاً حسب إعداد القائمة
      const rec2 = this.db.downloads.get(id);
      if (rec2 && rec2.queueId && this.runningQueues.has(rec2.queueId)) {
        const q = this.db.queues.get(rec2.queueId);
        const c = (this.retryCounts.get(id) || 0) + 1;
        this.retryCounts.set(id, c);
        if (q && c <= q.retryFailed) this.db.downloads.update(id, { status: 'queued' });
      }
      this._pump();
    });
    task.start();
  }

  async pause(ids) {
    for (const id of [].concat(ids)) {
      const t = this.tasks.get(id);
      if (t) await t.pause();
      else {
        const r = this.db.downloads.get(id);
        if (r && r.status === 'queued') this._emitUpdate(this.db.downloads.update(id, { status: 'stopped' }));
      }
    }
  }

  async stopAll() {
    for (const q of [...this.runningQueues]) this.runningQueues.delete(q);
    await Promise.all([...this.tasks.values()].map(t => t.pause()));
    for (const d of this.db.downloads.all()) if (d.status === 'queued') this._emitUpdate(this.db.downloads.update(d._id, { status: 'stopped' }));
    this.emit('queues', [...this.runningQueues]);
  }

  async remove(ids, deleteFiles = false) {
    ids = [].concat(ids);
    await this.pause(ids);
    for (const id of ids) {
      const r = this.db.downloads.get(id);
      if (!r) continue;
      const full = path.join(r.saveDir, r.fileName);
      await fsp.rm(full + '.part', { force: true }).catch(() => {});
      await fsp.rm(full + '.parts', { recursive: true, force: true }).catch(() => {});
      if (deleteFiles && r.status === 'complete') await fsp.rm(full, { force: true }).catch(() => {});
      this.progress.delete(id);
    }
    this.db.downloads.remove(ids);
    this.emit('removed', ids);
  }

  async removeCompleted() {
    const ids = this.db.downloads.all().filter(d => d.status === 'complete').map(d => d._id);
    if (ids.length) { this.db.downloads.remove(ids); this.emit('removed', ids); }
    return ids.length;
  }

  async redownload(id) {
    await this.pause(id);
    const r = this.db.downloads.get(id);
    if (!r) return;
    const full = path.join(r.saveDir, r.fileName);
    await fsp.rm(full + '.part', { force: true }).catch(() => {});
    await fsp.rm(full + '.parts', { recursive: true, force: true }).catch(() => {});
    this._emitUpdate(this.db.downloads.update(id, { status: 'stopped', segments: [], downloaded: 0, size: -1, error: '', completedAt: null }));
    this.progress.delete(id);
    this.start(id);
  }

  updateProps(id, patch) {
    const r = this.db.downloads.get(id);
    if (!r) return null;
    const allowed = {};
    for (const k of ['url', 'description', 'referer', 'cookies', 'userAgent', 'connections', 'afterComplete', 'showComplete', 'hlsVariant', 'mirrors']) if (k in patch) allowed[k] = patch[k];
    const started = r.downloaded > 0 || r.status === 'complete';
    if (!this.tasks.has(id) && 'fileName' in patch && !started) allowed.fileName = U.sanitizeFileName(patch.fileName);
    if (!this.tasks.has(id) && 'saveDir' in patch && !started) allowed.saveDir = patch.saveDir;
    if ('speedLimit' in patch) { allowed.speedLimit = Number(patch.speedLimit) || 0; this.tasks.get(id)?.setSpeedLimit(allowed.speedLimit); }
    const out = this.db.downloads.update(id, allowed);
    this._emitUpdate(out);
    return out;
  }

  moveToQueue(ids, queueId) {
    for (const id of [].concat(ids)) this._emitUpdate(this.db.downloads.update(id, { queueId: queueId || '' }));
  }

  reorder(id, dir) {
    const r = this.db.downloads.get(id);
    if (!r || !r.queueId) return;
    const list = this.db.downloads.all().filter(d => d.queueId === r.queueId).sort((a, b) => a.position - b.position);
    const i = list.findIndex(d => d._id === id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[i]; const b = list[j];
    this._emitUpdate(this.db.downloads.update(a._id, { position: b.position }));
    this._emitUpdate(this.db.downloads.update(b._id, { position: a.position === b.position ? a.position + dir : a.position }));
  }

  /* ------------ queues ------------ */
  startQueue(qid = 'main') {
    this.runningQueues.add(qid);
    for (const d of this.db.downloads.all()) {
      if (d.queueId === qid && ['stopped', 'paused', 'error'].includes(d.status) && !this.tasks.has(d._id)) {
        this.db.downloads.update(d._id, { status: 'queued' });
      }
    }
    this.emit('reload');
    this.emit('queues', [...this.runningQueues]);
    this._pump();
  }

  async stopQueue(qid = 'main') {
    this.runningQueues.delete(qid);
    const ids = this.db.downloads.all().filter(d => d.queueId === qid).map(d => d._id);
    await this.pause(ids.filter(id => this.tasks.has(id)));
    for (const id of ids) { const r = this.db.downloads.get(id); if (r.status === 'queued') this.db.downloads.update(id, { status: 'stopped' }); }
    this.emit('reload');
    this.emit('queues', [...this.runningQueues]);
  }

  saveQueue(q) { const out = this.db.queues.save(q); this.emit('reload'); return out; }
  removeQueue(id) { this.runningQueues.delete(id); this.db.queues.remove(id); this.emit('reload'); }

  _anyActive() { return this.tasks.size > 0; }

  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      for (const qid of [...this.runningQueues]) {
        const q = this.db.queues.get(qid);
        if (!q) { this.runningQueues.delete(qid); continue; }
        const all = this.db.downloads.all().filter(d => d.queueId === qid);
        const active = all.filter(d => this.tasks.has(d._id)).length;
        const waiting = all.filter(d => d.status === 'queued' && !this.tasks.has(d._id)).sort((a, b) => a.position - b.position);
        let slots = Math.max(1, q.maxConcurrent) - active;
        for (const d of waiting) { if (slots-- <= 0) break; this.start(d._id); }
        const still = this.db.downloads.all().filter(d => d.queueId === qid && (d.status === 'queued' || this.tasks.has(d._id)));
        if (!still.length) {
          this.runningQueues.delete(qid);
          this.emit('queues', [...this.runningQueues]);
          this.emit('queue-done', q);
          if (q.afterDone && q.afterDone !== 'none') this.emit('system-action', q.afterDone);
        }
      }
    } finally { this._pumping = false; }
  }

  _scheduler(now = new Date()) {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = now.getDay();
    const key = now.toDateString() + ' ' + hhmm;
    for (const q of this.db.queues.all()) {
      if (!q.days.includes(day)) continue;
      if (q.startEnabled && q.startTime === hhmm && this._lastSched[q._id + 's'] !== key) {
        this._lastSched[q._id + 's'] = key;
        this.emit('log', `Scheduler: starting ${q.name}`);
        this.startQueue(q._id);
      }
      if (q.stopEnabled && q.stopTime === hhmm && this._lastSched[q._id + 'e'] !== key) {
        this._lastSched[q._id + 'e'] = key;
        this.emit('log', `Scheduler: stopping ${q.name}`);
        this.stopQueue(q._id);
      }
    }
  }

  /* ------------ categories ------------ */
  saveCategory(c) { this.db.categories.save(c); this.emit('reload'); }
  removeCategory(name) { this.db.categories.remove(name); this.emit('reload'); }

  /* ------------ list import/export ------------ */
  exportList(ids) {
    const all = this.db.downloads.all();
    return (ids && ids.length ? all.filter(d => ids.includes(d._id)) : all).map(d => d.url).join('\n');
  }

  /* ------------ merge DASH audio + video ------------ */
  async merge(videoId, audioId) {
    const bin = this.ffmpeg || (this.components ? await this.components.ensureFfmpeg() : await findFfmpeg(this.settings.ffmpegPath));
    if (!bin) throw new Error('FFmpeg غير موجود. ثبّته أو حدد مساره في الخيارات');
    const v = this.db.downloads.get(videoId);
    const a = this.db.downloads.get(audioId);
    if (!v || !a || v.status !== 'complete' || a.status !== 'complete') throw new Error('يجب أن يكتمل الملفان أولاً');
    const vp = path.join(v.saveDir, v.fileName);
    const ap = path.join(a.saveDir, a.fileName);
    const ext = /\.webm$/i.test(v.fileName) ? '.mkv' : '.mp4';
    const out = U.uniquePath(v.saveDir, v.fileName.replace(/\.[^.]+$/, '') + ' (merged)' + ext);
    await mux(bin, vp, ap, out);
    const st = await fsp.stat(out);
    const rec = this.db.downloads.create({
      url: v.url, fileName: path.basename(out), saveDir: v.saveDir, category: 'Video', size: st.size, downloaded: st.size,
      status: 'complete', completedAt: Date.now(), description: 'Merged: video + audio', kind: 'http',
    });
    this._emitUpdate(rec);
    return rec;
  }
}

module.exports = { Manager, ACTIVE };
