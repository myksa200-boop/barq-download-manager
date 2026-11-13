'use strict';
/**
 * جسر المتصفح: خادم HTTP محلي على 127.0.0.1 تستقبل منه إضافة المتصفح الروابط
 * مع الكوكيز والـ Referer والـ User-Agent.
 *
 * الحماية:
 *  1) صفحات الويب مرفوضة (Origin ليس إضافة متصفح) وكذلك الطلبات الموجهة لغير العنوان المحلي (DNS rebinding).
 *  2) الاقتران: كل نسخة من الإضافة لها معرّف (clientId) وتطلب /pair مرة واحدة؛ يوافق المستخدم في نافذة
 *     داخل البرنامج فتحصل على رمز سري. بدون الرمز لا يُقبل /config ولا /download ولا /batch،
 *     فلا يستطيع برنامج محلي آخر أو إضافة أخرى حقن تنزيلات.
 *  3) إثبات هوية البرنامج للإضافة: /ping يعيد HMAC(الرمز، nonce) فتتأكد الإضافة أنها تكلّم برق نفسه
 *     قبل أن ترسل له الكوكيز (برنامج آخر يحجز المنفذ لا يعرف الرمز).
 *
 * auth = { tokenFor(clientId) -> string|null,
 *          requestPair({clientId, pairKey, browser, ext, origin}) -> {status:'approved', token} | {status:'pending'} | {status:'denied'} }
 */
const http = require('http');
const crypto = require('crypto');

const EXT_ORIGIN = /^(chrome|moz|edge|safari-web)-extension:\/\//i;
const CLIENT_ID = /^[a-f0-9]{32,64}$/;

function proofOf(token, nonce) { return crypto.createHmac('sha256', String(token)).update(String(nonce)).digest('hex'); }
function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function startBridge({ port, onAdd, getConfig, version, onPing, auth, onLog }) {
  const makeServer = () => http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const allowed = !origin || EXT_ORIGIN.test(origin);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (origin && allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Barq-Client, X-Barq-Token';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    const reply = (code, obj) => {
      if (res.writableEnded) return;
      res.writeHead(code, headers); res.end(code === 204 ? undefined : JSON.stringify(obj));
      // سجل تشخيصي بلا أسرار: يكفي لمعرفة لماذا رُفض طلب إضافة
      if (onLog && req.method !== 'OPTIONS') {
        try {
          const u = new URL(req.url, 'http://x');
          const cid = String(req.headers['x-barq-client'] || u.searchParams.get('c') || '');
          onLog(`${req.method} ${u.pathname} -> ${code}${obj && obj.error ? ' ' + obj.error : ''} | client=${cid ? cid.slice(0, 6) : '-'} token=${req.headers['x-barq-token'] ? 'yes' : 'no'} origin=${origin ? origin.split('://')[0] : '-'} ext=${u.searchParams.get('v') || '-'}`);
        } catch { /* ignore */ }
      }
    };
    if (!allowed) return reply(403, { error: 'forbidden origin' });
    // الحماية من DNS rebinding: الطلب يجب أن يكون موجهاً إلى العنوان المحلي نفسه
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return reply(403, { error: 'forbidden host' });
    if (req.method === 'OPTIONS') return reply(204, {});

    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const clientId = String(req.headers['x-barq-client'] || url.searchParams.get('c') || '');
    const knownToken = auth && CLIENT_ID.test(clientId) ? auth.tokenFor(clientId) : null;
    const authorized = () => !auth || (knownToken && sameSecret(req.headers['x-barq-token'], knownToken));

    if (req.method === 'GET' && route === '/ping') {
      // الإضافة تعرّف نفسها بـ b (المتصفح) و v (إصدارها)؛ Chrome لا يرسل Origin مع طلبات GET من الإضافات
      const b = url.searchParams.get('b') || ''; const v = url.searchParams.get('v') || '';
      if (onPing && (origin || (b && v))) onPing({ origin: origin || `${b}|${req.headers['user-agent'] || ''}`, browser: b, ext: v, ua: req.headers['user-agent'] || '', paired: !!knownToken });
      const out = { app: 'Barq', id: 'barq-dm', version, auth: !!auth, paired: !!knownToken };
      const nonce = url.searchParams.get('n') || '';
      if (knownToken && /^[a-f0-9]{16,128}$/.test(nonce)) out.proof = proofOf(knownToken, nonce);
      return reply(200, out);
    }

    const readJson = (cb) => {
      let body = '';
      req.setEncoding('utf8');   // لا تنقسم الأحرف العربية بين جزأين
      req.on('data', d => { body += d; if (body.length > 4e6) req.destroy(); });
      req.on('end', () => { let data; try { data = JSON.parse(body || '{}'); } catch (e) { return reply(400, { error: e.message }); } cb(data && typeof data === 'object' ? data : {}); });
    };

    if (req.method === 'POST' && route === '/pair') {
      if (!auth) return reply(404, { error: 'not found' });
      // الاقتران للإضافات فقط: المتصفح نفسه هو من يضع Origin ولا يمكن لصفحة أو لبرنامج عادي عبر المتصفح تزويره
      if (!EXT_ORIGIN.test(origin)) return reply(403, { error: 'extension origin required' });
      return readJson((data) => {
        const id = String(data.clientId || '');
        const pairKey = String(data.pairKey || '');
        if (!CLIENT_ID.test(id) || !CLIENT_ID.test(pairKey)) return reply(400, { error: 'bad clientId' });
        // الرد فوري دائماً (لا نُبقي الطلب معلقاً حتى يجيب المستخدم): خدمة الإضافة في MV3 قد تنام أثناء الانتظار.
        // الإضافة تعيد السؤال كل ثانيتين، وتستلم الرمز بمفتاحها (pairKey) حتى لو أُعيد تشغيلها بعد الموافقة.
        Promise.resolve(auth.requestPair({ clientId: id, pairKey, browser: String(data.browser || '').slice(0, 30), ext: String(data.ext || '').slice(0, 20), origin }))
          .then((r) => {
            if (r && r.status === 'approved' && r.token) return reply(200, { ok: true, token: r.token });
            if (r && r.status === 'pending') return reply(202, { pending: true });
            reply(403, { error: 'denied' });
          })
          .catch(() => reply(403, { error: 'denied' }));
      });
    }

    if (req.method === 'GET' && route === '/config') {
      if (!authorized()) return reply(401, { error: 'unauthorized' });
      return reply(200, getConfig());
    }

    if (req.method === 'POST' && (route === '/download' || route === '/batch')) {
      if (!authorized()) { req.resume(); return reply(401, { error: 'unauthorized' }); }
      return readJson((data) => {
        try {
          const items = route === '/batch' ? (Array.isArray(data.items) ? data.items : []) : [data];
          const ok = items.filter(it => it && /^https?:\/\//i.test(it.url || ''));
          if (!ok.length) return reply(400, { error: 'no valid url' });
          onAdd(ok, route === '/batch');
          reply(200, { ok: true, count: ok.length });
        } catch (e) { reply(400, { error: e.message }); }
      });
    }
    reply(404, { error: 'not found' });
  });
  // إذا كان المنفذ محجوزاً (مثلاً نسخة قديمة تعمل) نجرّب المنافذ التالية حتى +9
  return new Promise((resolve) => {
    let p = port;
    const tryListen = () => {
      const server = makeServer();
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && p < port + 9) { p++; tryListen(); }
        else { console.error('[bridge]', e.message); resolve({ server: null, port: null, error: e.code || e.message }); }
      });
      server.listen(p, '127.0.0.1', () => resolve({ server, port: p, fallback: p !== port }));
    };
    tryListen();
  });
}

module.exports = { startBridge, proofOf };
