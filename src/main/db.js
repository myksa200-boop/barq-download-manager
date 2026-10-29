'use strict';
/**
 * طبقة قاعدة البيانات المحلية — Realm (realm@community)
 * كل الدوال متزامنة (Realm متزامن بطبيعته) وتُرجع كائنات JavaScript عادية
 * حتى يمكن إرسالها عبر IPC إلى الواجهة مباشرة.
 */
let Realm;
let ENGINE = 'realm';
let ENGINE_ERROR = '';
try {
  Realm = require('realm');
} catch (e) {
  // ملف realm.node غير متوفر لهذا النظام: نستخدم المخزن الاحتياطي كي لا يتوقف البرنامج
  Realm = require('./jsonstore');
  ENGINE = 'json';
  ENGINE_ERROR = e.message.split('\n')[0];
}
const { DEFAULT_CATEGORIES, DEFAULT_SETTINGS, uid } = require('./utils');

const SegmentSchema = {
  name: 'Segment',
  embedded: true,
  properties: {
    start: 'int',   // أول بايت في القطعة
    end: 'int',     // آخر بايت (شامل)
    pos: 'int',     // البايت التالي المطلوب كتابته (pos > end ⇒ القطعة مكتملة)
  },
};

const DownloadSchema = {
  name: 'Download',
  primaryKey: '_id',
  properties: {
    _id: 'string',
    url: 'string',
    finalUrl: { type: 'string', default: '' },
    fileName: 'string',
    saveDir: 'string',
    size: { type: 'int', default: -1 },
    downloaded: { type: 'int', default: 0 },
    status: { type: 'string', default: 'stopped', indexed: true }, // stopped|queued|connecting|downloading|paused|complete|error
    error: { type: 'string', default: '' },
    category: { type: 'string', default: 'General' },
    queueId: { type: 'string', default: '' },
    position: { type: 'int', default: 0 },
    description: { type: 'string', default: '' },
    referer: { type: 'string', default: '' },
    cookies: { type: 'string', default: '' },
    userAgent: { type: 'string', default: '' },
    headers: { type: 'string', default: '{}' },
    mime: { type: 'string', default: '' },
    kind: { type: 'string', default: 'http' },  // http | hls
    hlsVariant: { type: 'string', default: '' },
    mirrors: { type: 'string', default: '' },     // مصادر إضافية لنفس الملف (رابط في كل سطر)
    resumable: { type: 'bool', default: false },
    etag: { type: 'string', default: '' },
    connections: { type: 'int', default: 0 },   // 0 ⇒ استخدم الإعداد العام
    speedLimit: { type: 'int', default: 0 },    // KB/s لهذا الملف فقط
    afterComplete: { type: 'string', default: 'none' }, // none|exit|shutdown
    showComplete: { type: 'bool', default: true },
    segments: 'Segment[]',
    createdAt: 'date',
    lastTry: 'date?',
    completedAt: 'date?',
  },
};

const CategorySchema = {
  name: 'Category',
  primaryKey: 'name',
  properties: { name: 'string', exts: 'string', folder: 'string', order: { type: 'int', default: 0 } },
};

const QueueSchema = {
  name: 'Queue',
  primaryKey: '_id',
  properties: {
    _id: 'string',
    name: 'string',
    builtin: { type: 'bool', default: false },
    maxConcurrent: { type: 'int', default: 2 },
    startEnabled: { type: 'bool', default: false },
    startTime: { type: 'string', default: '02:00' },
    days: 'int[]',
    stopEnabled: { type: 'bool', default: false },
    stopTime: { type: 'string', default: '07:00' },
    afterDone: { type: 'string', default: 'none' }, // none|exit|shutdown
    retryFailed: { type: 'int', default: 3 },
  },
};

const SettingSchema = { name: 'Setting', primaryKey: 'key', properties: { key: 'string', value: 'string' } };
const SiteLoginSchema = { name: 'SiteLogin', primaryKey: 'host', properties: { host: 'string', user: 'string', pass: 'string' } };

const SCHEMA = [SegmentSchema, DownloadSchema, CategorySchema, QueueSchema, SettingSchema, SiteLoginSchema];
const DOWNLOAD_FIELDS = Object.keys(DownloadSchema.properties);

let realm = null;

function plainSeg(s) { return { start: Number(s.start), end: Number(s.end), pos: Number(s.pos) }; }

function plainDownload(o) {
  if (!o) return null;
  const d = {};
  for (const k of DOWNLOAD_FIELDS) d[k] = o[k];
  d.segments = Array.from(o.segments || [], plainSeg);
  for (const k of ['createdAt', 'lastTry', 'completedAt']) d[k] = d[k] ? new Date(d[k]).getTime() : null;
  return d;
}
function plainQueue(q) {
  return {
    _id: q._id, name: q.name, builtin: q.builtin, maxConcurrent: q.maxConcurrent, startEnabled: q.startEnabled,
    startTime: q.startTime, days: Array.from(q.days || []), stopEnabled: q.stopEnabled, stopTime: q.stopTime,
    afterDone: q.afterDone, retryFailed: q.retryFailed,
  };
}
function toDate(v) { return v == null ? null : (v instanceof Date ? v : new Date(v)); }

function open(dbPath) {
  realm = new Realm({ path: dbPath, schema: SCHEMA, schemaVersion: 2 });
  seed();
  // أي تنزيل كان نشطاً عند إغلاق البرنامج يصبح "متوقفاً" ليُستأنف لاحقاً
  realm.write(() => {
    for (const d of realm.objects('Download')) {
      if (['downloading', 'connecting'].includes(d.status)) d.status = 'paused';
    }
  });
  return realm;
}

function close() { if (realm && !realm.isClosed) realm.close(); realm = null; }

function seed() {
  realm.write(() => {
    if (realm.objects('Category').length === 0) {
      for (const c of DEFAULT_CATEGORIES) realm.create('Category', c);
    }
    if (!realm.objectForPrimaryKey('Queue', 'main')) {
      realm.create('Queue', { _id: 'main', name: 'Main download queue', builtin: true, maxConcurrent: 3, days: [0, 1, 2, 3, 4, 5, 6] });
    }
    if (!realm.objectForPrimaryKey('Queue', 'sync')) {
      realm.create('Queue', { _id: 'sync', name: 'Synchronization queue', builtin: true, maxConcurrent: 1, days: [0, 1, 2, 3, 4, 5, 6] });
    }
  });
}

/* ---------------- Downloads ---------------- */
const downloads = {
  all() { return Array.from(realm.objects('Download').sorted('createdAt'), plainDownload); },
  get(id) { return plainDownload(realm.objectForPrimaryKey('Download', id)); },
  create(data) {
    let out;
    realm.write(() => {
      const obj = { ...data };
      obj._id = obj._id || uid();
      obj.createdAt = toDate(obj.createdAt) || new Date();
      obj.lastTry = toDate(obj.lastTry);
      obj.completedAt = toDate(obj.completedAt);
      obj.segments = (obj.segments || []).map(plainSeg);
      if (!obj.position) obj.position = realm.objects('Download').length + 1;
      for (const k of Object.keys(obj)) if (!DOWNLOAD_FIELDS.includes(k)) delete obj[k];
      out = plainDownload(realm.create('Download', obj));
    });
    return out;
  },
  update(id, patch) {
    let out = null;
    realm.write(() => {
      const o = realm.objectForPrimaryKey('Download', id);
      if (!o) return;
      for (const [k, v] of Object.entries(patch)) {
        if (k === '_id' || !DOWNLOAD_FIELDS.includes(k)) continue;
        if (k === 'segments') o.segments = (v || []).map(plainSeg);
        else if (k === 'createdAt' || k === 'lastTry' || k === 'completedAt') o[k] = toDate(v);
        else o[k] = v;
      }
      out = plainDownload(o);
    });
    return out;
  },
  remove(ids) {
    realm.write(() => {
      for (const id of [].concat(ids)) {
        const o = realm.objectForPrimaryKey('Download', id);
        if (o) realm.delete(o);
      }
    });
  },
};

/* ---------------- Categories ---------------- */
const categories = {
  all() {
    return Array.from(realm.objects('Category').sorted('order'), c => ({ name: c.name, exts: c.exts, folder: c.folder, order: c.order }));
  },
  save(c) {
    realm.write(() => { realm.create('Category', { name: c.name, exts: c.exts || '', folder: c.folder || c.name, order: c.order || 99 }, Realm.UpdateMode.Modified); });
  },
  remove(name) {
    realm.write(() => { const o = realm.objectForPrimaryKey('Category', name); if (o) realm.delete(o); });
  },
};

/* ---------------- Queues ---------------- */
const queues = {
  all() { return Array.from(realm.objects('Queue'), plainQueue).sort((a, b) => (a._id === 'main' ? -1 : b._id === 'main' ? 1 : a.name.localeCompare(b.name))); },
  get(id) { const q = realm.objectForPrimaryKey('Queue', id); return q ? plainQueue(q) : null; },
  save(q) {
    let out;
    realm.write(() => {
      const data = { ...q, _id: q._id || uid() };
      data.days = Array.from(data.days || [0, 1, 2, 3, 4, 5, 6]);
      out = plainQueue(realm.create('Queue', data, Realm.UpdateMode.Modified));
    });
    return out;
  },
  remove(id) {
    realm.write(() => {
      const q = realm.objectForPrimaryKey('Queue', id);
      if (!q || q.builtin) return;
      for (const d of realm.objects('Download').filtered('queueId == $0', id)) d.queueId = '';
      realm.delete(q);
    });
  },
};

/* ---------------- Settings ---------------- */
const settings = {
  all() {
    const out = { ...DEFAULT_SETTINGS };
    for (const s of realm.objects('Setting')) { try { out[s.key] = JSON.parse(s.value); } catch { /* ignore */ } }
    return out;
  },
  save(patch) {
    realm.write(() => {
      for (const [key, v] of Object.entries(patch)) realm.create('Setting', { key, value: JSON.stringify(v) }, Realm.UpdateMode.Modified);
    });
    return settings.all();
  },
};

/* ---------------- Site logins ---------------- */
const logins = {
  all() { return Array.from(realm.objects('SiteLogin'), l => ({ host: l.host, user: l.user, pass: l.pass })); },
  save(l) { realm.write(() => { realm.create('SiteLogin', { host: l.host, user: l.user, pass: l.pass }, Realm.UpdateMode.Modified); }); },
  remove(host) { realm.write(() => { const o = realm.objectForPrimaryKey('SiteLogin', host); if (o) realm.delete(o); }); },
  forHost(host) {
    const h = String(host || '').toLowerCase();
    return logins.all().find(l => h === l.host.toLowerCase() || h.endsWith('.' + l.host.toLowerCase())) || null;
  },
};

module.exports = { open, close, downloads, categories, queues, settings, logins, SCHEMA, engine: () => ({ name: ENGINE, error: ENGINE_ERROR }) };
