'use strict';
const http = require('http');
const https = require('https');

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

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Barq/1.0';

/**
 * طلب HTTP يتبع التحويلات (حتى 10) ويُرجع الاستجابة قبل قراءة الجسم.
 * @returns {Promise<{res, req, url}>}
 */
function request(url, { method = 'GET', headers = {}, timeout = 30000, maxRedirects = 10, signal } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (u) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error('Invalid URL: ' + u)); }
      const mod = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!mod) return reject(new Error('Unsupported protocol: ' + parsed.protocol));
      const h = { 'User-Agent': DEFAULT_UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...clean(headers) };
      const req = mod.request(parsed, { method, headers: h, agent: agents[parsed.protocol] });
      let done = false;
      const fail = (e) => { if (!done) { done = true; req.destroy(); reject(e); } };
      req.setTimeout(timeout, () => fail(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', fail);
      if (signal) {
        if (signal.aborted) return fail(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        signal.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
      }
      req.on('response', (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (++redirects > maxRedirects) return fail(new Error('Too many redirects'));
          done = true;
          return go(new URL(res.headers.location, u).toString());
        }
        done = true;
        // مهلة القراءة: إن توقف الخادم عن الإرسال
        res.setTimeout?.(timeout, () => res.destroy(Object.assign(new Error('Read timed out'), { code: 'ETIMEDOUT' })));
        resolve({ res, req, url: u });
      });
      req.end();
    };
    go(url);
  });
}

function clean(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (v != null && v !== '') out[k] = String(v);
  return out;
}

async function fetchBuffer(url, opts = {}) {
  const { res } = await request(url, opts);
  if (res.statusCode >= 400) { res.resume(); throw new HttpError(res.statusCode); }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

module.exports = { request, fetchBuffer, HttpError, DEFAULT_UA };
