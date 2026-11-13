'use strict';
/**
 * المخزن المحلي للبرنامج: ملف JSON واحد في بيانات المستخدم.
 *  - الكتابة مؤجّلة: التغييرات تُجمَّع وتُكتب مرة واحدة بعد FLUSH_MS (لا كتابة للقرص مع كل تحديث تقدّم).
 *  - الكتابة ذرّية (ملف مؤقت ثم إعادة تسمية) مع نسخة احتياطية .bak تُحدَّث كل BACKUP_MS على الأكثر.
 *  - عند الإغلاق أو خروج العملية تُكتب أي تغييرات معلّقة فوراً.
 *  - إذا تعذّرت قراءة الملف تُستخدم النسخة الاحتياطية، ويُحفظ الملف التالف جانباً بدل الكتابة فوقه.
 */
const fs = require('fs');

const FLUSH_MS = 400;
const BACKUP_MS = 60000;

class Results extends Array {
  sorted(field, reverse) {
    const a = Results.from(this).sort((x, y) => (x[field] < y[field] ? -1 : x[field] > y[field] ? 1 : 0));
    return reverse ? a.reverse() : a;
  }
  filtered(query, ...args) {
    const m = /^(\w+)\s*==\s*\$0$/.exec(String(query).trim());
    if (!m) throw new Error('jsonstore: unsupported query ' + query);
    return Results.from(this.filter(o => o[m[1]] === args[0]));
  }
}

class JsonStore {
  constructor({ path, schema }) {
    this.file = path + '.json';
    this.schemas = Object.fromEntries(schema.map(s => [s.name, s]));
    this.isClosed = false;
    this.data = {};
    this._dirty = false;
    this._timer = null;
    this._lastBackup = 0;
    for (const s of schema) if (!s.embedded) this.data[s.name] = [];
    const load = (f) => {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || typeof j !== 'object') throw new Error('bad store');
      for (const k of Object.keys(j)) if (this.data[k] && Array.isArray(j[k])) this.data[k] = j[k].map(o => this._revive(k, o));
    };
    try { if (fs.existsSync(this.file)) load(this.file); } catch {
      // الملف الرئيسي تالف: نحتفظ به للفحص ثم نحاول النسخة الاحتياطية
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      for (const s of schema) if (!s.embedded) this.data[s.name] = [];
      try { if (fs.existsSync(this.file + '.bak')) load(this.file + '.bak'); } catch {
        for (const s of schema) if (!s.embedded) this.data[s.name] = [];   // نبدأ فارغين
      }
    }
    this._onExit = () => { try { this.flush(); } catch { /* ignore */ } };
    process.on('exit', this._onExit);
  }
  _type(p) { return typeof p === 'string' ? p : p.type; }
  _revive(name, o) {
    for (const [k, p] of Object.entries(this.schemas[name].properties)) if (/^date/.test(this._type(p)) && o[k]) o[k] = new Date(o[k]);
    return o;
  }
  _defaults(name, obj) {
    const out = {};
    for (const [k, p] of Object.entries(this.schemas[name].properties)) {
      const ty = this._type(p);
      if (obj[k] !== undefined) out[k] = Array.isArray(obj[k]) ? obj[k].map(x => (x && typeof x === 'object' && !(x instanceof Date) ? { ...x } : x)) : obj[k];
      else if (typeof p === 'object' && 'default' in p) out[k] = p.default;
      else if (ty.endsWith('[]')) out[k] = [];
      else if (ty.endsWith('?')) out[k] = null;
      else throw new Error(`jsonstore: missing required ${name}.${k}`);
    }
    return out;
  }
  write(fn) {
    if (this.isClosed) throw new Error('jsonstore: store is closed');
    this._tx = true;
    try { fn(); } finally { this._tx = false; }
    this._dirty = true;
    if (!this._timer) {
      this._timer = setTimeout(() => { this._timer = null; try { this.flush(); } catch (e) { console.error('[store]', e.message); } }, FLUSH_MS);
      this._timer.unref?.();
    }
  }
  /** يكتب التغييرات المعلّقة إلى القرص الآن */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    const now = Date.now();
    if (now - this._lastBackup > BACKUP_MS) {
      try { if (fs.existsSync(this.file)) { fs.copyFileSync(this.file, this.file + '.bak'); this._lastBackup = now; } } catch { /* ignore */ }
    }
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }
  _check() { if (!this._tx) throw new Error('jsonstore: write outside transaction'); }
  objects(name) { return Results.from(this.data[name]); }
  objectForPrimaryKey(name, key) {
    const pk = this.schemas[name].primaryKey;
    return this.data[name].find(o => o[pk] === key) || null;
  }
  create(name, obj, mode) {
    this._check();
    const pk = this.schemas[name].primaryKey;
    const ex = this.objectForPrimaryKey(name, obj[pk]);
    if (ex) {
      if (!mode || mode === 'never') throw new Error('jsonstore: duplicate primary key ' + obj[pk]);
      for (const [k, v] of Object.entries(obj)) if (v !== undefined) ex[k] = v;
      return ex;
    }
    const o = this._defaults(name, obj);
    this.data[name].push(o);
    return o;
  }
  delete(o) {
    this._check();
    for (const k of Object.keys(this.data)) { const i = this.data[k].indexOf(o); if (i >= 0) this.data[k].splice(i, 1); }
  }
  close() {
    if (this.isClosed) return;
    this.flush();
    process.removeListener('exit', this._onExit);
    this.isClosed = true;
  }
}
JsonStore.UpdateMode = { Never: 'never', Modified: 'modified', All: 'all' };

module.exports = JsonStore;
