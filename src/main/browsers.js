'use strict';
/**
 * المتصفحات والإضافة:
 *  - syncExtensions: ينسخ الإضافة المرفقة مع البرنامج إلى مجلد ثابت في بيانات المستخدم
 *    (نفس المسار دائماً، حتى للنسخة المحمولة) ويحدّثها مع كل إصدار جديد من البرنامج.
 *  - detectBrowsers: يكتشف المتصفحات المثبتة.
 *  - openExtensionsPage: يفتح صفحة الإضافات في المتصفح المطلوب.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || ''; } catch { return ''; }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

/** @returns {{dir:string, version:string, updated:boolean}} */
function syncExtensions(srcRoot, dstRoot) {
  const srcV = readVersion(path.join(srcRoot, 'chromium'));
  const dstV = readVersion(path.join(dstRoot, 'chromium'));
  let updated = false;
  if (srcV && srcV !== dstV) {
    for (const sub of ['chromium', 'firefox']) {
      const s = path.join(srcRoot, sub);
      if (fs.existsSync(s)) copyDir(s, path.join(dstRoot, sub));
    }
    for (const f of fs.readdirSync(srcRoot)) {
      const p = path.join(srcRoot, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dstRoot, f));
    }
    updated = true;
  }
  return { dir: dstRoot, version: readVersion(path.join(dstRoot, 'chromium')), updated };
}

const env = (k) => process.env[k] || '';
function winCandidates() {
  const PF = env('ProgramFiles') || 'C:\\Program Files';
  const PF86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
  const LA = env('LOCALAPPDATA');
  const j = (...p) => path.win32.join(...p);
  return [
    { id: 'chrome', name: 'Google Chrome', kind: 'chromium', url: 'chrome://extensions', paths: [j(PF, 'Google\\Chrome\\Application\\chrome.exe'), j(PF86, 'Google\\Chrome\\Application\\chrome.exe'), LA && j(LA, 'Google\\Chrome\\Application\\chrome.exe')] },
    { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', url: 'edge://extensions', paths: [j(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'), j(PF, 'Microsoft\\Edge\\Application\\msedge.exe')] },
    { id: 'brave', name: 'Brave', kind: 'chromium', url: 'brave://extensions', paths: [j(PF, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'), j(PF86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'), LA && j(LA, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')] },
    { id: 'opera', name: 'Opera', kind: 'chromium', url: 'opera://extensions', paths: [LA && j(LA, 'Programs\\Opera\\opera.exe'), LA && j(LA, 'Programs\\Opera\\launcher.exe'), j(PF, 'Opera\\launcher.exe')] },
    { id: 'operagx', name: 'Opera GX', kind: 'chromium', url: 'opera://extensions', paths: [LA && j(LA, 'Programs\\Opera GX\\opera.exe'), LA && j(LA, 'Programs\\Opera GX\\launcher.exe')] },
    { id: 'vivaldi', name: 'Vivaldi', kind: 'chromium', url: 'vivaldi://extensions', paths: [LA && j(LA, 'Vivaldi\\Application\\vivaldi.exe'), j(PF, 'Vivaldi\\Application\\vivaldi.exe')] },
    { id: 'yandex', name: 'Yandex', kind: 'chromium', url: 'browser://extensions', paths: [LA && j(LA, 'Yandex\\YandexBrowser\\Application\\browser.exe')] },
    { id: 'firefox', name: 'Firefox', kind: 'firefox', url: 'about:debugging#/runtime/this-firefox', paths: [j(PF, 'Mozilla Firefox\\firefox.exe'), j(PF86, 'Mozilla Firefox\\firefox.exe')] },
  ];
}
function unixCandidates() {
  const which = (b) => { try { return execFileSync('which', [b]).toString().trim(); } catch { return ''; } };
  if (process.platform === 'darwin') {
    const a = (n) => `/Applications/${n}.app/Contents/MacOS/${n}`;
    return [
      { id: 'chrome', name: 'Google Chrome', kind: 'chromium', url: 'chrome://extensions', paths: [a('Google Chrome')] },
      { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', url: 'edge://extensions', paths: [a('Microsoft Edge')] },
      { id: 'brave', name: 'Brave', kind: 'chromium', url: 'brave://extensions', paths: [a('Brave Browser')] },
      { id: 'firefox', name: 'Firefox', kind: 'firefox', url: 'about:debugging#/runtime/this-firefox', paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    ];
  }
  return [
    { id: 'chrome', name: 'Google Chrome', kind: 'chromium', url: 'chrome://extensions', paths: [which('google-chrome'), which('google-chrome-stable')] },
    { id: 'chromium', name: 'Chromium', kind: 'chromium', url: 'chrome://extensions', paths: [which('chromium'), which('chromium-browser')] },
    { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', url: 'edge://extensions', paths: [which('microsoft-edge'), which('microsoft-edge-stable')] },
    { id: 'brave', name: 'Brave', kind: 'chromium', url: 'brave://extensions', paths: [which('brave-browser'), which('brave')] },
    { id: 'vivaldi', name: 'Vivaldi', kind: 'chromium', url: 'vivaldi://extensions', paths: [which('vivaldi')] },
    { id: 'firefox', name: 'Firefox', kind: 'firefox', url: 'about:debugging#/runtime/this-firefox', paths: [which('firefox')] },
  ];
}

function detectBrowsers() {
  const list = process.platform === 'win32' ? winCandidates() : unixCandidates();
  return list.map(b => ({ ...b, exe: b.paths.filter(Boolean).find(p => fs.existsSync(p)) || '' }))
    .filter(b => b.exe).map(({ paths, ...b }) => b);
}

function openExtensionsPage(browser) {
  if (!browser || !browser.exe) throw new Error('المتصفح غير موجود');
  const p = spawn(browser.exe, [browser.url], { detached: true, stdio: 'ignore', windowsHide: false });
  p.unref();
}

/** اسم المتصفح من الإضافة نفسها أو من User-Agent */
function browserFromPing(b, ua) {
  if (b) return b;
  ua = String(ua || '');
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/YaBrowser\//.test(ua)) return 'yandex';
  if (/Vivaldi/.test(ua)) return 'vivaldi';
  return 'chrome';
}

module.exports = { syncExtensions, detectBrowsers, openExtensionsPage, browserFromPing, readVersion };
