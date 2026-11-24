'use strict';
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');

const dns = require('dns');

/** ذاكرة DNS مؤقتة (5 دقائق): لا انتظار للاستعلام مع كل اتصال جديد */
const dnsCache = new Map();
function cachedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  const key = `${hostname}|${options.family || 0}|${options.all ? 1 : 0}`;
  const hit = dnsCache.get(key);
  if (hit && hit.exp > Date.now()) return process.nextTick(() => cb(null, ...hit.val));
  dns.lookup(hostname, options, (err, address, family) => {
    if (!err) {
      dnsCache.set(key, { exp: Date.now() + 300000, val: [address, family] });
      if (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value);
    }
    cb(err, address, family);
  });
}

// Happy Eyeballs (autoSelectFamily): يجرّب IPv6 وIPv4 معاً ويأخذ الأسرع
const AGENT_OPTS = { keepAlive: true, maxSockets: 64, scheduling: 'lifo', autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, lookup: cachedLookup };
const agents = {
  'http:': new http.Agent(AGENT_OPTS),
  'https:': new https.Agent(AGENT_OPTS),
};

class HttpError extends Error {
  constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status; }
}

let APP_VERSION = '1';
try { APP_VERSION = require('../../package.json').version || '1'; } catch { /* ignore */ }

/** هوية متصفح كروم حديث: نفس إصدار Chromium داخل البرنامج (كانت ثابتة على كروم 130 القديم) */
const CHROME_MAJOR = String(process.versions.chrome || '156.0.0.0').split('.')[0];
const DEFAULT_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
/** هوية صريحة لبرنامج تنزيل: بعض الخوادم (مثل خوادم اختبار السرعة) تقطع الاتصال على هوية المتصفح من برنامج غير متصفح */
const HONEST_UA = `Barq/${APP_VERSION} (Windows; download manager)`;

/* ------------------------------------------------------------------ *
 * محرك Chromium (وحدة net في Electron): HTTP/2 وHTTP/3 (QUIC) وبصمة TLS لمتصفح حقيقي،
 * ويحترم إعدادات البروكسي في النظام. كل «مسار» (lane) جلسة مستقلة لها مجمّع اتصالات خاص بها،
 * لأن Chromium لا يفتح أكثر من 6 اتصالات HTTP/1.1 للخادم الواحد في الجلسة الواحدة،
 * ولأن HTTP/2 وHTTP/3 يجمعان كل الطلبات في اتصال واحد: بالمسارات يبقى لكل جزء اتصاله الخاص.
 * ------------------------------------------------------------------ */
let enet = null; let esession = null;
const LANES = 32;
const lanes = [];
let laneRR = 0;

function enableChromium() {
  try {
    const e = require('electron');
    if (!e || !e.net || !e.session || typeof e.net.request !== 'function') return false;
    enet = e.net; esession = e.session;
    return true;
  } catch { return false; }
}
const chromiumAvailable = () => !!enet;

function laneSession(i) {
  const k = ((Number(i) || 0) % LANES + LANES) % LANES;
  if (!lanes[k]) {
    const ses = esession.fromPartition(`barq-net-${k}`, { cache: false });
    // Chromium يرفض ترويسة Referer المكتوبة مباشرة (ERR_BLOCKED_BY_CLIENT): نمرّرها باسم مؤقت ونعيد تسميتها هنا
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      const key = Object.keys(h).find(x => x.toLowerCase() === 'x-barq-referer');
      if (key) { h.Referer = h[key]; delete h[key]; }
      cb({ requestHeaders: h });
    });
    lanes[k] = ses;
  }
  return lanes[k];
}

const NET_ERR = {
  ERR_CONNECTION_RESET: 'ECONNRESET', ERR_CONNECTION_CLOSED: 'ECONNRESET', ERR_EMPTY_RESPONSE: 'ECONNRESET',
  ERR_CONNECTION_ABORTED: 'ECONNRESET', ERR_NETWORK_CHANGED: 'ECONNRESET', ERR_HTTP2_PROTOCOL_ERROR: 'ECONNRESET',
  ERR_QUIC_PROTOCOL_ERROR: 'ECONNRESET', ERR_HTTP2_PING_FAILED: 'ECONNRESET', ERR_INCOMPLETE_CHUNKED_ENCODING: 'ECONNRESET',
  ERR_CONTENT_LENGTH_MISMATCH: 'ECONNRESET', ERR_HTTP2_SERVER_REFUSED_STREAM: 'ECONNRESET',
  ERR_CONNECTION_REFUSED: 'ECONNREFUSED', ERR_NAME_NOT_RESOLVED: 'ENOTFOUND', ERR_NAME_RESOLUTION_FAILED: 'ENOTFOUND',
  ERR_INTERNET_DISCONNECTED: 'ENETUNREACH', ERR_ADDRESS_UNREACHABLE: 'EHOSTUNREACH',
  ERR_CONNECTION_TIMED_OUT: 'ETIMEDOUT', ERR_TIMED_OUT: 'ETIMEDOUT', ERR_SSL_PROTOCOL_ERROR: 'EPROTO',
};
function mapNetError(e) {
  const m = /net::(ERR_[A-Z0-9_]+)/.exec((e && e.message) || '');
  if (!m && e && e.code) return e;
  const k = m ? m[1] : '';
  const code = NET_ERR[k] || (/^ERR_(CERT|SSL)/.test(k) ? 'EPROTO' : k || 'ECONNRESET');
  return Object.assign(new Error((e && e.message) || 'network error'), { code });
}

/** خطوة واحدة (بلا اتباع التحويلات) عبر Chromium. تعيد { req, ready } كما في hopNode */
function hopChromium(parsed, { method, headers, lane }) {
  const creq = enet.request({
    method, url: parsed.toString(), session: laneSession(lane == null ? laneRR++ : lane),
    useSessionCookies: false, credentials: 'omit', redirect: 'manual', cache: 'no-store',
  });
  let out = null; let finished = false;
  const abort = () => { if (!finished) { finished = true; try { creq.abort(); } catch { /* ignore */ } } };
  const req = {
    destroy(err) {
      abort();
      if (out && !out.destroyed) out.destroy(err || Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    },
  };
  const ready = new Promise((resolve, reject) => {
    for (const [k, v] of Object.entries(headers)) {
      const key = /^referer$/i.test(k) ? 'X-Barq-Referer' : k;
      try { creq.setHeader(key, v); } catch { /* ترويسة لا يقبلها Chromium */ }
    }
    creq.on('redirect', (_status, _method, location) => { abort(); resolve({ redirect: location }); });
    creq.on('error', (e) => { finished = true; const err = mapNetError(e); if (out) out.destroy(err); else reject(err); });
    creq.on('response', (r) => {
      out = new PassThrough({ highWaterMark: 1 << 20 });
      const hdrs = {};
      for (const [k, v] of Object.entries(r.headers || {})) hdrs[k.toLowerCase()] = Array.isArray(v) && k.toLowerCase() !== 'set-cookie' ? v.join(', ') : v;
      out.statusCode = r.statusCode; out.statusMessage = r.statusMessage; out.headers = hdrs; out.httpVersion = r.httpVersion;
      let idle = null;
      out.setTimeout = (ms, cb) => {
        const arm = () => { clearTimeout(idle); idle = setTimeout(cb, ms); };
        r.on('data', arm); arm();
        return out;
      };
      r.on('end', () => { finished = true; clearTimeout(idle); });
      r.on('error', (e) => { clearTimeout(idle); out.destroy(mapNetError(e)); });
      r.on('aborted', () => { clearTimeout(idle); if (!out.writableEnded) out.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); });
      out.on('close', () => { clearTimeout(idle); if (!out.writableEnded) abort(); });
      r.pipe(out);
      resolve({ res: out });
    });
    creq.end();
  });
  return { req, ready };
}

/** خطوة واحدة عبر وحدة http في Node (HTTP/1.1 باتصالات متعددة) */
function hopNode(parsed, { method, headers }) {
  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.request(parsed, { method, headers, agent: agents[parsed.protocol] });
  const ready = new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      resolve({ res });
    });
  });
  req.end();
  return { req, ready };
}

/* ------------------------------------------------------------------ *
 * اختيار المحرك والبدائل
 * ------------------------------------------------------------------ */
let getEngine = () => 'auto';   // 'auto' = Node أولاً | 'chromium' = Chromium (HTTP/2/HTTP/3) أولاً
function configure({ engine } = {}) { if (typeof engine === 'function') getEngine = engine; }

/** ما يتذكره البرنامج عن كل خادم: المحرك/الهوية التي نجحت بعد أن رُفضت المحاولة الأولى (6 ساعات) */
const hostPrefs = new Map();
const PREF_MS = 6 * 3600 * 1000;
function hostPref(host) { const p = hostPrefs.get(host); if (p && p.exp > Date.now()) return p; hostPrefs.delete(host); return null; }

/** رفض يدل على «الخادم لا يقبل هذه الطريقة» لا على عطل: يستحق تجربة بديل (المهلات وأخطاء DNS لا) */
function blockedError(e) {
  if (!e || e.code === 'ABORTED') return false;
  return ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'EPROTO'].includes(e.code) || /socket hang up|ssl|tls/i.test(e.message || '');
}

function variantsFor(host, headers, transport) {
  const chromium = chromiumAvailable();
  if (transport === 'node' || transport === 'chromium') return [{ t: transport === 'chromium' && chromium ? 'chromium' : 'node' }];
  const callerUA = Object.keys(headers).some(k => /^user-agent$/i.test(k));
  let list = getEngine() === 'chromium' && chromium
    ? [{ t: 'chromium' }, { t: 'node' }, { t: 'node', ua: HONEST_UA }]
    : [{ t: 'node' }, { t: 'node', ua: HONEST_UA }, ...(chromium ? [{ t: 'chromium' }] : [])];
  if (callerUA) list = list.filter(v => !v.ua);   // هوية حددها المستخدم أو المتصفح لا نستبدلها
  const pref = hostPref(host);
  if (pref) list = [pref, ...list.filter(v => v.t !== pref.t || (v.ua || '') !== (pref.ua || ''))];
  return list;
}

/**
 * طلب HTTP يتبع التحويلات (حتى 10) ويُرجع الاستجابة قبل قراءة الجسم.
 *  - transport: 'node' | 'chromium' لمحرك محدد، أو بدونه للاختيار التلقائي مع البدائل:
 *    إن قطع الخادم الاتصال أو رد 403 تُجرَّب هوية برنامج صريحة ثم محرك Chromium، ويُتذكَّر ما نجح لهذا الخادم.
 *  - lane: رقم المسار في محرك Chromium (لكل اتصال تنزيل مساره)
 * @returns {Promise<{res, req, url, transport, userAgent}>}
 */
async function request(url, opts = {}) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* يُرفض في requestOnce */ }
  const variants = variantsFor(host, opts.headers || {}, opts.transport);
  let lastErr = null; let held = null;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (opts.signal && opts.signal.aborted) break;
    const headers = v.ua ? { ...opts.headers, 'User-Agent': v.ua } : opts.headers;
    try {
      const r = await requestOnce(url, { ...opts, headers, transport: v.t });
      if (r.res.statusCode === 403 && i < variants.length - 1) {
        if (held) held.res.destroy();
        held = { ...r, transport: v.t, userAgent: v.ua || '' };   // إن رفضت كل البدائل يُعاد هذا الرد
        continue;
      }
      if (r.res.statusCode === 403 && held) { r.res.destroy(); return held; }
      if (held) { held.res.destroy(); held = null; }
      if (i > 0 && r.res.statusCode < 400 && host) hostPrefs.set(host, { t: v.t, ua: v.ua, exp: Date.now() + PREF_MS });
      return { ...r, transport: v.t, userAgent: v.ua || '' };
    } catch (e) {
      lastErr = e;
      if (!blockedError(e)) break;
    }
  }
  if (held) return held;
  throw lastErr || Object.assign(new Error('aborted'), { code: 'ABORTED' });
}

function requestOnce(url, { method = 'GET', headers = {}, timeout = 30000, maxRedirects = 10, signal, transport = 'node', lane } = {}) {
  const useChromium = transport === 'chromium' && chromiumAvailable();
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let firstHost = '';
    const site = (hn) => hn.split('.').slice(-2).join('.');
    const go = (u) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error('Invalid URL: ' + u)); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return reject(new Error('Unsupported protocol: ' + parsed.protocol));
      const h = { 'User-Agent': DEFAULT_UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...clean(headers) };
      // عند التحويل إلى خادم آخر لا نرسل بيانات الدخول إليه (كما تفعل المتصفحات)
      if (!firstHost) firstHost = parsed.hostname;
      else if (parsed.hostname !== firstHost) {
        for (const k of Object.keys(h)) {
          if (/^authorization$/i.test(k) || (/^cookie$/i.test(k) && site(parsed.hostname) !== site(firstHost))) delete h[k];
        }
      }
      const { req, ready } = (useChromium ? hopChromium : hopNode)(parsed, { method, headers: h, lane });
      let done = false;
      // مستمع الإيقاف يُزال حين ينتهي الطلب: الإشارة نفسها مشتركة بين كل مقاطع التنزيل،
      // وتركه كان يراكم مستمعاً (يمسك الطلب في الذاكرة) لكل مقطع حتى ينتهي التنزيل كله.
      let onAbort = null;
      const unlisten = () => { if (onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; } };
      let timer = null;
      const fail = (e) => { if (!done) { done = true; clearTimeout(timer); unlisten(); req.destroy(); reject(e); } };
      timer = setTimeout(() => fail(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })), timeout);
      if (signal) {
        if (signal.aborted) return fail(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        onAbort = () => fail(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      ready.then((r) => {
        if (done) { if (r.res) r.res.destroy(); return; }
        if (r.redirect) {
          if (++redirects > maxRedirects) return fail(new Error('Too many redirects'));
          done = true; clearTimeout(timer); unlisten();
          return go(new URL(r.redirect, u).toString());
        }
        done = true; clearTimeout(timer); unlisten();
        const res = r.res;
        // الإيقاف أثناء قراءة الجسم: يُغلق الاستجابة ويُزال المستمع عند انتهائها
        if (signal) {
          const onBodyAbort = () => res.destroy(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
          signal.addEventListener('abort', onBodyAbort, { once: true });
          res.once('close', () => signal.removeEventListener('abort', onBodyAbort));
        }
        // مهلة القراءة: إن توقف الخادم عن الإرسال
        res.setTimeout?.(timeout, () => res.destroy(Object.assign(new Error('Read timed out'), { code: 'ETIMEDOUT' })));
        resolve({ res, req, url: u });
      }, fail);
    };
    go(url);
  });
}

function clean(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (v != null && v !== '') out[k] = String(v);
  return out;
}

/** ترويسة Retry-After (ثوانٍ أو تاريخ) بالملّي ثانية، أو 0 */
function retryAfterMs(v) {
  if (v == null || v === '') return 0;
  const s = Number(v);
  if (isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

async function fetchBuffer(url, opts = {}) {
  const { res } = await request(url, opts);
  if (res.statusCode >= 400) { res.resume(); throw Object.assign(new HttpError(res.statusCode), { retryAfter: retryAfterMs(res.headers['retry-after']) }); }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = {
  request, fetchBuffer, HttpError, DEFAULT_UA, HONEST_UA, configure, enableChromium, chromiumAvailable, retryAfterMs,
  _hostPrefs: hostPrefs,
};
