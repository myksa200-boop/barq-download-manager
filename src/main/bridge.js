'use strict';
/**
 * جسر المتصفح: خادم HTTP محلي على 127.0.0.1 تستقبل منه إضافة المتصفح الروابط
 * مع الكوكيز والـ Referer والـ User-Agent.
 * الحماية: لا يقبل إلا طلبات بدون Origin (برامج محلية) أو من إضافات المتصفح
 * (chrome-extension:// / moz-extension://) — صفحات الويب لا تستطيع إضافة تنزيلات.
 */
const http = require('http');

function startBridge({ port, onAdd, getConfig, version, onPing }) {
  const makeServer = () => http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const allowed = !origin || /^(chrome|moz|edge|safari-web)-extension:\/\//i.test(origin);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (origin && allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    }
    const reply = (code, obj) => { res.writeHead(code, headers); res.end(JSON.stringify(obj)); };
    if (!allowed) return reply(403, { error: 'forbidden origin' });
    if (req.method === 'OPTIONS') return reply(204, {});

    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/ping') {
      // الإضافة تعرّف نفسها بـ b (المتصفح) و v (إصدارها)؛ Chrome لا يرسل Origin مع طلبات GET من الإضافات
      const b = url.searchParams.get('b') || ''; const v = url.searchParams.get('v') || '';
      if (onPing && (origin || (b && v))) onPing({ origin: origin || `${b}|${req.headers['user-agent'] || ''}`, browser: b, ext: v, ua: req.headers['user-agent'] || '' });
      return reply(200, { app: 'Barq', id: 'barq-dm', version });
    }
    if (req.method === 'GET' && req.url === '/config') return reply(200, getConfig());

    if (req.method === 'POST' && (req.url === '/download' || req.url === '/batch')) {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 4e6) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const items = req.url === '/batch' ? (data.items || []) : [data];
          const ok = items.filter(it => /^https?:\/\//i.test(it.url || ''));
          if (!ok.length) return reply(400, { error: 'no valid url' });
          onAdd(ok, req.url === '/batch');
          reply(200, { ok: true, count: ok.length });
        } catch (e) { reply(400, { error: e.message }); }
      });
      return;
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

module.exports = { startBridge };
