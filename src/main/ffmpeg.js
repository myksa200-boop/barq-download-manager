'use strict';
/** دمج مسارات الصوت والصورة وتحويل TS إلى MP4 بدون إعادة ترميز (FFmpeg -c copy) */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function findFfmpeg(custom) {
  return new Promise((resolve) => {
    if (custom && fs.existsSync(custom)) return resolve(custom);
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['ffmpeg'], (err, out) => {
      if (err || !out) return resolve(null);
      resolve(String(out).split(/\r?\n/)[0].trim() || null);
    });
  });
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg: ' + err.split('\n').slice(-3).join(' '))));
  });
}

/** TS ⇒ MP4 */
function remux(bin, input, output) {
  return run(bin, ['-y', '-loglevel', 'error', '-i', input, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', output]);
}

/** فيديو + صوت منفصلان (DASH) ⇒ ملف واحد */
function mux(bin, video, audio, output) {
  const ext = path.extname(output).toLowerCase();
  const args = ['-y', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'];
  if (ext === '.mp4' || ext === '.m4v') args.push('-movflags', '+faststart');
  args.push(output);
  return run(bin, args);
}

module.exports = { findFfmpeg, remux, mux };
