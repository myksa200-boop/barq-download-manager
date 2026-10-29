'use strict';
/**
 * يُجهّز إضافة المتصفح لكل المتصفحات:
 *   dist-ext/chromium/   + barq-chromium.zip   (Chrome, Edge, Brave, Opera, Vivaldi, Yandex)
 *   dist-ext/firefox/    + barq-firefox.zip     (Firefox 115+)
 * تشغيل: node scripts/pack-extensions.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'dist-ext');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

/* ملف ZIP بسيط (Deflate) بدون مكتبات خارجية */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipDir(dir, outFile) {
  const parts = []; const central = []; let offset = 0;
  for (const name of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, name));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...parts, cenBuf, end]));
}

fs.rmSync(OUT, { recursive: true, force: true });
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// Chromium
copyDir(SRC, path.join(OUT, 'chromium'));
zipDir(path.join(OUT, 'chromium'), path.join(OUT, 'barq-chromium.zip'));

// Firefox: background.scripts بدلاً من service_worker + معرّف الإضافة
const ff = JSON.parse(JSON.stringify(manifest));
ff.background = { scripts: ['background.js'] };
ff.browser_specific_settings = { gecko: { id: 'barq-dm@barq.app', strict_min_version: '115.0', data_collection_permissions: { required: ['none'] } } };
copyDir(SRC, path.join(OUT, 'firefox'));
fs.writeFileSync(path.join(OUT, 'firefox', 'manifest.json'), JSON.stringify(ff, null, 2));
zipDir(path.join(OUT, 'firefox'), path.join(OUT, 'barq-firefox.zip'));

fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'Barq — Browser extension',
  '',
  'Chrome / Edge / Brave / Opera / Vivaldi:',
  '  1) open chrome://extensions (edge://extensions, brave://extensions, opera://extensions)',
  '  2) enable Developer mode',
  '  3) Load unpacked  ->  select the "chromium" folder',
  '',
  'Firefox:',
  '  about:debugging#/runtime/this-firefox  ->  Load Temporary Add-on  ->  firefox/manifest.json',
  '  (temporary until Firefox restarts; for a permanent install sign barq-firefox.zip for free at addons.mozilla.org)',
  '  then open the extension popup and click the button to grant site access.',
  '',
  'Keep Barq running — the extension talks to it on http://127.0.0.1:46321',
].join('\r\n'));
console.log('extensions packed into', OUT);
