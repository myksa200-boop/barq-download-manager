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

B.storage.local.get(DEFAULTS, (v) => { cfg = { ...DEFAULTS, ...v }; refreshApp(); });
B.storage.onChanged.addListener((ch) => { for (const k in ch) cfg[k] = ch[k].newValue; refreshApp(); });

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
    const r = await fetch(`http://127.0.0.1:${port}/ping?b=${browserName()}&v=${EXT_VERSION}`, { cache: 'no-store', signal: ctl.signal, targetAddressSpace: 'loopback' });
    return await r.json();
  } catch { return null; } finally { clearTimeout(tm); }
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

async function refreshApp() {
  try {
    const j = activePort ? await ping(activePort) : null;
    if (j && /^barq/i.test(j.app || '')) appInfo = j;           // نحدّث إصدار البرنامج في كل فحص
    else if (!(await discover())) throw new Error('not found');
    const r = await fetch(base() + '/config', { cache: 'no-store', targetAddressSpace: 'loopback' });
    appConfig = await r.json();
    appAlive = true;
  } catch { appAlive = false; }
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
  B.action.setBadgeText({ text: !appAlive ? '!' : mismatch ? '↻' : '' });
  B.action.setBadgeBackgroundColor({ color: mismatch ? '#d97706' : '#dc2626' });
  return appAlive;
}
setInterval(refreshApp, 30000);
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
  if (!activePort) await refreshApp();
  const r = await fetch(base() + (batch ? '/batch' : '/download'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, targetAddressSpace: 'loopback',
    body: JSON.stringify(batch ? { items: full } : full[0]),
  });
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
      const links = await B.tabs.sendMessage(tab.id, { type: 'collectLinks', selection: info.menuItemId === 'nz-all' && !!info.selectionText });
      if (links && links.length) await sendToApp(links.map(u => ({ url: u, referer: tab.url })), true);
    }
  } catch (e) {
    notifyTab(tab?.id, 'تعذر الاتصال ببرنامج برق — تأكد أنه يعمل');
  }
});
function notifyTab(tabId, msg) { if (tabId != null) B.tabs.sendMessage(tabId, { type: 'toast', msg }).catch(() => {}); }

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

B.tabs.onUpdated.addListener((tabId, ch) => { if (ch.url) { media.delete(tabId); B.action.setBadgeText({ tabId, text: '' }).catch?.(() => {}); } });
B.tabs.onRemoved.addListener((tabId) => media.delete(tabId));

/* ---------- messages from content script / popup ---------- */
B.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'getMedia': maybeRefresh(); return { items: media.get(tabId) || [], panel: cfg.panel, alive: appAlive };
      case 'pageMedia': for (const it of msg.items || []) { const c = classify(it.url, it.mime || '', -1) || (it.kind ? { kind: it.kind, label: it.label } : null); if (c) addMedia(tabId, { url: it.url, mime: it.mime || '', size: -1, ...c, label: c.label }); } return { ok: true };
      case 'download':
        try { await sendToApp([{ url: msg.url, referer: msg.referer || sender.tab?.url || '', fileName: msg.fileName || '', kind: msg.kind || '', headers: reqHeaders.get(msg.url) || undefined }]); return { ok: true }; }
        catch (e) { return { ok: false, error: 'تعذر الاتصال ببرنامج برق — تأكد أنه يعمل' }; }
      case 'batch':
        try { await sendToApp(msg.urls.map(u => ({ url: u, referer: msg.referer || '' })), true); return { ok: true }; }
        catch (e) { return { ok: false, error: e.message }; }
      case 'status': await refreshApp(); return { alive: appAlive, enabled: appConfig.enabled, cfg, port: activePort, appVersion: appInfo?.version || '', extVersion: B.runtime.getManifest().version, oldApp };
      default: return null;
    }
  })().then(reply);
  return true;
});
