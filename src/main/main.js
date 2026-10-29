'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const { Manager } = require('./manager');
const { startBridge } = require('./bridge');
const { parseCli } = require('./cli');
const { Components } = require('./ytdlp');
const BR = require('./browsers');
const U = require('./utils');

const DEV = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let mainWin = null;
let tray = null;
let manager = null;
let bridge = null;
let quitting = false;
let psbId = null;
const progressWins = new Map();
const quitAfter = new Set();
let pendingProgress = {};

/* ------------------------------------------------------------------ */
function createMain() {
  mainWin = new BrowserWindow({
    width: 1220, height: 720, minWidth: 900, minHeight: 520, show: false,
    icon: ICON, title: 'Barq Download Manager', backgroundColor: '#f3f4f6',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWin.removeMenu();
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) mainWin.show(); });
  mainWin.on('close', (e) => {
    if (!quitting && manager.settings.minimizeToTray) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  if (DEV) mainWin.webContents.openDevTools({ mode: 'detach' });
}

function showMain() {
  if (!mainWin) createMain();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
}

function openProgress(id, opts = {}) {
  let w = progressWins.get(id);
  if (w && !w.isDestroyed()) { w.show(); w.focus(); return w; }
  w = new BrowserWindow({
    width: 600, height: opts.complete ? 330 : 560, resizable: true, minimizable: true, maximizable: false, show: false,
    icon: ICON, backgroundColor: '#f3f4f6', title: 'Barq',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  w.removeMenu();
  w.loadFile(path.join(RENDERER, 'progress.html'), { query: { id, complete: opts.complete ? '1' : '' } });
  w.once('ready-to-show', () => { w.showInactive ? (opts.focus ? w.show() : w.showInactive()) : w.show(); });
  w.on('closed', () => progressWins.delete(id));
  progressWins.set(id, w);
  return w;
}

function send(ch, ...args) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, ...args);
}
// نافذة "معلومات التنزيل" المستقلة (مثل IDM): تظهر وحدها دون النافذة الرئيسية
const addWins = new Set();
const addPending = new Map();
let addSeq = 0;
function openAddWindow(data) {
  const k = String(++addSeq);
  addPending.set(k, data);
  const w = new BrowserWindow({
    width: 640, height: 430, useContentSize: true, resizable: false, minimizable: true, maximizable: false, show: false,
    icon: ICON, backgroundColor: manager.settings.theme === 'dark' ? '#111827' : '#ffffff', title: 'Barq',
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  w.removeMenu();
  w.loadFile(path.join(RENDERER, 'add.html'), { query: { k } });
  w.once('ready-to-show', () => {
    w.show();
    // فوق المتصفح لحظة الظهور ثم تعود نافذة عادية
    w.setAlwaysOnTop(true); w.focus(); app.focus?.({ steal: true });
    setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false); }, 600);
  });
  w.on('closed', () => { addWins.delete(w); addPending.delete(k); });
  addWins.add(w);
  return w;
}
function sendAddWins(ch, ...args) { for (const w of addWins) if (!w.isDestroyed()) w.webContents.send(ch, ...args); }
function sendProgressWin(id, ch, ...args) {
  const w = progressWins.get(id);
  if (w && !w.isDestroyed()) w.webContents.send(ch, ...args);
}

/* ------------------------------------------------------------------ */
function wireManager() {
  manager.on('update', (rec) => { send('evt:update', rec); sendProgressWin(rec._id, 'evt:update', rec); updateTray(); });
  manager.on('progress', (id, snap) => { pendingProgress[id] = snap; });
  manager.on('removed', (ids) => { send('evt:removed', ids); for (const id of ids) progressWins.get(id)?.close(); });
  manager.on('reload', () => { const st = manager.state(); send('evt:reload', st); sendAddWins('evt:reload', st); });
  manager.on('settings', (s) => { send('evt:settings', s); sendAddWins('evt:settings', s); for (const w of progressWins.values()) w.webContents.send('evt:settings', s); });
  manager.on('queues', (q) => { send('evt:queues', q); sendAddWins('evt:queues', q); });
  manager.on('started', (id) => {
    const r = manager.db.downloads.get(id);
    if (manager.settings.showProgressOnStart && r && !r.queueId && !silentIds.has(id)) openProgress(id);
    updatePowerBlock();
  });
  manager.on('complete', (rec) => {
    updatePowerBlock();
    if (manager.settings.sound) send('evt:sound', 'complete');
    const w = progressWins.get(rec._id);
    if (w && !w.isDestroyed()) w.webContents.send('evt:complete', rec);
    else if (manager.settings.showCompleteDialog && rec.showComplete !== false && !silentIds.has(rec._id) && !rec.queueId) openProgress(rec._id, { complete: true });
    if (Notification.isSupported()) new Notification({ title: 'اكتمل التنزيل', body: rec.fileName, icon: ICON }).show();
    if (quitAfter.has(rec._id)) { quitAfter.delete(rec._id); if (!quitAfter.size) setTimeout(() => { quitting = true; app.quit(); }, 1500); }
  });
  manager.on('failed', (id, msg) => { updatePowerBlock(); sendProgressWin(id, 'evt:failed', msg); });
  manager.on('queue-done', (q) => {
    if (Notification.isSupported()) new Notification({ title: 'انتهت قائمة الانتظار', body: q.name, icon: ICON }).show();
  });
  manager.on('system-action', (action) => systemAction(action));

  setInterval(() => {
    const keys = Object.keys(pendingProgress);
    if (!keys.length) return;
    const batch = pendingProgress; pendingProgress = {};
    send('evt:progress', batch);
    for (const id of keys) sendProgressWin(id, 'evt:progress', batch[id]);
    // شريط التقدم في شريط المهام
    if (mainWin && !mainWin.isDestroyed()) {
      let d = 0; let s = 0;
      for (const id of manager.tasks.keys()) { const p = manager.progress.get(id); if (p && p.size > 0) { d += p.downloaded; s += p.size; } }
      mainWin.setProgressBar(manager.tasks.size && s ? d / s : -1);
    }
  }, 300);
}

const silentIds = new Set();
const extConnections = new Map();   // origin -> { browser, ext, time }
let extInfo = { dir: '', version: '' };
function extSourceDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'extensions') : (fs.existsSync(path.join(ROOT, 'dist-ext')) ? path.join(ROOT, 'dist-ext') : path.join(ROOT, 'extension'));
}

function updatePowerBlock() {
  const active = manager.tasks.size > 0;
  if (active && psbId == null) psbId = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && psbId != null) { powerSaveBlocker.stop(psbId); psbId = null; }
}

function systemAction(action) {
  if (action === 'exit') { setTimeout(() => { quitting = true; app.quit(); }, 3000); return; }
  if (action === 'shutdown') {
    // مهلة دقيقة يمكن إلغاؤها (Windows: shutdown /a)
    if (process.platform === 'win32') spawn('shutdown', ['/s', '/t', '60', '/c', 'Barq: اكتملت التنزيلات'], { detached: true });
    else if (process.platform === 'darwin') spawn('osascript', ['-e', 'tell app "System Events" to shut down'], { detached: true });
    else spawn('shutdown', ['-h', '+1'], { detached: true });
    send('evt:toast', 'سيتم إيقاف تشغيل الجهاز خلال دقيقة');
  }
}

/* ------------------------------------------------------------------ */
function makeTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16, quality: 'best' }));
  } catch { return; }
  tray.setToolTip('Barq Download Manager');
  tray.on('click', showMain);
  updateTray();
}
function updateTray() {
  if (!tray) return;
  const t = manager.settings.lang === 'en';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t ? 'Open Barq' : 'فتح برق', click: showMain },
    { label: t ? 'Add URL…' : 'إضافة رابط…', click: () => { showMain(); send('evt:command', 'add-url'); } },
    { type: 'separator' },
    { label: t ? 'Start main queue' : 'تشغيل قائمة الانتظار', click: () => manager.startQueue('main') },
    { label: t ? 'Stop all' : 'إيقاف الكل', click: () => manager.stopAll() },
    { type: 'separator' },
    { label: t ? 'Exit' : 'خروج', click: () => { quitting = true; app.quit(); } },
  ]));
}

/* ------------------------------------------------------------------ */
let lastClip = '';
// Electron 45+ قد يُرجع clipboard.readText وعداً (Promise)؛ ندعم الحالتين
async function readClip() {
  try { return String((await clipboard.readText()) || '').trim(); } catch { return ''; }
}
function clipboardMonitor() {
  readClip().then(t => { lastClip = t; });
  let busy = false;
  setInterval(async () => {
    if (!manager.settings.clipboard || busy) return;
    busy = true;
    try {
      const t = await readClip();
      if (!t || t === lastClip) return;
      lastClip = t;
      if (!U.isHttpUrl(t) || t.includes('\n')) return;
      const exts = String(manager.settings.captureExts).toLowerCase().split(/\s+/);
      let ext = '';
      try { ext = U.extOf(new URL(t).pathname); } catch { return; }
      if (ext && exts.includes(ext)) openAddWindow({ url: t, source: 'clipboard' });
    } finally { busy = false; }
  }, 1200);
}

/* ------------------------------------------------------------------ */
const recentExternal = new Map();
function handleExternal(items, isBatch) {
  // نسختان من الإضافة قد ترسلان نفس الرابط: نتجاهل التكرار خلال 4 ثوانٍ
  const now = Date.now();
  for (const [u, t] of recentExternal) if (now - t > 4000) recentExternal.delete(u);
  items = items.filter(it => { if (recentExternal.has(it.url)) return false; recentExternal.set(it.url, now); return true; });
  if (!items.length) return null;
  if (isBatch || items.length > 1) {
    showMain();
    send('evt:batch', items);
    return;
  }
  const it = items[0];
  const data = {
    url: it.url, referer: it.referer || '', cookies: it.cookies || '', userAgent: it.userAgent || '',
    fileName: it.fileName || '', mime: it.mime || '', kind: it.kind || '', hlsVariant: it.hlsVariant || '', source: 'browser',
    headers: it.headers && typeof it.headers === 'object' ? it.headers : undefined,
  };
  if (manager.settings.silentBridge) {
    const { isYtdlpUrl } = require('./ytdlp');
    if (data.kind === 'ytdlp' || isYtdlpUrl(data.url)) {
      // نحتاج العنوان والجودة أولاً (YouTube وغيره)
      manager.inspect(data).then((m) => {
        if (m.playlist) return manager.addPlaylist(m.entries, { variant: 'v:1080', queueId: 'main', start: true });
        const v = (m.variants || []).find(x => x.url === 'v:1080') || (m.variants || [])[0];
        return manager.add({ ...data, kind: 'ytdlp', fileName: m.fileName, hlsVariant: v ? v.url : 'best', start: 'now' });
      }).catch((e) => send('evt:toast', e.message));
      return null;
    }
    return manager.add({ ...data, start: 'now' });
  }
  openAddWindow(data);
}

function handleCli(argv) {
  const c = parseCli(argv);
  if (c.url) {
    const opts = { url: c.url, saveDir: c.path || undefined, fileName: c.file || undefined };
    if (c.silent || c.add) {
      const rec = manager.add({ ...opts, start: c.add ? 'later' : 'now' });
      if (c.silent) silentIds.add(rec._id);
      if (c.quit && !c.add) quitAfter.add(rec._id);
    } else {
      openAddWindow({ ...opts, source: 'cli' });
    }
  }
  if (c.startQueue) manager.startQueue('main');
  if (c.hangup) manager.once('queue-done', () => {}); // Dial-up غير مستخدم حالياً؛ يُقبل للتوافق
}

function applyAutoStart(on) {
  try {
    if (process.platform === 'linux' || !app.isPackaged) return;
    // النسخة المحمولة تعمل من مجلد مؤقت: نسجّل مسار ملف exe الأصلي
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: ['--hidden'] });
  } catch (e) { console.error('autostart', e.message); }
}

/* ------------------------------------------------------------------ */
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  h('state', () => manager.state());
  h('addData', (k) => { const d = addPending.get(String(k)); addPending.delete(String(k)); return d || null; });
  h('get', (id) => ({ rec: manager.db.downloads.get(id), progress: manager.progress.get(id) || null, settings: manager.settings }));
  h('inspect', (o) => manager.inspect(o));
  h('add', (o) => manager.add(o));
  h('addBatch', (urls, o) => manager.addBatch(urls, o));
  h('start', (ids) => { for (const id of [].concat(ids)) manager.start(id); });
  h('pause', (ids) => manager.pause(ids));
  h('stopAll', () => manager.stopAll());
  h('remove', (ids, del) => manager.remove(ids, del));
  h('removeCompleted', () => manager.removeCompleted());
  h('redownload', (id) => manager.redownload(id));
  h('props', (id, patch) => manager.updateProps(id, patch));
  h('moveToQueue', (ids, q) => manager.moveToQueue(ids, q));
  h('reorder', (id, dir) => manager.reorder(id, dir));
  h('startQueue', (q) => manager.startQueue(q));
  h('stopQueue', (q) => manager.stopQueue(q));
  h('saveQueue', (q) => manager.saveQueue(q));
  h('removeQueue', (id) => manager.removeQueue(id));
  h('saveSettings', (p) => {
    const s = manager.saveSettings(p);
    if ('autoStart' in p) applyAutoStart(!!p.autoStart);
    updateTray();
    return s;
  });
  h('checksum', (id, algo) => new Promise((resolve, reject) => {
    const r = manager.db.downloads.get(id);
    if (!r) return reject(new Error('not found'));
    const hash = require('crypto').createHash(['md5', 'sha1', 'sha256', 'sha512'].includes(algo) ? algo : 'sha256');
    fs.createReadStream(path.join(r.saveDir, r.fileName)).on('error', reject).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
  }));
  h('saveCategory', (c) => manager.saveCategory(c));
  h('removeCategory', (n) => manager.removeCategory(n));
  h('saveLogin', (l) => { manager.db.logins.save(l); return manager.db.logins.all(); });
  h('removeLogin', (host) => { manager.db.logins.remove(host); return manager.db.logins.all(); });
  h('merge', (v, a) => manager.merge(v, a));
  h('addPlaylist', (entries, o) => manager.addPlaylist(entries, o));
  h('components', () => manager.components.status());
  h('componentsInstall', async () => { await manager.components.ensureYtdlp(); await manager.components.ensureFfmpeg(); await manager._refreshFfmpeg(); return manager.components.status(); });
  h('componentsUpdate', async () => ({ log: await manager.components.updateYtdlp(), status: await manager.components.status() }));
  h('exportList', async (ids) => {
    const r = await dialog.showSaveDialog(mainWin, { defaultPath: 'barq-links.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, manager.exportList(ids), 'utf8');
    return r.filePath;
  });
  h('importList', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'Text / HTML', extensions: ['txt', 'htm', 'html', 'lst'] }] });
    if (r.canceled) return [];
    return U.extractUrls(fs.readFileSync(r.filePaths[0], 'utf8'));
  });
  h('chooseDir', async (def) => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || mainWin, { defaultPath: def, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('chooseFile', async (def) => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || mainWin, { defaultPath: def, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('open', (id) => { const r = manager.db.downloads.get(id); if (r) return shell.openPath(path.join(r.saveDir, r.fileName)); });
  h('openFolder', (id) => {
    const r = manager.db.downloads.get(id);
    if (!r) return;
    const f = path.join(r.saveDir, r.fileName);
    if (fs.existsSync(f)) shell.showItemInFolder(f); else shell.openPath(r.saveDir);
  });
  h('openPath', (p) => shell.openPath(p));
  h('openProgress', (id) => { const r = manager.db.downloads.get(id); openProgress(id, { complete: r && r.status === 'complete', focus: true }); });
  h('readClipboard', () => readClip());
  h('extensionDir', (sub) => {
    const p = extInfo.dir ? path.join(extInfo.dir, sub || '') : extSourceDir();
    shell.openPath(p);
    return p;
  });
  h('browsers', () => ({
    list: BR.detectBrowsers(),
    connected: [...extConnections.values()].filter(c => Date.now() - c.time < 90000),
    extDir: extInfo.dir, extVersion: extInfo.version, appVersion: app.getVersion(), bridgePort: manager.bridgePort,
  }));
  h('openBrowserExt', (id) => {
    const b = BR.detectBrowsers().find(x => x.id === id);
    BR.openExtensionsPage(b);
    const sub = b.kind === 'firefox' ? 'firefox' : 'chromium';
    clipboard.writeText(path.join(extInfo.dir, sub));
    shell.openPath(path.join(extInfo.dir, sub));
    return path.join(extInfo.dir, sub);
  });
  h('copyText', (t) => { clipboard.writeText(String(t)); return true; });
  h('appInfo', () => {
    let realmVer = '';
    try { realmVer = require('realm/package.json').version; } catch { /* ignore */ }
    const eng = db.engine();
    return { version: app.getVersion(), electron: process.versions.electron, realm: realmVer, engine: eng.name, engineError: eng.error, userData: app.getPath('userData') };
  });
  h('quit', () => { quitting = true; app.quit(); });
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.on('win:resize', (e, hgt) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || !(hgt > 80)) return;
    const [wd] = w.getContentSize();
    w.setContentSize(wd, Math.min(900, Math.round(hgt)));
  });
}

/* ------------------------------------------------------------------ */
app.on('second-instance', (_e, argv) => { showMain(); handleCli(argv); });

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.barq.dm');
  // الإضافة: نسخة ثابتة المسار في بيانات المستخدم، تُحدَّث مع كل إصدار من البرنامج
  try { extInfo = BR.syncExtensions(extSourceDir(), path.join(app.getPath('userData'), 'extensions')); } catch (e) { console.error('ext sync', e.message); extInfo = { dir: extSourceDir(), version: '' }; }
  db.open(path.join(app.getPath('userData'), 'barq.realm'));
  const components = new Components({
    binDir: path.join(app.getPath('userData'), 'bin'),
    getSettings: () => (manager ? manager.settings : db.settings.all()),
    saveSettings: (p) => manager && manager.saveSettings(p),
  });
  manager = new Manager(db, { defaultRoot: app.getPath('downloads'), components });
  // تسجيل التشغيل مع النظام في كل تشغيل (المسار قد يتغير بعد التحديث أو نقل النسخة المحمولة)
  applyAutoStart(manager.settings.autoStart);
  setTimeout(() => components.autoUpdate(), 20000);
  setInterval(() => components.autoUpdate(), 6 * 3600 * 1000);
  registerIpc();
  wireManager();
  createMain();
  makeTray();
  clipboardMonitor();
  if (manager.settings.browserIntegration) {
    startBridge({
      port: manager.settings.bridgePort, version: app.getVersion(), onAdd: handleExternal,
      onPing: (p) => { extConnections.set(p.origin, { browser: BR.browserFromPing(p.browser, p.ua), ext: p.ext, time: Date.now() }); },
      getConfig: () => ({ captureExts: manager.settings.captureExts, enabled: manager.settings.browserIntegration, lang: manager.settings.lang, version: app.getVersion() }),
    }).then((r) => {
      bridge = r.server;
      manager.bridgePort = r.port;
      if (r.fallback) {
        const msg = `المنفذ ${manager.settings.bridgePort} مستخدم من برنامج آخر (غالباً نسخة قديمة من البرنامج)، فاستُخدم المنفذ ${r.port}. الإضافة تكتشفه تلقائياً.`;
        mainWin?.webContents.once('did-finish-load', () => send('evt:toast', msg));
        send('evt:toast', msg);
      } else if (!r.server) {
        send('evt:toast', 'تعذر تشغيل الربط مع المتصفح: ' + r.error);
      }
    });
  }
  mainWin.webContents.once('did-finish-load', () => handleCli(process.argv));
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', async (e) => {
  if (manager && manager.tasks.size && !app._pausedAll) {
    e.preventDefault();
    app._pausedAll = true;
    await manager.stopAll().catch(() => {});
    manager.dispose();
    db.close();
    app.quit();
    return;
  }
  manager?.dispose();
  bridge?.close();
  try { db.close(); } catch { /* ignore */ }
});
app.on('window-all-closed', () => { /* يبقى في شريط النظام */ });
