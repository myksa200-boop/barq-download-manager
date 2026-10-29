'use strict';
/** اختبار المدير + قاعدة Realm: node test/manager.test.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeServer } = require('./server');
const db = require('../src/main/db');
const { Manager } = require('../src/main/manager');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-m-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const wait = (mgr, ev, pred = () => true, ms = 30000) => new Promise((res, rej) => {
  const tm = setTimeout(() => rej(new Error('timeout waiting ' + ev)), ms);
  const fn = (...a) => { if (pred(...a)) { clearTimeout(tm); mgr.off(ev, fn); res(a); } };
  mgr.on(ev, fn);
});

async function main() {
  const { server, data } = makeServer({ size: 3 * 1024 * 1024, perConnKBps: 2500 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = (n) => console.log('  ✓', n);

  db.open(path.join(tmp, 'test.realm'));
  const mgr = new Manager(db, { defaultRoot: path.join(tmp, 'Downloads') });
  mgr.saveSettings({ showProgressOnStart: false });

  // seed
  const st = mgr.state();
  assert.strictEqual(st.categories.length, 5);
  assert.deepStrictEqual(st.queues.map(q => q._id), ['main', 'sync']);
  ok('Realm seeded: 5 categories, main + sync queues, default settings');

  // inspect
  const info = await mgr.inspect({ url: base + '/dl' });
  assert.strictEqual(info.fileName, 'ملف عربي.zip'); assert.strictEqual(info.category, 'Compressed');
  assert.ok(info.saveDir.endsWith(path.join('Downloads', 'Compressed')));
  ok('inspect: name, category (Compressed) and category folder');

  // add + complete
  const r1 = mgr.add({ url: base + '/dl', fileName: info.fileName, category: info.category, start: 'now' });
  const [done] = await wait(mgr, 'complete', r => r._id === r1._id);
  assert.strictEqual(sha(fs.readFileSync(path.join(done.saveDir, done.fileName))), sha(data));
  assert.strictEqual(db.downloads.get(r1._id).status, 'complete');
  ok('add → download → complete; status persisted in Realm');

  // duplicate name → auto rename
  const r2 = mgr.add({ url: base + '/dl', fileName: info.fileName, category: 'Compressed', start: 'later' });
  assert.strictEqual(r2.fileName, 'ملف عربي (1).zip');
  ok('duplicate file name renamed to "ملف عربي (1).zip"');

  // queue with maxConcurrent = 1
  mgr.saveQueue({ ...db.queues.get('main'), maxConcurrent: 1 });
  const r3 = mgr.add({ url: base + '/files/test.bin', fileName: 'q2.bin', start: 'later' });
  let maxActive = 0;
  const onStart = () => { maxActive = Math.max(maxActive, mgr.tasks.size); };
  mgr.on('started', onStart);
  const qdone = wait(mgr, 'queue-done');
  mgr.startQueue('main');
  await qdone;
  mgr.off('started', onStart);
  assert.strictEqual(maxActive, 1);
  assert.strictEqual(db.downloads.get(r2._id).status, 'complete');
  assert.strictEqual(db.downloads.get(r3._id).status, 'complete');
  ok('queue: runs files one at a time (max 1), emits queue-done');

  // pause / resume through manager, segments saved in Realm
  mgr.saveSettings({ speedLimit: 600 });
  const r4 = mgr.add({ url: base + '/files/test.bin', fileName: 'p.bin', start: 'now' });
  await wait(mgr, 'progress', (id, s) => id === r4._id && s.downloaded > 300000);
  await mgr.pause(r4._id);
  const saved = db.downloads.get(r4._id);
  assert.strictEqual(saved.status, 'paused');
  assert.ok(saved.segments.length >= 1 && saved.downloaded > 0);
  mgr.saveSettings({ speedLimit: 0 });
  mgr.start(r4._id);
  const [d4] = await wait(mgr, 'complete', r => r._id === r4._id);
  assert.strictEqual(sha(fs.readFileSync(path.join(d4.saveDir, d4.fileName))), sha(data));
  ok(`pause → segments in Realm (${saved.segments.length}) → resume → hash matches`);

  // scheduler
  const q = mgr.saveQueue({ name: 'Night', maxConcurrent: 2, startEnabled: true, startTime: '03:15', days: [0, 1, 2, 3, 4, 5, 6] });
  mgr.add({ url: base + '/files/test.bin', fileName: 'night.bin', start: 'later', queueId: q._id });
  const started = wait(mgr, 'started');
  mgr._scheduler(new Date(2026, 9, 29, 3, 15));
  await started;
  assert.ok(mgr.runningQueues.has(q._id) || db.downloads.all().some(d => d.queueId === q._id && d.status !== 'stopped'));
  await wait(mgr, 'queue-done', qq => qq._id === q._id);
  ok('scheduler starts a custom queue at its start time');

  // error + remove
  const r5 = mgr.add({ url: base + '/forbidden', fileName: 'x.bin', start: 'now' });
  const [, msg] = await wait(mgr, 'failed', id => id === r5._id);
  assert.ok(/403/.test(msg));
  await mgr.remove([r5._id]);
  assert.strictEqual(db.downloads.get(r5._id), null);
  ok('403 → status error with message; remove deletes record');

  // settings persistence + reopen
  mgr.saveSettings({ lang: 'en', maxConnections: 16 });
  mgr.dispose(); db.close();
  db.open(path.join(tmp, 'test.realm'));
  assert.strictEqual(db.settings.all().maxConnections, 16);
  assert.ok(db.downloads.all().length >= 5);
  ok('settings and downloads survive closing and reopening the database');

  db.close(); server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nmanager tests passed');
  process.exit(0);
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
