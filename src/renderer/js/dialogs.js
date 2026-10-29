/* نوافذ الحوار: إضافة رابط، معلومات التنزيل، تنزيل جماعي، الخصائص، الخيارات، الجدولة، التصنيفات */
(function () {
  const { $, $$, h, esc, ltr, icon, fmtSize, toast, modal, tabs } = UI;
  const api = window.api;
  const S = () => window.APP.S;

  const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());
  const sep = () => (S().root.includes('\\') ? '\\' : '/');
  const isAbs = (p) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p || '');
  function catDir(name) {
    const c = S().categories.find(x => x.name === name);
    if (!c) return S().root;
    return isAbs(c.folder) ? c.folder : S().root.replace(/[\\/]+$/, '') + sep() + c.folder;
  }
  const field = (attrs) => h('input', { class: 'field', ...attrs });
  const sel = (opts, value, attrs = {}) => {
    const s = h('select', { class: 'field', ...attrs });
    for (const [v, l] of opts) s.append(h('option', { value: v, selected: String(v) === String(value) }, l));
    return s;
  };
  const chk = (label, checked, attrs = {}) => {
    const i = h('input', { type: 'checkbox', ...attrs }); i.checked = !!checked;
    return h('label', { class: 'chk' }, i, label);
  };
  const lbl = (k) => h('label', {}, t(k));
  const catOptions = () => [...S().categories.map(c => [c.name, t(c.name)]), ['General', t('General')]];
  const queueOptions = () => S().queues.map(q => [q._id, t(q.name)]);

  /* ---------------- Add URL ---------------- */
  async function addUrl(prefill) {
    let url = prefill || '';
    if (!url) { try { const c = (await api.call('readClipboard')).trim(); if (isUrl(c)) url = c; } catch { /* ignore */ } }
    const inp = field({ type: 'url', value: url, placeholder: 'https://', autofocus: true, style: { width: '100%' } });
    const auth = chk(t('useAuth'), false);
    const user = field({ placeholder: t('user') }); const pass = field({ type: 'password', placeholder: t('pass') });
    const authRow = h('div', { class: 'row hidden', style: { marginTop: '8px' } }, user, pass);
    auth.querySelector('input').onchange = (e) => authRow.classList.toggle('hidden', !e.target.checked);
    const body = h('div', {}, h('div', { style: { marginBottom: '6px' } }, t('enterUrl')), inp, h('div', { style: { marginTop: '10px' } }, auth), authRow);
    modal({
      title: t('addUrl'), body, width: 560, iconName: 'add',
      buttons: ['sp', { label: t('ok'), cls: 'primary', onClick: async () => {
        const u = inp.value.trim();
        if (!isUrl(u)) { toast(t('invalidUrl'), true); return false; }
        if (auth.querySelector('input').checked && user.value) {
          await api.call('saveLogin', { host: new URL(u).hostname, user: user.value, pass: pass.value });
        }
        setTimeout(() => fileInfo({ url: u }), 0);
      } }, { label: t('cancel') }],
    });
  }

  /* ---------------- Download File Info ---------------- */
  async function fileInfo(data) {
    const st = S();
    const urlIn = field({ type: 'url', value: data.url, dir: 'ltr', style: { width: '100%' } });
    const catSel = sel(catOptions(), 'General');
    const addCatBtn = h('button', { class: 'btn sm', title: t('addCat'), onclick: () => category(null) }, '+');
    const dirIn = field({ value: st.root, dir: 'ltr', style: { flex: 1 } });
    const browse = h('button', { class: 'btn sm', onclick: async () => { const d = await api.call('chooseDir', dirIn.value); if (d) dirIn.value = d; } }, '…');
    const nameIn = field({ value: data.fileName || '', style: { width: '100%' }, dir: 'auto' });
    const remember = chk('', false);
    const desc = h('textarea', { class: 'field', rows: 2, style: { width: '100%' } });
    const qualSel = sel([], '');
    const qualRow = [lbl('quality'), qualSel];
    qualRow.forEach(e => e.classList.add('hidden'));
    const info = h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } }, h('span', { class: 'spinner' }), h('span', { class: 'muted' }, t('inspecting')));
    const card = h('div', { class: 'full media-card hidden' });
    const queueSel = sel(queueOptions(), 'main', { style: { width: '170px' } });
    const updRemember = () => { remember.lastChild.textContent = t('rememberPath', t(catSel.value)); remember.classList.toggle('hidden', catSel.value === 'General'); };
    catSel.onchange = () => { dirIn.value = catDir(catSel.value); updRemember(); };
    updRemember();

    const form = h('div', { class: 'form' },
      card,
      lbl('url'), urlIn,
      lbl('category'), h('div', { class: 'row' }, catSel, addCatBtn),
      lbl('saveTo'), h('div', { class: 'row' }, dirIn, browse),
      lbl('fileName'), nameIn,
      h('span'), remember,
      ...qualRow,
      lbl('description'), desc,
      h('span'), info,
    );
    if (data.source && data.source !== 'manual') form.prepend(h('div', { class: 'full hint' }, t('externalFrom', t('src_' + data.source))));

    let meta = null;
    const startDl = async (mode) => {
      const url = urlIn.value.trim();
      if (!isUrl(url)) { toast(t('invalidUrl'), true); return false; }
      if (remember.querySelector('input').checked && catSel.value !== 'General') {
        const c = st.categories.find(x => x.name === catSel.value);
        if (c) await api.call('saveCategory', { ...c, folder: dirIn.value });
      }
      const opts = {
        url, fileName: nameIn.value.trim() || undefined, saveDir: dirIn.value.trim() || undefined, category: catSel.value,
        description: desc.value, referer: data.referer, cookies: data.cookies, userAgent: data.userAgent, headers: data.headers,
        kind: meta?.kind || data.kind || undefined, hlsVariant: qualSel.value || data.hlsVariant || '', size: meta?.size, resumable: meta?.resumable, mime: meta?.mime,
        start: mode, queueId: mode === 'later' ? queueSel.value : '',
      };
      try {
        if (meta && meta.playlist) {
          const n = await api.call('addPlaylist', meta.entries.map(e => ({ ...e })), { variant: qualSel.value || 'v:1080', queueId: queueSel.value || 'main', start: mode === 'now', saveDir: opts.saveDir });
          toast(t('added', n.length));
        } else await api.call('add', opts);
      } catch (e) { toast(e.message, true); return false; }
    };
    const m = modal({
      title: t('fileInfo'), body: form, width: 640, iconName: 'logo',
      buttons: [h('span', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { if (await startDl('later') !== false) m.close(); } }, t('downloadLater')), h('span', { class: 'hint' }, t('toQueue')), queueSel),
        'sp', { label: t('startDownload'), cls: 'primary', onClick: () => startDl('now') }, { label: t('cancel') }],
    });

    const inspect = async () => {
      info.innerHTML = `<span class="spinner"></span><span class="muted">${esc(t('inspecting'))}</span>`;
      try {
        meta = await api.call('inspect', { url: urlIn.value.trim(), referer: data.referer, cookies: data.cookies, userAgent: data.userAgent, headers: data.headers, kind: data.kind === 'ytdlp' ? 'ytdlp' : undefined });
        if (!data.fileName || !nameIn.value) nameIn.value = meta.fileName;
        catSel.value = meta.category || 'General';
        dirIn.value = catDir(catSel.value);
        updRemember();
        if (meta.variants && meta.variants.length) {
          qualSel.innerHTML = '';
          for (const v of meta.variants) qualSel.append(h('option', { value: v.url }, qualityLabel(v, meta.kind)));
          if (data.hlsVariant) qualSel.value = data.hlsVariant;
          else if (meta.kind === 'ytdlp') { const pref = meta.variants.find(v => v.url === 'v:1080') || meta.variants[0]; qualSel.value = pref.url; }
          qualRow.forEach(e => e.classList.remove('hidden'));
        }
        // بطاقة الفيديو (YouTube وغيره): الصورة المصغرة والعنوان والمدة
        if (meta.kind === 'ytdlp') {
          card.replaceChildren();
          if (meta.thumbnail) { const im = h('img', { src: meta.thumbnail, alt: '' }); im.onerror = () => im.remove(); card.append(im); }
          const box = h('div', { class: 'mc-body' },
            h('div', { class: 'mc-title', dir: 'auto' }, meta.playlist ? `${t('playlist')}: ${meta.title}` : meta.title),
            h('div', { class: 'muted' }, [meta.extractor, meta.uploader, meta.duration ? UI.fmtTime(meta.duration) : '', meta.playlist ? `${meta.entries.length} ${t('videos')}` : ''].filter(Boolean).join('  ·  ')));
          if (meta.playlist) box.append(h('div', { class: 'mc-list', dir: 'auto' }, meta.entries.slice(0, 6).map((e, i) => h('div', {}, `${i + 1}. ${e.title}`)), meta.entries.length > 6 ? h('div', { class: 'muted' }, '…') : ''));
          card.append(box);
          card.classList.remove('hidden');
          if (meta.playlist) { nameIn.closest('.form') && (nameIn.disabled = true); }
        }
        const upd = () => {
          const v = (meta.variants || []).find(x => x.url === qualSel.value);
          if (meta.kind === 'ytdlp' && !meta.playlist) {
            const ext = qualSel.value === 'a:mp3' ? '.mp3' : qualSel.value === 'a:m4a' ? '.m4a' : '.mp4';
            nameIn.value = nameIn.value.replace(/\.(mp4|m4a|mp3)$/i, '') + ext;
          }
          const size = v ? (v.size || -1) : meta.size;   // لكل جودة حجمها؛ لا نعرض حجم أعلى جودة عند اختيار جودة أقل
          info.innerHTML = (meta.playlist ? '' : `<span>${esc(t('size'))}: <b>${size > 0 ? ltr((meta.kind === 'ytdlp' ? '≈ ' : '') + fmtSize(size)) : esc(t('unknown'))}</b></span>`) +
            `<span>${esc(t('resumeSupport'))}: <b style="color:${meta.resumable ? 'var(--ok)' : 'var(--warn)'}">${esc(t(meta.resumable ? 'yes' : 'no'))}</b></span>` +
            (['hls', 'dash'].includes(meta.kind) ? `<span class="badge">${meta.kind.toUpperCase()}</span>` : meta.kind === 'ytdlp' ? '<span class="badge">yt-dlp</span>' : '');
        };
        qualSel.onchange = upd;
        upd();
      } catch (e) {
        info.innerHTML = `<span style="color:var(--err)">${icon('warn', 'var(--err)', 14)} ${esc(e.message)}</span>`;
      }
    };
    urlIn.addEventListener('change', inspect);
    if (isUrl(data.url)) inspect(); else info.innerHTML = '';
    return m;
  }

  function qualityLabel(v, kind) {
    if (kind === 'ytdlp') {
      if (v.resolution === 'audio') return `♪ ${t('audioOnly')} ${v.label || ''}${v.size ? '  ·  ≈ ' + fmtSize(v.size) : ''}`;
      return `${v.resolution}${v.size ? '  ·  ≈ ' + fmtSize(v.size) : ''}`;
    }
    const res = v.resolution ? (v.resolution === 'audio' ? '♪' : (v.resolution.includes('x') ? v.resolution.split('x')[1] + 'p  (' + v.resolution + ')' : v.resolution)) : '—';
    return `${res}  ·  ${Math.round((v.bandwidth || 0) / 1000)} kbps`;
  }

  /* ---------------- Batch download ---------------- */
  function batch(text = '', items = null) {
    const ta = h('textarea', { class: 'field mono', rows: 8, style: { width: '100%', direction: 'ltr' }, placeholder: t('linesHint') });
    ta.value = text;
    const pat = field({ value: 'https://example.com/file*.zip', class: 'field mono', style: { width: '100%', direction: 'ltr' } });
    const from = field({ value: '1', style: { width: '70px' } }); const to = field({ value: '10', style: { width: '70px' } });
    const width = field({ value: '0', type: 'number', min: 0, max: 6, style: { width: '60px' } });
    let mode = 'list';
    const preview = h('div', { class: 'list', style: { maxHeight: '170px', marginTop: '6px', direction: 'ltr' } });
    const urls = () => {
      if (mode === 'list') return (ta.value.match(/https?:\/\/[^\s"'<>]+/g) || []);
      const out = []; const p = pat.value; if (!p.includes('*')) return [p];
      const w = Number(width.value) || 0;
      if (/^\d+$/.test(from.value) && /^\d+$/.test(to.value)) for (let i = +from.value; i <= +to.value && out.length < 5000; i++) out.push(p.replace('*', String(i).padStart(w, '0')));
      else for (let c = from.value.charCodeAt(0); c <= to.value.charCodeAt(0); c++) out.push(p.replace('*', String.fromCharCode(c)));
      return out;
    };
    const refresh = () => {
      preview.innerHTML = '';
      for (const u of urls().slice(0, 1000)) {
        const c = h('input', { type: 'checkbox', checked: true }); c.dataset.url = u;
        preview.append(h('label', { class: 'li mono', style: { fontSize: '11.5px' } }, c, u));
      }
    };
    [ta, pat, from, to, width].forEach(e => e.addEventListener('input', refresh));
    const t1 = h('div', {}, ta);
    const t2 = h('div', { class: 'form' }, lbl('address'), pat, lbl('batchFrom'), h('div', { class: 'row' }, from, h('span', {}, t('batchTo')), to, h('span', {}, t('batchWidth')), width));
    const tb = tabs([{ label: t('batchList'), content: t1, onShow: () => { mode = 'list'; refresh(); } }, { label: t('batchPattern'), content: t2, onShow: () => { mode = 'pattern'; refresh(); } }]);
    const dirIn = field({ value: S().root, dir: 'ltr', style: { flex: 1 } });
    const queueSel = sel(queueOptions(), 'main');
    const startNow = chk(t('startNow'), true);
    const body = h('div', {}, tb, h('div', { class: 'hint', style: { marginTop: '10px' } }, t('batchPreview')), preview,
      h('div', { class: 'form', style: { marginTop: '12px' } }, lbl('saveTo'), h('div', { class: 'row' }, dirIn, h('button', { class: 'btn sm', onclick: async () => { const d = await api.call('chooseDir', dirIn.value); if (d) dirIn.value = d; } }, '…')),
        lbl('addToQueue'), h('div', { class: 'row' }, queueSel, startNow)));
    refresh();
    modal({
      title: t('batchTitle'), body, width: 640, iconName: 'queue',
      buttons: ['sp', { label: t('ok'), cls: 'primary', onClick: async () => {
        const list = $$('input[type=checkbox]', preview).filter(c => c.checked).map(c => c.dataset.url);
        if (!list.length) return false;
        const saveDir = dirIn.value && dirIn.value !== S().root ? dirIn.value : undefined;
        const q = queueSel.value; const go = startNow.querySelector('input').checked;
        try {
          if (items) {
            for (const it of items.filter(i => list.includes(i.url))) await api.call('add', { ...it, start: 'later', queueId: q, saveDir });
            if (go) await api.call('startQueue', q);
          } else await api.call('addBatch', list, { queueId: q, start: go, saveDir });
          toast(t('added', list.length));
        } catch (e) { toast(e.message, true); return false; }
      } }, { label: t('cancel') }],
    });
  }

  /* ---------------- Properties ---------------- */
  function properties(d) {
    const started = d.downloaded > 0 || d.status === 'complete';
    const nameIn = field({ value: d.fileName, disabled: started, style: { width: '100%' }, dir: 'auto' });
    const dirIn = field({ value: d.saveDir, disabled: started, dir: 'ltr', style: { width: '100%' } });
    const urlIn = h('textarea', { class: 'field mono', rows: 3, style: { width: '100%', direction: 'ltr' } }); urlIn.value = d.url;
    const refIn = field({ value: d.referer, class: 'field mono', style: { width: '100%', direction: 'ltr' } });
    const descIn = field({ value: d.description, style: { width: '100%' } });
    const connIn = field({ type: 'number', min: 0, max: 32, value: d.connections, style: { width: '90px' } });
    const mirIn = h('textarea', { class: 'field mono', rows: 2, dir: 'ltr', placeholder: 'https://mirror2.example.com/file.zip', style: { width: '100%' } }); mirIn.value = d.mirrors || '';
    const limIn = field({ type: 'number', min: 0, value: d.speedLimit, style: { width: '110px' } });
    const form = h('div', { class: 'form' },
      lbl('fileName'), nameIn, lbl('saveTo'), dirIn,
      lbl('address'), h('div', {}, urlIn, h('div', { class: 'hint' }, t('refreshHint'))),
      lbl('referer'), refIn, lbl('description'), descIn,
      d.kind === 'http' || !d.kind ? lbl('mirrors') : null, d.kind === 'http' || !d.kind ? h('div', {}, mirIn, h('div', { class: 'hint' }, t('mirrorsHint'))) : null,
      lbl('connsOverride'), connIn, lbl('limitThis'), h('div', { class: 'row' }, limIn, h('span', { class: 'muted' }, 'KB/s')),
      lbl('size'), h('b', { html: d.size > 0 ? ltr(fmtSize(d.size)) : esc(t('unknown')) }),
      lbl('resumeSupport'), h('b', {}, t(d.resumable ? 'yes' : 'no')),
      d.error ? lbl('lastError') : null, d.error ? h('span', { style: { color: 'var(--err)' } }, d.error) : null,
    );
    modal({
      title: t('properties') + ' — ' + d.fileName, body: form, width: 620, iconName: 'opt',
      buttons: ['sp', { label: t('ok'), cls: 'primary', onClick: async () => {
        const patch = { url: urlIn.value.trim(), referer: refIn.value.trim(), description: descIn.value, connections: Number(connIn.value) || 0, speedLimit: Number(limIn.value) || 0, mirrors: mirIn.value.trim() };
        if (!started) { patch.fileName = nameIn.value.trim(); patch.saveDir = dirIn.value.trim(); }
        if (!isUrl(patch.url)) { toast(t('invalidUrl'), true); return false; }
        await api.call('props', d._id, patch);
      } }, { label: t('cancel') }],
    });
  }

  /* ---------------- Category ---------------- */
  function category(c) {
    const name = field({ value: c ? c.name : '', disabled: !!c, style: { width: '100%' } });
    const exts = h('textarea', { class: 'field mono', rows: 3, style: { width: '100%', direction: 'ltr' } }); exts.value = c ? c.exts : '';
    const folder = field({ value: c ? c.folder : '', dir: 'ltr', style: { flex: 1 } });
    const form = h('div', { class: 'form' }, lbl('newCatName'), name, lbl('exts'), exts, lbl('folder'),
      h('div', { class: 'row' }, folder, h('button', { class: 'btn sm', onclick: async () => { const d = await api.call('chooseDir', folder.value || S().root); if (d) folder.value = d; } }, '…')),
      h('span'), h('div', { class: 'hint' }, t('perCatHint')));
    modal({
      title: c ? t('editCat') : t('addCat'), body: form, width: 560, iconName: 'folder',
      buttons: ['sp', { label: t('save'), cls: 'primary', onClick: async () => {
        if (!name.value.trim()) return false;
        await api.call('saveCategory', { name: name.value.trim(), exts: exts.value.trim(), folder: folder.value.trim() || name.value.trim(), order: c ? c.order : 50 });
      } }, { label: t('cancel') }],
    });
  }

  /* ---------------- Speed limit ---------------- */
  function speedLimit() {
    const inp = field({ type: 'number', min: 1, value: S().settings.speedLimit || 1024, style: { width: '140px' }, autofocus: true });
    modal({
      title: t('speedLimiter'), width: 380, iconName: 'opt',
      body: h('div', { class: 'row' }, h('span', {}, t('globalLimit')), inp),
      buttons: ['sp', { label: t('ok'), cls: 'primary', onClick: () => api.call('saveSettings', { speedLimit: Math.max(0, Number(inp.value) || 0) }) }, { label: t('cancel') }],
    });
  }

  /* ---------------- Options ---------------- */
  function options() {
    const s = { ...S().settings };
    const bind = (key, el, type = 'value') => {
      const inp = el.tagName === 'LABEL' ? el.querySelector('input') : el;
      const get = () => (inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value);
      inp.addEventListener('change', () => { s[key] = get(); });
      return el;
    };
    // General
    const gen = h('div', {},
      h('fieldset', {}, h('legend', {}, t('o_general')), h('div', { class: 'form' },
        lbl('language'), bind('lang', sel([['ar', 'العربية'], ['en', 'English']], s.lang)),
        lbl('theme'), bind('theme', sel([['light', t('light')], ['dark', t('dark')]], s.theme)),
        h('span'), bind('clipboard', chk(t('clipboardMon'), s.clipboard)),
        h('span'), bind('minimizeToTray', chk(t('trayOnClose'), s.minimizeToTray)),
        h('span'), bind('autoStart', chk(t('autoStart'), s.autoStart)))));
    // File types + categories
    const capt = h('textarea', { class: 'field mono', rows: 4, style: { width: '100%', direction: 'ltr' } }); capt.value = s.captureExts;
    bind('captureExts', capt);
    const catTable = h('table', { class: 'mini' });
    const cats = S().categories.map(c => ({ ...c }));
    const drawCats = () => {
      catTable.innerHTML = `<tr><th style="width:130px">${esc(t('category'))}</th><th>${esc(t('exts'))}</th><th style="width:170px">${esc(t('folder'))}</th><th style="width:30px"></th></tr>`;
      cats.forEach((c, i) => {
        const e = h('input', { value: c.exts, class: 'mono', style: { direction: 'ltr' } }); e.oninput = () => { c.exts = e.value; c._dirty = 1; };
        const f = h('input', { value: c.folder, dir: 'ltr' }); f.oninput = () => { c.folder = f.value; c._dirty = 1; };
        catTable.append(h('tr', {}, h('td', {}, t(c.name)), h('td', {}, e), h('td', {}, f),
          h('td', {}, h('button', { class: 'btn sm danger', title: t('removeCat'), onclick: () => { c._del = 1; cats.splice(i, 1); drawCats(); removedCats.push(c.name); } }, '✕'))));
      });
    };
    const removedCats = [];
    drawCats();
    const types = h('div', {}, h('div', { style: { marginBottom: '6px' } }, t('captureExts')), capt,
      h('div', { class: 'row', style: { margin: '14px 0 6px' } }, h('b', {}, t('categories')), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => category(null) }, '+ ' + t('addCat'))),
      h('div', { class: 'list', style: { maxHeight: '220px' } }, catTable), h('div', { class: 'hint', style: { marginTop: '6px' } }, t('perCatHint')));
    // Connection
    const conn = h('div', { class: 'form' },
      lbl('maxConn'), bind('maxConnections', sel([1, 2, 4, 6, 8, 12, 16, 24, 32].map(n => [n, n]), s.maxConnections, { style: { width: '120px' } })),
      lbl('retries'), bind('retries', field({ type: 'number', min: 0, max: 50, value: s.retries, style: { width: '120px' } })),
      lbl('timeout'), bind('timeout', field({ type: 'number', min: 5, max: 600, value: s.timeout, style: { width: '120px' } })),
      lbl('globalLimit'), bind('speedLimit', field({ type: 'number', min: 0, value: s.speedLimit, style: { width: '120px' } })),
      lbl('userAgent'), bind('userAgent', field({ value: s.userAgent, class: 'field mono', placeholder: 'Mozilla/5.0 …', style: { width: '100%', direction: 'ltr' } })));
    // Save to
    const rootIn = field({ value: s.downloadsRoot || S().root, dir: 'ltr', style: { flex: 1 } });
    bind('downloadsRoot', rootIn);
    const saveTo = h('div', { class: 'form' }, lbl('root'), h('div', { class: 'row' }, rootIn, h('button', { class: 'btn sm', onclick: async () => { const d = await api.call('chooseDir', rootIn.value); if (d) { rootIn.value = d; s.downloadsRoot = d; } } }, t('browse'))),
      h('span'), h('div', { class: 'hint' }, t('perCatHint')));
    // Downloads
    const ffIn = field({ value: s.ffmpegPath, placeholder: 'ffmpeg', dir: 'ltr', style: { flex: 1 } });
    bind('ffmpegPath', ffIn);
    const dls = h('div', { class: 'form' },
      h('span'), bind('showProgressOnStart', chk(t('showOnStart'), s.showProgressOnStart)),
      h('span'), bind('showCompleteDialog', chk(t('showOnComplete'), s.showCompleteDialog)),
      h('span'), bind('sound', chk(t('playSound'), s.sound)),
      lbl('duplicate'), bind('duplicate', sel([['rename', t('dupRename')], ['overwrite', t('dupOverwrite')]], s.duplicate)),
      h('span'), bind('hlsToMp4', chk(t('hlsMp4'), s.hlsToMp4)),
      lbl('ffmpegPath'), h('div', { class: 'row' }, ffIn, h('button', { class: 'btn sm', onclick: async () => { const f = await api.call('chooseFile', ffIn.value); if (f) { ffIn.value = f; s.ffmpegPath = f; } } }, '…')),
      h('span'), h('div', { class: 'hint', style: { color: S().ffmpeg ? 'var(--ok)' : 'var(--warn)' } }, S().ffmpeg ? t('ffmpegFound') + ': ' + S().ffmpeg : t('ffmpegMissing')),
      h('div', { class: 'full' }, componentsBox()));
    // Site logins
    const loginTable = h('table', { class: 'mini' });
    const drawLogins = (list) => {
      loginTable.innerHTML = `<tr><th>${esc(t('host'))}</th><th>${esc(t('user'))}</th><th>${esc(t('pass'))}</th><th style="width:30px"></th></tr>`;
      for (const l of list) loginTable.append(h('tr', {}, h('td', { class: 'mono' }, l.host), h('td', {}, l.user), h('td', {}, '••••••'),
        h('td', {}, h('button', { class: 'btn sm danger', onclick: async () => drawLogins(await api.call('removeLogin', l.host)) }, '✕'))));
    };
    drawLogins(S().logins);
    const lh = field({ placeholder: 'example.com', class: 'field mono' }); const lu = field({ placeholder: t('user') }); const lp = field({ type: 'password', placeholder: t('pass') });
    const logins = h('div', {}, h('div', { class: 'list', style: { maxHeight: '200px', marginBottom: '10px' } }, loginTable),
      h('div', { class: 'row' }, lh, lu, lp, h('button', { class: 'btn', onclick: async () => { if (!lh.value) return; drawLogins(await api.call('saveLogin', { host: lh.value.trim(), user: lu.value, pass: lp.value })); lh.value = lu.value = lp.value = ''; } }, t('addLogin'))));
    // Browser
    const browser = h('div', {},
      h('div', { class: 'form' },
        h('span'), bind('browserIntegration', chk(t('enableBridge'), s.browserIntegration)),
        lbl('bridgePort'), bind('bridgePort', field({ type: 'number', value: s.bridgePort, style: { width: '120px' } })),
        h('span'), bind('silentBridge', chk(t('silentBridge'), s.silentBridge))),
      h('div', { class: 'hint', style: { margin: '14px 0 10px', lineHeight: 1.9 }, html: t('extSteps') }),
      h('button', { class: 'btn', onclick: () => api.call('extensionDir') }, t('installExt')));

    const body = tabs([
      { label: t('o_general'), content: gen }, { label: t('o_types'), content: types }, { label: t('o_conn'), content: conn },
      { label: t('o_saveto'), content: saveTo }, { label: t('o_downloads'), content: dls }, { label: t('o_logins'), content: logins }, { label: t('o_browser'), content: browser },
    ]);
    modal({
      title: t('options'), body, width: 720, iconName: 'opt',
      buttons: ['sp', { label: t('ok'), cls: 'primary', onClick: async () => {
        try {
          for (const c of cats) if (c._dirty) await api.call('saveCategory', c);
          for (const n of removedCats) await api.call('removeCategory', n);
          const patch = {};
          for (const k of Object.keys(s)) if (JSON.stringify(s[k]) !== JSON.stringify(S().settings[k])) patch[k] = s[k];
          if (Object.keys(patch).length) await api.call('saveSettings', patch);
        } catch (e) { toast(e.message, true); return false; }
      } }, { label: t('cancel') }],
    });
  }

  /* ---------------- Scheduler & queues ---------------- */
  function scheduler(qid = 'main') {
    let queues = S().queues.map(q => ({ ...q, days: [...q.days] }));
    if (qid === '__new') { const n = { _id: '', name: t('q_new'), maxConcurrent: 2, startEnabled: false, startTime: '02:00', stopEnabled: false, stopTime: '07:00', days: [0, 1, 2, 3, 4, 5, 6], afterDone: 'none', retryFailed: 3, _new: true }; queues.push(n); qid = '__new'; }
    let cur = queues.find(q => (q._id || '__new') === qid) || queues[0];
    const listEl = h('div', { class: 'list', style: { width: '200px', maxHeight: '300px', flex: 'none' } });
    const pane = h('div', { style: { flex: 1, minWidth: 0 } });
    const drawList = () => {
      listEl.innerHTML = '';
      for (const q of queues) {
        const li = h('div', { class: 'li' + (q === cur ? ' sel' : '') }, h('span', { html: icon('queue', '#2563eb', 16) }), t(q.name), S().runningQueues.has(q._id) ? h('i', { class: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--ok)', marginInlineStart: 'auto' } }) : '');
        li.onclick = () => { collect(); cur = q; drawList(); drawPane(); };
        listEl.append(li);
      }
    };
    let collect = () => {};
    const drawPane = () => {
      pane.innerHTML = '';
      const q = cur;
      const name = field({ value: t(q.name), disabled: q.builtin, style: { width: '100%' } });
      const se = chk(t('q_startAt'), q.startEnabled); const stt = field({ type: 'time', value: q.startTime, style: { width: '120px' } });
      const ee = chk(t('q_stopAt'), q.stopEnabled); const ett = field({ type: 'time', value: q.stopTime, style: { width: '120px' } });
      const days = h('div', { class: 'days' }, ...t('days').map((d, i) => { const c = h('input', { type: 'checkbox' }); c.checked = q.days.includes(i); c.dataset.d = i; return h('label', {}, c, d); }));
      const max = field({ type: 'number', min: 1, max: 20, value: q.maxConcurrent, style: { width: '90px' } });
      const retry = field({ type: 'number', min: 0, max: 20, value: q.retryFailed, style: { width: '90px' } });
      const after = sel([['none', t('a_none')], ['exit', t('a_exit')], ['shutdown', t('a_shutdown')]], q.afterDone);
      collect = () => {
        if (!q.builtin) q.name = name.value.trim() || q.name;
        q.startEnabled = se.querySelector('input').checked; q.startTime = stt.value || '02:00';
        q.stopEnabled = ee.querySelector('input').checked; q.stopTime = ett.value || '07:00';
        q.days = $$('input', days).filter(c => c.checked).map(c => Number(c.dataset.d));
        q.maxConcurrent = Math.max(1, Number(max.value) || 1); q.retryFailed = Math.max(0, Number(retry.value) || 0); q.afterDone = after.value;
      };
      const sch = h('div', { class: 'form' }, lbl('q_name'), name, h('span'), h('div', { class: 'row' }, se, stt), lbl('q_days'), days, h('span'), h('div', { class: 'row' }, ee, ett));
      const files = h('div', { class: 'list', style: { maxHeight: '260px', direction: 'ltr' } });
      const drawFiles = () => {
        files.innerHTML = '';
        const list = [...APP.S.downloads.values()].filter(d => d.queueId === q._id).sort((a, b) => a.position - b.position);
        for (const d of list) {
          files.append(h('div', { class: 'li' }, h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.fileName),
            h('span', { class: 'muted', style: { fontSize: '11px' } }, d.status === 'complete' ? t('s_complete') : ''),
            h('button', { class: 'btn sm', onclick: async () => { await api.call('reorder', d._id, -1); setTimeout(drawFiles, 80); } }, '▲'),
            h('button', { class: 'btn sm', onclick: async () => { await api.call('reorder', d._id, 1); setTimeout(drawFiles, 80); } }, '▼'),
            h('button', { class: 'btn sm danger', onclick: async () => { await api.call('moveToQueue', [d._id], ''); setTimeout(drawFiles, 80); } }, '✕')));
        }
        if (!list.length) files.append(h('div', { class: 'li muted' }, '—'));
      };
      drawFiles();
      const set = h('div', { class: 'form' }, lbl('q_max'), max, lbl('q_retry'), retry, lbl('q_after'), after);
      pane.append(tabs([{ label: t('q_schedule'), content: sch }, { label: t('q_files'), content: files, onShow: drawFiles }, { label: t('q_settings'), content: set }]));
      const run = S().runningQueues.has(q._id);
      pane.append(h('div', { class: 'row', style: { marginTop: '14px' } },
        h('button', { class: 'btn', disabled: run || !q._id, onclick: async () => { collect(); await saveCur(); await api.call('startQueue', q._id); drawList(); drawPane(); } }, '▶ ' + t('startNowQ')),
        h('button', { class: 'btn', disabled: !run, onclick: async () => { await api.call('stopQueue', q._id); setTimeout(() => { drawList(); drawPane(); }, 100); } }, '■ ' + t('stopNowQ')),
        h('span', { class: 'grow' }),
        !q.builtin && q._id ? h('button', { class: 'btn danger', onclick: async () => { await api.call('removeQueue', q._id); queues = queues.filter(x => x !== q); cur = queues[0]; drawList(); drawPane(); } }, t('delete')) : ''));
    };
    const saveCur = async () => {
      const q = cur; const data = { ...q }; delete data._new;
      if (!data._id) delete data._id;
      const saved = await api.call('saveQueue', data);
      Object.assign(q, saved); delete q._new;
    };
    drawList(); drawPane();
    const body = h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } },
      h('div', {}, listEl, h('button', { class: 'btn sm', style: { marginTop: '8px', width: '100%' }, onclick: () => { collect(); const n = { _id: '', name: t('q_new'), maxConcurrent: 2, startEnabled: false, startTime: '02:00', stopEnabled: false, stopTime: '07:00', days: [0, 1, 2, 3, 4, 5, 6], afterDone: 'none', retryFailed: 3, _new: true }; queues.push(n); cur = n; drawList(); drawPane(); } }, '+ ' + t('q_new'))),
      pane);
    modal({
      title: t('scheduler'), body, width: 780, iconName: 'sched',
      buttons: ['sp', { label: t('apply'), cls: 'primary', onClick: async () => { collect(); for (const q of queues) { const d = { ...q }; delete d._new; if (!d._id) delete d._id; await api.call('saveQueue', d); } } }, { label: t('close') }],
    });
  }

  /* ---------------- Components (yt-dlp / FFmpeg) ---------------- */
  function componentsBox() {
    const box = h('fieldset', { style: { margin: '6px 0 0' } }, h('legend', {}, t('components')));
    const body = h('div', { class: 'form', style: { gridTemplateColumns: '130px 1fr' } });
    const log = h('pre', { class: 'mono hint hidden', style: { whiteSpace: 'pre-wrap', margin: '8px 0 0', maxHeight: '90px', overflow: 'auto', direction: 'ltr' } });
    const draw = (st) => {
      body.replaceChildren(
        lbl('compYtdlp'), h('span', { class: 'mono', style: { color: st.ytdlp ? 'var(--ok)' : 'var(--warn)' } }, st.ytdlp ? (st.ytdlp.version || '✓') : t('notInstalled')),
        lbl('compFfmpeg'), h('span', { class: 'mono', style: { color: st.ffmpeg ? 'var(--ok)' : 'var(--warn)' } }, st.ffmpeg ? '✓ ' + st.ffmpeg.path : t('notInstalled')),
        lbl('compJs'), h('span', { class: 'mono', style: { color: 'var(--ok)' } }, '✓ ' + st.jsRuntime),
        h('span'), h('div', { class: 'hint' }, t('compHint')));
    };
    const busy = (b, btn) => { btn.disabled = b; btn.textContent = b ? t('computing') : btn.dataset.l; };
    const inst = h('button', { class: 'btn sm', 'data-l': t('compInstall') }, t('compInstall'));
    const upd = h('button', { class: 'btn sm', 'data-l': t('compUpdate') }, t('compUpdate'));
    inst.onclick = async () => { busy(true, inst); try { draw(await api.call('componentsInstall')); } catch (e) { toast(e.message, true); } busy(false, inst); };
    upd.onclick = async () => { busy(true, upd); try { const r = await api.call('componentsUpdate'); draw(r.status); log.textContent = r.log; log.classList.remove('hidden'); } catch (e) { toast(e.message, true); } busy(false, upd); };
    box.append(body, h('div', { class: 'row', style: { marginTop: '8px' } }, inst, upd), log);
    body.append(h('span', { class: 'spinner' }));
    api.call('components').then(draw).catch(() => {});
    return box;
  }

  /* ---------------- Checksum ---------------- */
  function verify(d) {
    const algo = sel([['sha256', 'SHA-256'], ['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha512', 'SHA-512']], 'sha256');
    const expected = field({ class: 'field mono', dir: 'ltr', placeholder: 'e3b0c442…', style: { width: '100%' } });
    const out = h('div', { class: 'mono', style: { direction: 'ltr', wordBreak: 'break-all', userSelect: 'text', minHeight: '20px' } });
    const verdict = h('div', { style: { fontWeight: 700, marginTop: '6px' } });
    const run = async () => {
      out.textContent = t('computing'); verdict.textContent = '';
      try {
        const hex = await api.call('checksum', d._id, algo.value);
        out.textContent = hex;
        const exp = expected.value.trim().toLowerCase();
        if (exp) { const okk = exp === hex; verdict.textContent = t(okk ? 'match' : 'mismatch'); verdict.style.color = okk ? 'var(--ok)' : 'var(--err)'; }
      } catch (e) { out.textContent = e.message; }
    };
    const form = h('div', { class: 'form' }, lbl('fileName'), h('b', { dir: 'auto' }, d.fileName), lbl('algo'), algo, lbl('expected'), expected, h('span'), h('div', {}, out, verdict));
    modal({ title: t('verifyTitle'), body: form, width: 600, iconName: 'check', buttons: [{ label: t('compute'), cls: 'primary', onClick: () => { run(); return false; } }, 'sp', { label: t('close') }] });
  }

  /* ---------------- Browser setup wizard ---------------- */
  const BR_ICON = { chrome: '#4285f4', edge: '#0c8484', brave: '#fb542b', opera: '#ff1b2d', operagx: '#ff1b2d', vivaldi: '#ef3939', yandex: '#fc3f1d', firefox: '#ff7139', chromium: '#4a90d9' };
  function browserSetup(firstRun) {
    const pathBox = h('div', { class: 'field mono', dir: 'ltr', style: { display: 'flex', alignItems: 'center', height: 'auto', padding: '6px 9px', wordBreak: 'break-all', userSelect: 'text', fontSize: '11.5px' } });
    const table = h('div', { class: 'list' });
    const steps = h('ol', { class: 'hint', style: { margin: '10px 0 0', paddingInlineStart: '20px', lineHeight: 1.9 } },
      h('li', {}, t('bs_step1')), h('li', {}, t('bs_step2')), h('li', {}, t('bs_step3')), h('li', {}, t('bs_step4')));
    const intro = h('p', { style: { margin: '0 0 10px', lineHeight: 1.7 } }, t('bs_intro'));
    let info = null;
    const draw = (d) => {
      info = d;
      pathBox.textContent = d.extDir ? d.extDir.replace(/[\\/]$/, '') + (d.extDir.includes('\\') ? '\\' : '/') + 'chromium' : '';
      table.replaceChildren();
      const conn = (id) => d.connected.find(c => c.browser === id || (id === 'operagx' && c.browser === 'opera'));
      const list = d.list.length ? d.list : [{ id: 'chrome', name: 'Google Chrome', kind: 'chromium', missing: true }];
      for (const b of list) {
        const c = conn(b.id);
        const status = c ? h('b', { style: { color: 'var(--ok)' } }, `✓ ${t('bs_connected')}${c.ext ? ' · v' + c.ext : ''}`) : h('span', { class: 'muted' }, t('bs_notConnected'));
        const btn = b.missing ? (c ? h('span') : h('span', { class: 'hint' }, t('bs_noBrowsers'))) : h('button', { class: 'btn sm' + (c ? '' : ' primary'), onclick: async () => {
          try { await api.call('openBrowserExt', b.id); toast(t('bs_opened', b.name)); } catch (e) { toast(e.message, true); }
        } }, c ? t('bs_reopen') : t('bs_install'));
        table.append(h('div', { class: 'li', style: { cursor: 'default' } },
          h('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: BR_ICON[b.id] || '#64748b', flex: 'none' } }),
          h('b', { style: { minWidth: '120px' } }, b.name), h('span', { style: { flex: 1 } }, status), btn));
      }
      for (const c of d.connected) {
        if (!list.some(b => b.id === c.browser || (b.id === 'operagx' && c.browser === 'opera'))) {
          const NM = { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', yandex: 'Yandex', firefox: 'Firefox' };
          table.append(h('div', { class: 'li', style: { cursor: 'default' } }, h('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: BR_ICON[c.browser] || '#64748b', flex: 'none' } }), h('b', { style: { minWidth: '120px' } }, NM[c.browser] || c.browser), h('b', { style: { color: 'var(--ok)', flex: 1 } }, `✓ ${t('bs_connected')} · v${c.ext}`)));
        }
      }
    };
    const body = h('div', {}, intro, table,
      h('div', { style: { margin: '12px 0 4px', fontWeight: 600 } }, t('bs_path')),
      h('div', { class: 'row' }, pathBox,
        h('button', { class: 'btn sm', onclick: async () => { await api.call('copyText', pathBox.textContent); toast(t('copied')); } }, t('copyUrl').replace(/الرابط|URL/, '').trim() || 'Copy'),
        h('button', { class: 'btn sm', onclick: () => api.call('extensionDir', 'chromium') }, t('openFolder'))),
      steps,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, t('bs_auto')));
    const refresh = () => api.call('browsers').then(draw).catch(() => {});
    refresh();
    const iv = setInterval(refresh, 2000);
    modal({
      title: t('bs_title'), body, width: 640, iconName: 'logo', onClose: () => clearInterval(iv),
      buttons: [{ label: t('bs_firefox'), onClick: () => { api.call('extensionDir', 'firefox'); return false; } }, 'sp', { label: firstRun ? t('bs_later') : t('close'), cls: 'primary' }],
    });
  }

  /* ---------------- misc ---------------- */
  function info(title, html) { modal({ title, body: html, width: 560, buttons: ['sp', { label: t('close'), cls: 'primary' }] }); }
  function integration() {
    const s = S().settings;
    const body = h('div', {}, h('p', { style: { marginTop: 0 } }, t('enableBridge') + ': ', h('b', { style: { color: s.browserIntegration ? 'var(--ok)' : 'var(--err)' } }, t(s.browserIntegration ? 'yes' : 'no')),
      h('span', { class: 'mono muted' }, `  http://127.0.0.1:${s.bridgePort}`)), h('div', { style: { lineHeight: 1.9 }, html: t('extSteps') }));
    modal({ title: t('browserIntegration'), body, width: 560, iconName: 'logo', buttons: [{ label: t('installExt'), onClick: () => { api.call('extensionDir'); return false; } }, 'sp', { label: t('close'), cls: 'primary' }] });
  }
  async function about() {
    const i = await api.call('appInfo');
    const body = h('div', { class: 'row', style: { gap: '18px', alignItems: 'flex-start' } }, h('div', { html: icon('logo', '#2563eb', 64) }),
      h('div', {}, h('div', { style: { fontSize: '18px', fontWeight: 700 } }, 'Barq Download Manager'),
        h('div', { class: 'muted mono' }, `v${i.version} · Electron ${i.electron}`),
        h('div', { style: { marginTop: '6px' } }, t('dbEngine') + ': ', h('b', { style: { color: i.engine === 'realm' ? 'var(--ok)' : 'var(--warn)' } }, i.engine === 'realm' ? 'Realm ' + i.realm : t('dbFallback'))),
        i.engine !== 'realm' ? h('div', { class: 'hint' }, t('dbFallbackHint')) : '',
        h('p', {}, t('aboutText')), h('div', { class: 'hint mono' }, i.userData)));
    modal({ title: t('about'), body, width: 520, buttons: ['sp', { label: t('close'), cls: 'primary' }] });
  }

  window.DLG = { browserSetup, verify, addUrl, fileInfo, batch, properties, category, speedLimit, options, scheduler, info, integration, about };
})();
