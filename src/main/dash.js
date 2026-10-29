'use strict';
/**
 * دعم MPEG-DASH (ملفات .mpd):
 *  - قراءة الملف (محلّل XML صغير بدون مكتبات)
 *  - استخراج الجودات (Representations) للفيديو والصوت
 *  - توليد روابط المقاطع من SegmentTemplate (Number / Time / SegmentTimeline) أو SegmentList أو BaseURL
 *  - DashTask: تنزيل الفيديو والصوت بالتوازي ثم دمجهما بـ FFmpeg (بدون إعادة ترميز)
 * المحتوى المحمي (ContentProtection / DRM) والبث المباشر يُرفضان برسالة واضحة.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchBuffer, HttpError } = require('./net');

/* ---------------- minimal XML parser ---------------- */
function parseXml(text) {
  text = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/</g, '&lt;'));
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  while ((m = re.exec(text))) {
    if (m[5] !== undefined) { stack[stack.length - 1].text += unesc(m[5]); continue; }
    const name = m[2].replace(/^.*:/, '');   // تجاهل البادئة (namespace)
    if (m[1]) { while (stack.length > 1 && stack.pop().name !== name) { /* close */ } continue; }
    const attrs = {};
    m[3].replace(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, k, __, a, b) => { attrs[k.replace(/^.*:/, '')] = unesc(a ?? b ?? ''); return ''; });
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}
const kids = (n, name) => (n ? n.children.filter(c => c.name === name) : []);
const kid = (n, name) => kids(n, name)[0] || null;

function isoDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, k, w) => {
    const v = String(vars[k] ?? '');
    return w ? v.padStart(Number(w), '0') : v;
  }).replace(/\$\$/g, '$');
}

/** يحلّل ملف MPD ويعيد الجودات مع قوائم مقاطعها */
function parseMpd(text, mpdUrl) {
  const doc = parseXml(text);
  const mpd = kid(doc, 'MPD');
  if (!mpd) throw new Error('ليس ملف DASH ‏(MPD) صالحاً');
  if (mpd.attrs.type === 'dynamic') throw new Error('البث المباشر (Live DASH) غير مدعوم — يمكن تنزيل الفيديوهات المسجلة فقط');
  const period = kid(mpd, 'Period');
  if (!period) throw new Error('ملف MPD بدون Period');
  const periodDur = isoDuration(period.attrs.duration) || isoDuration(mpd.attrs.mediaPresentationDuration);
  const resolve = (base, n) => { const b = kid(n, 'BaseURL'); return b ? new URL(b.text.trim(), base).toString() : base; };
  const mpdBase = resolve(mpdUrl, mpd);
  const periodBase = resolve(mpdBase, period);
  const reps = [];
  let drm = false;

  for (const as of kids(period, 'AdaptationSet')) {
    if (kids(as, 'ContentProtection').length) drm = true;
    const asBase = resolve(periodBase, as);
    for (const rep of kids(as, 'Representation')) {
      if (kids(rep, 'ContentProtection').length) drm = true;
      const a = { ...as.attrs, ...rep.attrs };
      const mime = a.mimeType || '';
      const ctype = a.contentType || (mime.split('/')[0]) || (a.width ? 'video' : (a.audioSamplingRate ? 'audio' : ''));
      if (ctype !== 'video' && ctype !== 'audio') continue;
      const base = resolve(asBase, rep);
      const vars = { RepresentationID: rep.attrs.id, Bandwidth: a.bandwidth };
      const st = kid(rep, 'SegmentTemplate') || kid(as, 'SegmentTemplate') || kid(period, 'SegmentTemplate');
      const sl = kid(rep, 'SegmentList') || kid(as, 'SegmentList');
      let init = null; const segs = [];
      if (st) {
        // دمج خصائص القالب: مستوى Representation يتغلب على AdaptationSet
        const asT = kid(as, 'SegmentTemplate'); const repT = kid(rep, 'SegmentTemplate');
        const t = { ...(asT ? asT.attrs : {}), ...(repT ? repT.attrs : {}) };
        const timelineNode = kid(repT, 'SegmentTimeline') || kid(asT, 'SegmentTimeline');
        const timescale = Number(t.timescale || 1);
        let number = Number(t.startNumber ?? 1);
        if (t.initialization) init = { url: new URL(fillTemplate(t.initialization, vars), base).toString() };
        if (timelineNode) {
          let time = 0;
          const S = kids(timelineNode, 'S');
          S.forEach((s, i) => {
            if (s.attrs.t !== undefined) time = Number(s.attrs.t);
            const d = Number(s.attrs.d);
            let r = Number(s.attrs.r || 0);
            if (r < 0) {
              const end = S[i + 1]?.attrs.t !== undefined ? Number(S[i + 1].attrs.t) : periodDur * timescale;
              r = Math.max(0, Math.ceil((end - time) / d) - 1);
            }
            for (let k = 0; k <= r; k++) {
              segs.push({ url: new URL(fillTemplate(t.media, { ...vars, Number: number, Time: time }), base).toString() });
              time += d; number++;
            }
          });
        } else if (t.duration) {
          const segDur = Number(t.duration) / timescale;
          const count = Math.ceil(periodDur / segDur);
          if (!count || !isFinite(count)) throw new Error('تعذر حساب عدد المقاطع في ملف DASH');
          for (let k = 0; k < count; k++) segs.push({ url: new URL(fillTemplate(t.media, { ...vars, Number: number + k, Time: Math.round(k * Number(t.duration)) }), base).toString() });
        }
      } else if (sl) {
        const ini = kid(sl, 'Initialization');
        if (ini) init = { url: new URL(ini.attrs.sourceURL || '', base).toString(), range: ini.attrs.range };
        for (const su of kids(sl, 'SegmentURL')) segs.push({ url: su.attrs.media ? new URL(su.attrs.media, base).toString() : base, range: su.attrs.mediaRange });
      } else {
        segs.push({ url: base });   // ملف واحد كامل (SegmentBase / BaseURL)
      }
      if (!segs.length) continue;
      reps.push({
        id: rep.attrs.id || String(reps.length), type: ctype, bandwidth: Number(a.bandwidth || 0),
        width: Number(a.width || 0), height: Number(a.height || 0), codecs: a.codecs || '', mime, lang: a.lang || '',
        init, segs,
      });
    }
  }
  if (!reps.length && drm) throw new Error('هذا الفيديو محمي بنظام DRM ولا يمكن تنزيله');
  if (!reps.length) throw new Error('لم يتم العثور على مسارات فيديو أو صوت في ملف DASH');
  if (drm) throw new Error('هذا الفيديو محمي بنظام DRM ولا يمكن تنزيله');
  const videos = reps.filter(r => r.type === 'video').sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
  const audios = reps.filter(r => r.type === 'audio').sort((x, y) => y.bandwidth - x.bandwidth);
  return { videos, audios, duration: periodDur };
}

async function dashVariants(url, headers, timeout) {
  const text = (await fetchBuffer(url, { headers, timeout })).toString('utf8');
  const { videos, audios } = parseMpd(text, url);
  const list = videos.map(v => ({ url: v.id, resolution: v.width ? `${v.width}x${v.height}` : '', bandwidth: v.bandwidth, codecs: v.codecs }));
  if (!list.length && audios.length) list.push(...audios.map(a => ({ url: a.id, resolution: 'audio', bandwidth: a.bandwidth, codecs: a.codecs })));
  return list;
}

/* ---------------- DashTask ---------------- */
function makeDashTask(BaseTask, helpers) {
  const { buildHeaders, friendlyError, sleep } = helpers;
  return class DashTask extends BaseTask {
    constructor(rec, opts) {
      super(rec, opts);
      this.finalPath = path.join(rec.saveDir, rec.fileName);
      this.partDir = this.finalPath + '.parts';
      this.ffmpeg = opts.ffmpeg || null;
      this.resumable = true;
      this.segments = [];
    }
    headers() { return buildHeaders(this.rec, this.auth); }
    snapshot() {
      return {
        id: this.id, downloaded: this.downloaded, size: this.size, speed: this.speed, eta: this.eta(), resumable: true, hls: true, dash: true,
        segments: [], conns: this.workers.map(w => ({ n: w.n, bytes: w.bytes, info: w.info, start: 0 })),
        hlsDone: this.doneCount || 0, hlsTotal: this.jobs ? this.jobs.length : 0, hlsMap: this.done ? this.done.slice() : [],
      };
    }
    async start() {
      this.running = true;
      this.abort = new AbortController();
      this.emit('status', 'connecting');
      try {
        const text = (await fetchBuffer(this.rec.url, { headers: this.headers(), timeout: this.timeout })).toString('utf8');
        const { videos, audios } = parseMpd(text, this.rec.url);
        const v = videos.find(x => x.id === this.rec.hlsVariant) || videos[0] || null;
        // صوت مناسب: أعلى جودة (أو نفس اللغة إن وُجدت)
        const a = audios[0] || null;
        this.tracks = [v && { key: 'v', rep: v }, a && { key: 'a', rep: a }].filter(Boolean);
        if (!this.tracks.length) throw new Error('لا توجد مسارات قابلة للتنزيل');
        this.jobs = [];
        for (const tr of this.tracks) {
          const list = (tr.rep.init ? [{ ...tr.rep.init, init: true }] : []).concat(tr.rep.segs);
          list.forEach((s, i) => this.jobs.push({ ...s, track: tr.key, idx: i, file: path.join(this.partDir, `${tr.key}${String(i).padStart(6, '0')}.seg`) }));
        }
        await fsp.mkdir(this.partDir, { recursive: true });
      } catch (e) {
        this.running = false;
        this.emit('error', e, friendlyError(e));
        return;
      }
      if (!this.running) return;
      this.emit('meta', { size: -1, resumable: true, finalUrl: this.rec.url, mime: 'application/dash+xml' });
      this.done = this.jobs.map(j => fs.existsSync(j.file));
      this.downloaded = this.jobs.reduce((s, j, i) => s + (this.done[i] ? fs.statSync(j.file).size : 0), 0);
      this.doneCount = this.done.filter(Boolean).length;
      this._estimate();
      this.next = 0;
      this.emit('status', 'downloading');
      this._startTicker();
      const n = Math.min(this.conns, this.jobs.length);
      for (let i = 1; i <= n; i++) {
        const w = { n: i, bytes: 0, info: 'connecting', alive: true };
        this.workers.push(w);
        w.promise = this._work(w).finally(() => { w.alive = false; this._onExit(); });
      }
    }
    _estimate() { if (this.doneCount) this.size = Math.round((this.downloaded / this.doneCount) * this.jobs.length); }
    async _fetch(job) {
      const h = { ...this.headers() };
      if (job.range) h.Range = 'bytes=' + job.range;
      let a = 0;
      for (;;) {
        try { return await fetchBuffer(job.url, { headers: h, timeout: this.timeout, signal: this.abort.signal }); } catch (e) {
          if (!this.running) throw e;
          if (e instanceof HttpError && [401, 403, 404, 410].includes(e.status)) throw e;
          if (++a > this.retries) throw e;
          await sleep(Math.min(8000, 800 * a));
        }
      }
    }
    async _work(w) {
      while (this.running) {
        const i = this.next++;
        if (i >= this.jobs.length) break;
        if (this.done[i]) continue;
        const job = this.jobs[i];
        try {
          w.info = 'receiving';
          const buf = await this._fetch(job);
          await this.throttle(buf.length);
          if (!this.running) break;
          await fsp.writeFile(job.file + '.tmp', buf);
          await fsp.rename(job.file + '.tmp', job.file);
          this.done[i] = true; this.doneCount++;
          this.downloaded += buf.length; w.bytes += buf.length;
          this._estimate();
        } catch (e) {
          if (!this.running || e.code === 'ABORTED') break;
          w.info = 'error';
          if (!this._failing) { this._failing = true; this._halt().then(() => this.emit('error', e, friendlyError(e))); }
          break;
        }
      }
      if (w.info !== 'error') w.info = 'done';
    }
    _onExit() {
      if (!this.running || this.workers.some(w => w.alive)) return;
      if (this.doneCount === this.jobs.length) this._finish();
    }
    async _halt() {
      this.running = false;
      this._stopTicker();
      this.abort?.abort();
      await Promise.allSettled(this.workers.map(w => w.promise));
    }
    async _concat(key, out) {
      const ws = fs.createWriteStream(out);
      for (const j of this.jobs.filter(x => x.track === key)) {
        await new Promise((res, rej) => { const r = fs.createReadStream(j.file); r.on('error', rej); r.on('end', res); r.pipe(ws, { end: false }); });
      }
      await new Promise((res, rej) => { ws.on('error', rej); ws.end(res); });
    }
    async _finish() {
      this.running = false;
      this._stopTicker();
      this.emit('status', 'merging');
      try {
        const base = this.finalPath.replace(/\.[^.\\/]+$/, '');
        const outs = {};
        for (const tr of this.tracks) {
          const ext = tr.key === 'v' ? (/webm/i.test(tr.rep.mime) ? '.webm' : '.mp4') : (/webm/i.test(tr.rep.mime) ? '.weba' : '.m4a');
          outs[tr.key] = path.join(this.partDir, 'track-' + tr.key + ext);
          await this._concat(tr.key, outs[tr.key]);
        }
        let finalPath; let note = '';
        if (outs.v && outs.a) {
          const webm = /webm/i.test(outs.v) && /weba/i.test(outs.a);
          finalPath = base + (webm ? '.webm' : '.mp4');
          if (this.ffmpeg) {
            const { mux } = require('./ffmpeg');
            await mux(this.ffmpeg, outs.v, outs.a, finalPath + '.part' + (webm ? '.webm' : '.mp4'));
            await fsp.rename(finalPath + '.part' + (webm ? '.webm' : '.mp4'), finalPath);
          } else {
            // بدون FFmpeg: نحفظ المسارين منفصلين
            await fsp.rename(outs.v, base + '.video' + path.extname(outs.v));
            await fsp.rename(outs.a, base + '.audio' + path.extname(outs.a));
            finalPath = base + '.video' + path.extname(outs.v);
            note = 'FFmpeg غير مثبت: حُفظ الصوت في ملف منفصل (.audio)';
          }
        } else {
          const only = outs.v || outs.a;
          finalPath = base + path.extname(only);
          await fsp.rename(only, finalPath);
        }
        await fsp.rm(this.partDir, { recursive: true, force: true });
        const st = await fsp.stat(finalPath);
        this.size = this.downloaded = st.size;
        this.speed = 0;
        this.emit('progress', this.snapshot());
        this.emit('complete', { path: finalPath, size: st.size, fileName: path.basename(finalPath), note });
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
  };
}

module.exports = { parseXml, parseMpd, dashVariants, makeDashTask, isoDuration, fillTemplate };
