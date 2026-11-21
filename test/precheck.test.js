// الفحص المسبق: خادم محلي يقلّد موقعاً يرفض برامج التنزيل، ثم المسار الحقيقي /check في الجسر
const http = require('http');
const assert = require('assert');
const path = require('path');
const main = (f) => require(path.join(__dirname, '..', 'src', 'main', f));
const { probe, friendlyError } = main('engine.js');
const { Manager } = main('manager.js');
const { startBridge } = main('bridge.js');

const site = http.createServer((req, res) => {
  if (req.url === '/file.mp3') { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 5 }); return res.end('12345'); }
  if (req.url === '/wall') { res.writeHead(403, { 'Content-Type': 'text/html; charset=UTF-8', Server: 'cloudflare', 'cf-mitigated': 'challenge' }); return res.end('<title>Just a moment...</title>'); }
  if (req.url === '/wall2') { res.writeHead(403, { 'Content-Type': 'text/html', Server: 'cloudflare' }); return res.end('blocked'); }
  if (req.url === '/expired') { res.writeHead(403, { 'Content-Type': 'application/xml' }); return res.end('<Error/>'); }
  if (req.url === '/gone') { res.writeHead(404); return res.end(); }
  if (req.url === '/slow') return;                      // لا يرد أبداً
  res.writeHead(500); res.end();
});

(async () => {
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const S = `http://127.0.0.1:${site.address().port}`;
  const m = { _auth: () => null };
  const pre = (u, extra) => Manager.prototype.precheck.call(m, { url: S + u, ...extra });

  const e1 = await probe(S + '/wall').catch((e) => e);
  assert.strictEqual(e1.status, 403); assert.strictEqual(e1.botwall, true);
  assert.match(friendlyError(e1), /للمتصفح نفسه/);
  const e2 = await probe(S + '/expired').catch((e) => e);
  assert.strictEqual(e2.botwall, false);
  assert.match(friendlyError(e2), /منتهي الصلاحية/);

  assert.deepStrictEqual(await pre('/file.mp3'), { ok: true });
  assert.deepStrictEqual(await pre('/wall'), { ok: false, status: 403, botwall: true });
  assert.deepStrictEqual(await pre('/wall2'), { ok: false, status: 403, botwall: true });
  assert.deepStrictEqual(await pre('/expired'), { ok: false, status: 403, botwall: false });
  assert.deepStrictEqual(await pre('/gone'), { ok: true });           // 404: يتابع برق كما كان ويعرض الخطأ
  assert.deepStrictEqual(await pre('/wall', { kind: 'ytdlp' }), { ok: true });
  assert.deepStrictEqual(await Manager.prototype.precheck.call(m, { url: 'https://www.youtube.com/watch?v=x' }), { ok: true });
  const t0 = Date.now();
  assert.deepStrictEqual(await pre('/slow'), { ok: true });           // مهلة: لا نحجز تنزيل المتصفح طويلاً
  assert.ok(Date.now() - t0 < 7500, 'precheck timeout');

  // الجسر: /check يتطلب الرمز، ويعيد حكم الفحص
  const token = 'a'.repeat(48); const cid = 'b'.repeat(32);
  const br = await startBridge({ port: 46990, version: 'test', onAdd() {}, getConfig: () => ({}), onCheck: (d) => Manager.prototype.precheck.call(m, d),
    auth: { tokenFor: (c) => (c === cid ? token : null), requestPair: () => ({ status: 'denied' }) } });
  const call = async (body, tok) => {
    const r = await fetch(`http://127.0.0.1:${br.port}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Barq-Client': cid, ...(tok ? { 'X-Barq-Token': tok } : {}) }, body: JSON.stringify(body) });
    return [r.status, await r.json()];
  };
  assert.strictEqual((await call({ url: S + '/wall' }))[0], 401);
  assert.strictEqual((await call({ url: S + '/wall' }, 'c'.repeat(48)))[0], 401);
  assert.deepStrictEqual(await call({ url: S + '/wall' }, token), [200, { ok: false, status: 403, botwall: true }]);
  assert.deepStrictEqual(await call({ url: S + '/file.mp3' }, token), [200, { ok: true }]);
  assert.strictEqual((await call({ url: 'file:///c:/x' }, token))[0], 400);
  br.server.close(); site.close(); site.closeAllConnections();
  console.log('precheck: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
