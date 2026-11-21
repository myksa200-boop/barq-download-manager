// يشغّل background.js الحقيقي للإضافة داخل vm مقابل الجسر الحقيقي:
// تنزيل من موقع يرفض برق يبقى في المتصفح، وتنزيل عادي يُلغى في المتصفح ويُرسل إلى البرنامج.
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const { startBridge } = require(path.join(ROOT, 'src', 'main', 'bridge.js'));
const { Manager } = require(path.join(ROOT, 'src', 'main', 'manager.js'));
const VERSION = require(path.join(ROOT, 'package.json')).version;

const site = http.createServer((req, res) => {
  if (req.url === '/wall.mp3') { res.writeHead(403, { 'Content-Type': 'text/html', Server: 'cloudflare', 'cf-mitigated': 'challenge' }); return res.end('Just a moment...'); }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 5 }); res.end('12345');
});

function makeBrowser(store, calls) {
  const ev = () => { const l = []; return { addListener: (f) => l.push(f), fire: (...a) => Promise.all(l.map((f) => f(...a))) }; };
  const log = (name, ret) => (...a) => { calls.push([name, ...a]); return Promise.resolve(typeof ret === 'function' ? ret(...a) : ret); };
  return {
    storage: { local: { get: async () => ({ ...store }), set: async (o) => { Object.assign(store, o); } }, onChanged: ev() },
    runtime: { getManifest: () => ({ version: VERSION }), onStartup: ev(), onInstalled: ev(), onMessage: ev(), reload: log('reload') },
    alarms: { create() {}, onAlarm: ev() },
    downloads: { onCreated: ev(), pause: log('pause'), resume: log('resume'), cancel: log('cancel'), erase: log('erase'), download: log('download') },
    contextMenus: { removeAll() {}, create() {}, onClicked: ev() },
    webRequest: { onSendHeaders: ev(), onHeadersReceived: ev() },
    tabs: { onUpdated: ev(), onRemoved: ev(), sendMessage: async () => null },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    cookies: { getAll: async () => [{ name: 'sid', value: 'abc' }] },
  };
}

(async () => {
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const S = `http://127.0.0.1:${site.address().port}`;
  const token = 'a'.repeat(48); const clientId = 'b'.repeat(32);
  const added = []; const checks = [];
  const fake = { _auth: () => null };
  let nextPort = 46980;                                  // منفذ جديد لكل مشهد، بعيداً عن برق المثبّت (46321)
  const start = (withCheck) => startBridge({
    port: (nextPort += 10), version: VERSION, onAdd: (items) => added.push(...items),
    getConfig: () => ({ captureExts: 'mp3 zip', enabled: true }),
    onCheck: withCheck ? (d) => { checks.push(d); return Manager.prototype.precheck.call(fake, d); } : undefined,
    auth: { tokenFor: (c) => (c === clientId ? token : null), requestPair: () => ({ status: 'denied' }) },
  });

  async function scenario(withCheck, url) {
    const br = await start(withCheck);
    const calls = []; const store = { clientId, pairKey: 'c'.repeat(64), token, port: br.port };
    const B = makeBrowser(store, calls);
    const timers = [];
    const ctx = vm.createContext({
      chrome: B, navigator: { userAgent: 'Mozilla/5.0 Test Chrome/156' }, crypto: globalThis.crypto, fetch, URL, TextEncoder, AbortController,
      console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout, Promise,
      setInterval: (f, ms) => { const t = setInterval(f, ms); timers.push(t); return t; },
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8'), ctx);
    await new Promise((r) => setTimeout(r, 400));      // تحميل الإعدادات واكتشاف البرنامج
    await B.downloads.onCreated.fire({ id: 7, state: 'in_progress', url, finalUrl: url, referrer: 'https://example.org/', filename: 'C:\\Users\\x\\Downloads\\audio.mp3', mime: 'audio/mpeg' });
    timers.forEach(clearInterval);
    await new Promise((r) => br.server.close(r));
    return calls.map((c) => c[0]);
  }

  // 1) موقع يرفض برق: إيقاف مؤقت ثم استئناف — لا إلغاء ولا إرسال للبرنامج
  let names = await scenario(true, S + '/wall.mp3');
  assert.deepStrictEqual(names, ['pause', 'resume']);
  assert.strictEqual(added.length, 0);
  assert.strictEqual(checks.length, 1);
  assert.strictEqual(checks[0].cookies, 'sid=abc');
  assert.strictEqual(checks[0].referer, 'https://example.org/');

  // 2) ملف عادي: يُلغى في المتصفح ويصل إلى البرنامج
  names = await scenario(true, S + '/ok.mp3');
  assert.deepStrictEqual(names, ['pause', 'cancel', 'erase']);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].url, S + '/ok.mp3');
  assert.strictEqual(added[0].fileName, 'audio.mp3');

  // 3) برنامج أقدم لا يعرف /check: السلوك القديم
  added.length = 0;
  names = await scenario(false, S + '/wall.mp3');
  assert.deepStrictEqual(names, ['pause', 'cancel', 'erase']);
  assert.strictEqual(added.length, 1);

  site.close(); site.closeAllConnections();
  console.log('extension: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
