/* Chrome / Edge / Brave / Opera / Vivaldi: chrome.*  —  Firefox: browser.* */
const B = globalThis.browser ?? globalThis.chrome;
/* Barq — service worker
 * 1) اعتراض تنزيلات المتصفح حسب الامتدادات المحددة في البرنامج وإرسالها مع الكوكيز والمُحيل
 * 2) قائمة السياق: تنزيل الرابط / كل الروابط / الفيديو
 * 3) رصد طلبات الوسائط (MP4, WEBM, HLS m3u8, صوت) لكل تبويب لعرضها في لوحة الفيديو العائمة
 */
const DEFAULTS = { port: 46321, intercept: true, panel: true, minSizeKB: 300 };
/* بعد تثبيت/تحديث الإضافة: حدّث أي صفحات مفتوحة لاحقاً تلقائياً عبر content scripts الجديدة */
let cfg = { ...DEFAULTS };
let appConfig = { captureExts: '', enabled: false };
let appAlive = false;
const media = new Map();   // tabId -> [{url, mime, size, kind, label}]
const skip = new Set();    // روابط نسمح للمتصفح بتنزيلها (عند تعذر الاتصال بالبرنامج)

/* الاقتران مع البرنامج: معرّف هذه النسخة من الإضافة + رمز سري يمنحه البرنامج بعد موافقة المستخدم.
   يُحفظان في storage.local (وليس في cfg حتى لا يصلا إلى النافذة المنبثقة أو الصفحات). */
let clientId = '';
let pairKey = '';          // مفتاح استلام الرمز: يثبت أن من يستلمه هو من طلبه، حتى بعد إعادة تشغيل الخدمة
let token = '';
let lastError = '';        // سبب آخر فشل (للتشخيص، يظهر في النافذة المنبثقة)
let trusted = false;       // البرنامج أثبت أنه يعرف الرمز (HMAC) — عندها فقط نرسل له الكوكيز
let pairState = '';        // '' | 'waiting' | 'denied' | 'oldapp'
let lastPairTry = 0;
const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}
const authHeaders = () => ({ 'X-Barq-Client': clientId, 'X-Barq-Token': token });

/* خدمة الخلفية في MV3 تُعاد من الصفر بعد الخمول: كل مستمع ينتظر تحميل الإعدادات أولاً */
const ready = (async () => {
  const v = await B.storage.local.get(null);
  for (const k of Object.keys(DEFAULTS)) if (v[k] !== undefined) cfg[k] = v[k];
  clientId = v.clientId || '';
  token = v.token || '';
  pairKey = v.pairKey || '';
  if (!/^[a-f0-9]{32,64}$/.test(clientId) || !/^[a-f0-9]{32,64}$/.test(pairKey)) {
    clientId = randHex(16); pairKey = randHex(32); token = '';
    await B.storage.local.set({ clientId, pairKey, token: '' });
  }
})().catch((e) => console.warn('Barq: settings load failed', e));
ready.then(() => refreshApp());
B.storage.onChanged.addListener((ch) => {
  let changed = false;
  for (const k in ch) if (k in DEFAULTS) { cfg[k] = ch[k].newValue ?? DEFAULTS[k]; changed = true; }
  if (changed) refreshApp();
});

/* اكتشاف البرنامج تلقائياً: المنفذ المحفوظ أولاً ثم 46321..46330
   (إذا كانت نسخة قديمة تحجز المنفذ الافتراضي، يعمل برق على المنفذ التالي) */
let activePort = null;
let appInfo = null;      // { app, version }
let oldApp = null;       // نسخة قديمة (Nazzil) تعمل على منفذ ما
const base = () => `http://127.0.0.1:${activePort || cfg.port}`;

const EXT_VERSION = B.runtime.getManifest().version;
function browserName() {
  const ua = navigator.userAgent;
  if (navigator.brave) return 'brave';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/YaBrowser\//.test(ua)) return 'yandex';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  return 'chrome';
}
async function ping(port) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 1200);
  try {
    const nonce = randHex(16);
    const r = await fetch(`http://127.0.0.1:${port}/ping?b=${browserName()}&v=${EXT_VERSION}&c=${clientId}&n=${nonce}`, { cache: 'no-store', signal: ctl.signal, targetAddressSpace: 'loopback' });
    const j = await r.json();
    // هل هذا برق نفسه؟ يثبت ذلك بتوقيع الـ nonce بالرمز الذي لا يعرفه غيره
    j.trusted = !!(token && j.proof && j.proof === await hmacHex(token, nonce));
    return j;
  } catch { return null; } finally { clearTimeout(tm); }
}
/** طلب الاقتران: يظهر للمستخدم سؤال داخل برنامج برق، وننتظر إجابته */
async function pair(port) {
  pairState = 'waiting';
  B.action.setBadgeText({ text: '?' }); B.action.setBadgeBackgroundColor({ color: '#d97706' });
  // البرنامج يرد فوراً: 202 ما دام السؤال معروضاً، 200 مع الرمز بعد الموافقة، 403 عند الرفض.
  // نسأل كل ثانيتين؛ وإن نامت الخدمة في الأثناء فأول فحص بعد استيقاظها يستلم الرمز بنفس pairKey.
  try {
    for (let i = 0; i < 90; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, targetAddressSpace: 'loopback',
        body: JSON.stringify({ clientId, pairKey, browser: browserName(), ext: EXT_VERSION }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && j.token) { token = j.token; await B.storage.local.set({ token }); pairState = ''; return true; }
      if (r.status !== 202) { lastError = 'pair HTTP ' + r.status; pairState = 'denied'; return false; }
      await new Promise((res) => setTimeout(res, 2000));
    }
    pairState = 'denied';
    return false;
  } catch (e) { lastError = 'pair ' + (e && e.message); pairState = 'denied'; return false; }
}
async function discover() {
  oldApp = null;
  const ports = [...new Set([activePort, cfg.port, ...Array.from({ length: 10 }, (_, i) => 46321 + i)].filter(Boolean))];
  for (const p of ports) {
    const j = await ping(p);
    if (!j) continue;
    if (/^barq/i.test(j.app || '')) { activePort = p; appInfo = j; return true; }
    if (/nazzil/i.test(j.app || '')) oldApp = { port: p, app: j.app };
  }
  activePort = null; appInfo = null;
  return false;
}

let pairing = null;        // طلب اقتران جارٍ (Promise<boolean>)
/** ينتظر انتهاء طلب الاقتران الجاري (إن وُجد) ثم يعيد الفحص */
async function settlePairing() { if (pairing) { await pairing; await refreshApp(); } }
let refreshing = null;
function refreshApp(opts) {
  // طلب واحد في كل مرة (المنبّه والمؤقت والنافذة المنبثقة قد تستدعيها معاً)
  if (!refreshing) refreshing = doRefresh(opts || {}).finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh({ forcePair = false } = {}) {
  await ready;
  try {
    const j = activePort ? await ping(activePort) : null;
    if (j && /^barq/i.test(j.app || '')) appInfo = j;           // نحدّث إصدار البرنامج في كل فحص
    else if (!(await discover())) throw new Error('not found');
    trusted = !!appInfo.trusted;
    if (!trusted) {
      if (!appInfo.auth) { pairState = 'oldapp'; throw new Error('app without pairing support'); }
      // غير مقترن (أو الرمز لم يعد صالحاً): نطلب الموافقة مرة، ثم لا نكرر إلا بعد 5 دقائق أو بطلب من المستخدم
      // الطلب يجري في الخلفية (ينتظر إجابة المستخدم) حتى لا تتجمد النافذة المنبثقة؛ عند الموافقة نعيد الفحص
      // إن كان لدينا رمز سابق والبرنامج لا يثبت معرفته به فقد يكون برنامجاً آخر يحجز المنفذ:
      // لا نقترن تلقائياً أبداً في هذه الحالة — فقط بطلب صريح من المستخدم في النافذة المنبثقة.
      if (token && !forcePair) pairState = 'mismatch';
      if (!pairing && (forcePair || (!token && Date.now() - lastPairTry > 300000))) {
        lastPairTry = Date.now();
        const port = activePort;
        pairing = pair(port).then((ok) => { pairing = null; if (ok) refreshApp(); return ok; }, () => { pairing = null; return false; });
      }
      throw new Error('not paired');
    }
    pairState = '';
    const r = await fetch(base() + '/config', { cache: 'no-store', headers: authHeaders(), targetAddressSpace: 'loopback' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    appConfig = await r.json();
    appAlive = true; lastError = '';
  } catch (e) { appAlive = false; lastError = String((e && e.message) || e); }
  // تحديث ذاتي: البرنامج يضع ملفات الإضافة الجديدة في نفس المجلد عند كل تحديث،
  // فإذا اختلف الإصدار نعيد تحميل الإضافة من القرص مرة واحدة لكل إصدار.
  if (appAlive && appInfo && appInfo.version && appInfo.version !== EXT_VERSION) {
    const { reloadedFor } = await B.storage.local.get('reloadedFor');
    if (reloadedFor !== appInfo.version) {
      await B.storage.local.set({ reloadedFor: appInfo.version });
      B.runtime.reload();
      return appAlive;
    }
  }
  const mismatch = appAlive && appInfo && appInfo.version && appInfo.version.split('.').slice(0, 2).join('.') !== EXT_VERSION.split('.').slice(0, 2).join('.');
  const needPair = !appAlive && appInfo && !trusted;
  B.action.setBadgeText({ text: needPair ? '?' : !appAlive ? '!' : mismatch ? '↻' : '' });
  B.action.setBadgeBackgroundColor({ color: mismatch || needPair ? '#d97706' : '#dc2626' });
  return appAlive;
}
setInterval(() => refreshApp(), 30000);
// خدمة الخلفية في MV3 تنام بعد 30 ثانية: منبّه يوقظها للتحقق من البرنامج وتحديث الإضافة
B.alarms.create('barq-check', { periodInMinutes: 0.5 });
B.alarms.onAlarm.addListener((a) => { if (a.name === 'barq-check') refreshApp(); });
B.runtime.onStartup.addListener(() => refreshApp());
let lastCheck = 0;
function maybeRefresh() { if (Date.now() - lastCheck > 15000) { lastCheck = Date.now(); refreshApp(); } }

async function cookiesFor(url) {
  try {
    const list = await B.cookies.getAll({ url });
    return list.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

async function sendToApp(items, batch = false) {
  const full = [];
  for (const it of items) {
    full.push({ ...it, cookies: it.cookies ?? await cookiesFor(it.url), userAgent: navigator.userAgent });
  }
  await ready;
  if (!activePort || !trusted) { await refreshApp({ forcePair: !token }); if (!trusted) await settlePairing(); }
  // الكوكيز وترويسات الدخول لا تُرسل إلا لبرنامج أثبت هويته
  if (!activePort || !trusted) throw new Error(pairState === 'waiting' || pairState === 'denied' ? 'not paired' : 'not connected');
  const post = () => fetch(base() + (batch ? '/batch' : '/download'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, targetAddressSpace: 'loopback',
    body: JSON.stringify(batch ? { items: full } : full[0]),
  });
  const r = await post();
  if (r.status === 401) { trusted = false; pairState = 'mismatch'; throw new Error('not paired'); }   // الرمز أُلغي من البرنامج
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function extOf(s) {
  try { s = new URL(s).pathname; } catch { /* ignore */ }
  const m = /\.([a-z0-9]{1,6})$/i.exec(s || '');
  return m ? m[1].toLowerCase() : '';
}
function wanted(url, filename, mime) {
  const exts = String(appConfig.captureExts || '').toLowerCase().split(/\s+/).filter(Boolean);
  const e = extOf(filename || '') || extOf(url);
  if (e && exts.includes(e)) return true;
  if (/^(video|audio)\//i.test(mime || '') || /(zip|rar|7z|octet-stream|x-msdownload|iso9660|x-msi)/i.test(mime || '')) return true;
  return false;
}

/* ---------- 1) intercept browser downloads ---------- */
B.downloads.onCreated.addListener(async (item) => {
  await ready;                     // إعداد «اعتراض التنزيلات» قد لا يكون حُمّل بعد استيقاظ الخدمة
  if (!cfg.intercept || item.state !== 'in_progress') return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url) || skip.has(url)) { skip.delete(url); return; }
  if (!wanted(url, item.filename, item.mime)) return;
  if (!appAlive && !(await refreshApp())) return;          // البرنامج غير مشغّل: اترك المتصفح يكمل
  if (!appConfig.enabled) return;
  try {
    await B.downloads.cancel(item.id);
    await B.downloads.erase({ id: item.id });
    await sendToApp([{ url, referer: item.referrer || '', fileName: (item.filename || '').split(/[\\/]/).pop(), mime: item.mime || '' }]);
  } catch (e) {
    console.warn('Barq: falling back to browser download', e);
    skip.add(url);
    B.downloads.download({ url });
  }
});

/* ---------- 2) context menus ---------- */
B.runtime.onInstalled.addListener(() => {
  B.contextMenus.removeAll(() => {
    B.contextMenus.create({ id: 'nz-link', title: 'تنزيل باستخدام برق', contexts: ['link'] });
    B.contextMenus.create({ id: 'nz-media', title: 'تنزيل الوسائط باستخدام برق', contexts: ['video', 'audio', 'image'] });
    B.contextMenus.create({ id: 'nz-page', title: 'تنزيل فيديو هذه الصفحة باستخدام برق', contexts: ['page', 'video'] });
    B.contextMenus.create({ id: 'nz-all', title: 'تنزيل كل الروابط باستخدام برق', contexts: ['page', 'selection'] });
  });
});
B.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'nz-link') await sendToApp([{ url: info.linkUrl, referer: info.pageUrl || '' }]);
    else if (info.menuItemId === 'nz-page') await sendToApp([{ url: info.frameUrl || info.pageUrl || tab.url, referer: tab.url || '', kind: 'ytdlp' }]);
    else if (info.menuItemId === 'nz-media') {
      const src = info.srcUrl || '';
      if (/^https?:/i.test(src)) await sendToApp([{ url: src, referer: info.pageUrl || '' }]);
      else { const list = media.get(tab.id) || []; if (list[0]) await sendToApp([{ url: list[0].url, referer: info.pageUrl || '', kind: list[0].kind }]); }
    } else if (info.menuItemId === 'nz-all') {
      const links = await B.tabs.sendMessage(tab.id, { type: 'collectLinks', selection: info.menuItemId === 'nz-all' && !!info.selectionText }, { frameId: info.frameId || 0 });
      if (links && links.length) await sendToApp(links.map(u => ({ url: u, referer: tab.url })), true);
    }
  } catch (e) {
    notifyTab(tab?.id, connectError(e));
  }
});
function connectError(e) {
  if (pairState === 'mismatch') return 'برنامج برق لم يتعرّف على هذه الإضافة — افتح نافذة الإضافة واضغط «طلب الاتصال»';
  if (e && e.message === 'not paired') return 'وافق على طلب الاتصال في نافذة برنامج برق ثم أعد المحاولة';
  if (pairState === 'oldapp') return 'نسخة برنامج برق قديمة — حدّث البرنامج';
  // السبب التقني بين قوسين يساعد على التشخيص (مثلاً: not found = البرنامج غير مشغّل)
  const why = String((e && e.message) || lastError || '').slice(0, 60);
  return 'تعذر الاتصال ببرنامج برق — تأكد أنه يعمل' + (why ? ` (${why})` : '');
}
function notifyTab(tabId, msg) { if (tabId != null) B.tabs.sendMessage(tabId, { type: 'toast', msg }, { frameId: 0 }).catch(() => {}); }

/* ---------- 3) media sniffing ---------- */
/* مواقع تستخدم بثاً مجزأً بروابط موقّعة لا يمكن تنزيله مباشرة */
// googlevideo: مقاطع YouTube الجزئية — YouTube نفسه يُنزَّل عبر رابط الصفحة (yt-dlp)
const UNSUPPORTED_HOSTS = /(^|\.)(googlevideo\.com|youtube\.com|ytimg\.com|netflix\.com|nflxvideo\.net|disneyplus\.com|primevideo\.com)$/i;

function classify(url, mime, size) {
  const u = url.toLowerCase();
  mime = (mime || '').toLowerCase();
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  if (UNSUPPORTED_HOSTS.test(host)) return null;
  if (/mpegurl/.test(mime) || /\.m3u8(\?|$)/.test(u)) return { kind: 'hls', label: 'HLS' };
  if (/dash\+xml/.test(mime) || /\.mpd(\?|$)/.test(u)) return { kind: 'dash', label: 'DASH' };
  if (/\.(ts|m4s|m4f|cmfv|cmfa|aac|vtt|srt)(\?|$)/.test(u) || /mp2t|iso.segment|text\/vtt/.test(mime)) return null; // مقاطع جزئية/ترجمات
  if (/[?&](range|bytestart|byterange|sq)=/.test(u)) return null;
  if (/^video\//.test(mime) || /\.(mp4|webm|mkv|mov|m4v|flv|avi|wmv|3gp)(\?|$)/.test(u)) {
    if (size >= 0 && size < cfg.minSizeKB * 1024) return null;
    return { kind: 'http', label: (extOf(u) || mime.split('/')[1] || 'video').toUpperCase() };
  }
  if (/^audio\//.test(mime) || /\.(mp3|m4a|ogg|opus|wav|flac|aac|wma)(\?|$)/.test(u)) {
    if (size >= 0 && size < 100 * 1024) return null;
    return { kind: 'http', label: 'Audio ' + (extOf(u) || mime.split('/')[1]).toUpperCase() };
  }
  // ملفات تنزيل يُستدعى بعضها عبر XHR (application/octet-stream مع Content-Disposition)
  return null;
}

/* ترويسات الطلب الأصلية لكل رابط وسائط: بعض المواقع ترفض الطلب بدون Origin أو Authorization أو ترويسات خاصة */
const reqHeaders = new Map();
const KEEP = /^(origin|referer|authorization|x-[\w-]+|user-agent|accept-language)$/i;
try {
  const extra = B.webRequest.OnSendHeadersOptions && B.webRequest.OnSendHeadersOptions.EXTRA_HEADERS ? ['requestHeaders', 'extraHeaders'] : ['requestHeaders'];
  B.webRequest.onSendHeaders.addListener((d) => {
    if (d.tabId < 0) return;
    const h = {};
    for (const x of d.requestHeaders || []) if (KEEP.test(x.name)) h[x.name] = x.value;
    if (Object.keys(h).length) {
      reqHeaders.set(d.url.split('#')[0], h);
      if (reqHeaders.size > 400) reqHeaders.delete(reqHeaders.keys().next().value);
    }
  }, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, extra);
} catch (e) { console.warn('Barq: header capture unavailable', e); }

const SOCIAL_RE = /^https?:\/\/([\w-]+\.)*(x\.com|twitter\.com|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|reddit\.com|threads\.net|threads\.com|snapchat\.com|linkedin\.com|pinterest\.[a-z.]+)(\/|$)/i;
function addMedia(tabId, item) {
  const list = media.get(tabId) || [];
  if (list.some(x => x.url === item.url)) return;
  list.unshift(item);
  if (list.length > 40) list.pop();
  media.set(tabId, list);
  B.tabs.sendMessage(tabId, { type: 'media', items: list }).catch(() => {});
  // مواقع التواصل: الملفات الملتقطة تخص كل منشورات الصفحة، فلا نعرض عدداً مربكاً على الأيقونة
  if (SOCIAL_RE.test(item.page || '')) return;
  B.action.setBadgeText({ tabId, text: String(list.length) }).catch?.(() => {});
  B.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch?.(() => {});
}

B.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const hdr = (n) => (d.responseHeaders || []).find(x => x.name.toLowerCase() === n)?.value || '';
  const mime = hdr('content-type').split(';')[0];
  let size = -1;
  const cr = /\/(\d+)$/.exec(hdr('content-range'));
  if (cr) size = Number(cr[1]); else if (hdr('content-length')) size = Number(hdr('content-length'));
  const c = classify(d.url, mime, size);
  if (!c) return;
  addMedia(d.tabId, { url: d.url.split('#')[0], mime, size, frame: d.frameId, page: d.initiator || d.documentUrl || '', ...c });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame'] }, ['responseHeaders']);

B.tabs.onUpdated.addListener((tabId, ch) => { if (ch.url) { media.delete(tabId); B.action.setBadgeText({ tabId, text: '' }).catch?.(() => {}); B.tabs.sendMessage(tabId, { type: 'media', items: [] }).catch(() => {}); } });
B.tabs.onRemoved.addListener((tabId) => media.delete(tabId));

function statusNow() {
  return { alive: appAlive, enabled: appConfig.enabled, cfg, port: activePort, appVersion: appInfo?.version || '', extVersion: EXT_VERSION, oldApp,
    found: !!appInfo, paired: trusted, pairState, lastError };
}

/* ---------- messages from content script / popup ---------- */
B.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'getMedia': maybeRefresh(); return { items: media.get(tabId) || [], panel: cfg.panel, alive: appAlive };
      case 'pageMedia': for (const it of msg.items || []) { const c = classify(it.url, it.mime || '', -1) || (it.kind ? { kind: it.kind, label: it.label } : null); if (c) addMedia(tabId, { url: it.url, mime: it.mime || '', size: -1, ...c, label: c.label }); } return { ok: true };
      case 'download':
        try { await sendToApp([{ url: msg.url, referer: msg.referer || sender.tab?.url || '', fileName: msg.fileName || '', kind: msg.kind || '', headers: reqHeaders.get(msg.url) || undefined }]); return { ok: true }; }
        catch (e) { return { ok: false, error: connectError(e) }; }
      case 'batch':
        try { await sendToApp(msg.urls.map(u => ({ url: u, referer: msg.referer || '' })), true); return { ok: true }; }
        catch (e) { return { ok: false, error: connectError(e) }; }
      case 'status': await refreshApp(); return statusNow();
      case 'pair': await refreshApp({ forcePair: true }); return statusNow();
      default: return null;
    }
  })().then(reply, () => reply(null));
  return true;
});
