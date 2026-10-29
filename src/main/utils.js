'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CATEGORIES = [
  { name: 'Compressed', exts: 'zip rar 7z gz gzip tar tgz bz2 xz z arj lzh ace sit sitx sea iso img bin', folder: 'Compressed', order: 1 },
  { name: 'Documents', exts: 'doc docx pdf ppt pptx pps xls xlsx txt rtf odt ods odp epub csv', folder: 'Documents', order: 2 },
  { name: 'Music', exts: 'mp3 wav wma mpa ram ra aac aif aiff m4a flac ogg opus', folder: 'Music', order: 3 },
  { name: 'Programs', exts: 'exe msi msu apk dmg deb rpm appimage pkg jar', folder: 'Programs', order: 4 },
  { name: 'Video', exts: 'avi mpg mpe mpeg asf wmv mov qt rm rmvb mp4 mkv webm 3gp ogv m4v flv ts m3u8', folder: 'Video', order: 5 },
];

const DEFAULT_CAPTURE_EXTS = '3GP 7Z AAC ACE AIF APK ARJ ASF AVI BIN BZ2 DEB DMG EXE FLAC FLV GZ GZIP IMG ISO JAR LZH M4A M4V MKV MOV MP3 MP4 MPA MPE MPEG MPG MSI MSU OGG OGV PDF PKG PPS PPT PPTX QT RA RAR RM RMVB RPM SEA SIT SITX TAR TGZ TIF TIFF WAV WEBM WMA WMV XZ Z ZIP';

const DEFAULT_SETTINGS = {
  lang: 'ar',
  theme: 'light',
  maxConnections: 8,
  speedLimit: 0,            // KB/s, 0 = unlimited (global)
  retries: 5,
  timeout: 30,              // seconds
  clipboard: true,
  bridgePort: 46321,
  browserIntegration: true,
  silentBridge: false,      // true = add from browser without the info dialog
  captureExts: DEFAULT_CAPTURE_EXTS,
  showProgressOnStart: true,
  showCompleteDialog: true,
  sound: true,
  duplicate: 'rename',      // rename | overwrite | ask
  ffmpegPath: '',
  downloadsRoot: '',
  hlsToMp4: true,
  userAgent: '',
  minimizeToTray: true,
  autoStart: true,          // يبدأ مع ويندوز مخفياً في شريط النظام (مثل IDM)
  columns: null,
};

function uid() { return crypto.randomUUID(); }

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function categoryFor(fileName, categories) {
  const ext = extOf(fileName);
  if (!ext) return 'General';
  for (const c of categories) {
    if ((c.exts || '').toLowerCase().split(/[\s,;]+/).includes(ext)) return c.name;
  }
  return 'General';
}

function sanitizeFileName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  n = n.replace(/^\.+/, '').slice(0, 200);
  return n || 'download';
}

function fileNameFromDisposition(cd) {
  if (!cd) return '';
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) { try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch { /* ignore */ } }
  m = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (m) {
    const raw = m[1].trim();
    try { return decodeURIComponent(escape(raw)); } catch { return raw; }
  }
  return '';
}

const MIME_EXT = {
  'application/zip': 'zip', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'application/x-msdownload': 'exe', 'application/x-7z-compressed': '7z', 'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar', 'application/gzip': 'gz', 'application/x-iso9660-image': 'iso', 'video/mp2t': 'ts',
  'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8', 'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt',
};

function fileNameFromUrl(u, mime) {
  let name = '';
  try {
    const p = new URL(u).pathname;
    name = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
  } catch { /* ignore */ }
  if (!name) name = 'download';
  if (!extOf(name) && mime) {
    const e = MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()];
    if (e) name += '.' + e;
  }
  return sanitizeFileName(name);
}

function uniquePath(dir, name, taken = new Set()) {
  const free = (p) => !taken.has(p.toLowerCase()) && !fs.existsSync(p) && !fs.existsSync(p + '.part') && !fs.existsSync(p + '.parts');
  let p = path.join(dir, name);
  if (free(p)) return p;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
    if (free(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isHttpUrl(s) {
  try { const u = new URL(String(s).trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function extractUrls(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s"'<>]+/gi;
  let m;
  while ((m = re.exec(text || ''))) out.push(m[0].replace(/[),.;]+$/, ''));
  return [...new Set(out)];
}

/** expands IDM style wildcard patterns: http://site/file(*).zip with from..to */
function expandBatch(pattern, from, to, width) {
  const out = [];
  if (!pattern.includes('*')) return [pattern];
  const isNum = /^\d+$/.test(String(from));
  if (isNum) {
    for (let i = Number(from); i <= Number(to); i++) out.push(pattern.replace('*', String(i).padStart(width || 0, '0')));
  } else {
    for (let c = String(from).charCodeAt(0); c <= String(to).charCodeAt(0); c++) out.push(pattern.replace('*', String.fromCharCode(c)));
  }
  return out;
}

module.exports = {
  DEFAULT_CATEGORIES, DEFAULT_SETTINGS, DEFAULT_CAPTURE_EXTS, uid, extOf, categoryFor, sanitizeFileName,
  fileNameFromDisposition, fileNameFromUrl, uniquePath, sleep, isHttpUrl, extractUrls, expandBatch,
};
