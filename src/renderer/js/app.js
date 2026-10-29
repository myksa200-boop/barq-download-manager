/* النافذة الرئيسية: القوائم، شريط الأدوات، شجرة التصنيفات، جدول الملفات، شريط الحالة */
(function () {
  const { $, $$, h, esc, ltr, icon, fileColor, fmtSize, fmtSpeed, fmtTime, fmtDate, pct, toast, showMenu, closeMenus } = UI;
  const api = window.api;

  const S = {
    downloads: new Map(), categories: [], queues: [], settings: {}, logins: [], runningQueues: new Set(),
    progress: {}, ffmpeg: null, root: '',
    view: { type: 'all', id: '' }, sel: new Set(), anchor: null,
    sort: { key: 'added', asc: true }, filter: '', showSidebar: true,
  };
  window.APP = { S, refreshAll, renderGrid, renderTree, selected: () => [...S.sel].map(id => S.downloads.get(id)).filter(Boolean) };

  const ACTIVE = ['connecting', 'downloading', 'merging'];
  const COLS = [
    { key: 'name', t: 'c_name', w: 270 },
    { key: 'q', t: 'c_q', w: 30 },
    { key: 'size', t: 'c_size', w: 88 },
    { key: 'status', t: 'c_status', w: 150 },
    { key: 'left', t: 'c_left', w: 95 },
    { key: 'rate', t: 'c_rate', w: 95 },
    { key: 'last', t: 'c_last', w: 125 },
    { key: 'desc', t: 'c_desc', w: 140 },
  ];

  /* ================= data ================= */
  async function load() {
    const st = await api.call('state');
    applyState(st);
  }
  function applyState(st) {
    S.downloads = new Map(st.downloads.map(d => [d._id, d]));
    S.categories = st.categories; S.queues = st.queues; S.settings = st.settings; S.logins = st.logins;
    S.runningQueues = new Set(st.runningQueues); S.progress = st.progress || {}; S.ffmpeg = st.ffmpeg; S.root = st.root;
    if (S.settings.columns) S.settings.columns.forEach((w, i) => { if (COLS[i] && w > 20) COLS[i].w = w; });
    UI.applyTheme(S.settings.theme);
    I18N.set(S.settings.lang);
    refreshAll();
  }
  function refreshAll() { buildHeader(); renderTree(); renderGrid(); renderStatus(); updateToolbar(); }

  /* ================= filtering & sorting ================= */
  function inView(d) {
    const v = S.view;
    if (v.type === 'cat' && d.category !== v.id) return false;
    if (v.type === 'unfinished' && d.status === 'complete') return false;
    if (v.type === 'finished' && d.status !== 'complete') return false;
    if (v.type === 'queue' && d.queueId !== v.id) return false;
    if (S.filter) {
      const f = S.filter.toLowerCase();
      if (!d.fileName.toLowerCase().includes(f) && !d.url.toLowerCase().includes(f) && !(d.description || '').toLowerCase().includes(f)) return false;
    }
    return true;
  }
  function liveDl(d) { const p = S.progress[d._id]; return p && ACTIVE.includes(d.status) ? p.downloaded : d.downloaded; }
  function liveSize(d) { const p = S.progress[d._id]; return d.size > 0 ? d.size : (p && p.size > 0 ? p.size : -1); }
  function sortVal(d, k) {
    switch (k) {
      case 'name': return d.fileName.toLowerCase();
      case 'q': return d.queueId ? qIndex(d.queueId) : 99;
      case 'size': return liveSize(d);
      case 'status': return d.status === 'complete' ? 200 : pct(liveDl(d), liveSize(d));
      case 'left': return S.progress[d._id]?.eta ?? 1e12;
      case 'rate': return S.progress[d._id]?.speed ?? 0;
      case 'last': return d.lastTry || d.createdAt || 0;
      case 'desc': return (d.description || d.error || '').toLowerCase();
      case 'pos': return d.position;
      default: return d.createdAt || 0;
    }
  }
  function visibleList() {
    const list = [...S.downloads.values()].filter(inView);
    const k = S.view.type === 'queue' && S.sort.key === 'added' ? 'pos' : S.sort.key;
    list.sort((a, b) => { const x = sortVal(a, k), y = sortVal(b, k); return (x < y ? -1 : x > y ? 1 : 0) * (S.sort.asc ? 1 : -1); });
    return list;
  }
  function qIndex(id) { const i = S.queues.findIndex(q => q._id === id); return i < 0 ? '' : i + 1; }

  /* ================= grid ================= */
  function buildHeader() {
    const cg = $('#grid colgroup'); cg.innerHTML = '';
    const tr = $('#grid thead tr'); tr.innerHTML = '';
    COLS.forEach((c, i) => {
      cg.append(h('col', { style: { width: c.w + 'px' } }));
      const th = h('th', { 'data-k': c.key, class: S.sort.key === c.key ? 'sorted' + (S.sort.asc ? ' asc' : '') : '' }, t(c.t));
      th.onclick = (e) => {
        if (e.target.classList.contains('rs')) return;
        if (S.sort.key === c.key) S.sort.asc = !S.sort.asc; else { S.sort.key = c.key; S.sort.asc = true; }
        buildHeader(); renderGrid();
      };
      const rs = h('span', { class: 'rs' });
      rs.onmousedown = (e) => startResize(e, i);
      th.append(rs);
      tr.append(th);
    });
  }
  function startResize(e, i) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX; const startW = COLS[i].w;
    const rtl = document.documentElement.dir === 'rtl';
    const col = $$('#grid col')[i];
    const mv = (ev) => { COLS[i].w = Math.max(30, startW + (ev.clientX - startX) * (rtl ? -1 : 1)); col.style.width = COLS[i].w + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      api.call('saveSettings', { columns: COLS.map(c => c.w) });
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }

  const rowEls = new Map();
  function renderGrid() {
    const tb = $('#grid tbody');
    const list = visibleList();
    tb.innerHTML = ''; rowEls.clear();
    for (const id of [...S.sel]) if (!S.downloads.has(id)) S.sel.delete(id);
    const frag = document.createDocumentFragment();
    for (const d of list) {
      const tr = h('tr', { 'data-id': d._id, class: S.sel.has(d._id) ? 'sel' : '' });
      COLS.forEach(() => tr.append(h('td')));
      fillRow(tr, d);
      rowEls.set(d._id, tr);
      frag.append(tr);
    }
    tb.append(frag);
    const empty = $('#empty');
    empty.classList.toggle('hidden', list.length > 0);
    if (!list.length) empty.innerHTML = `${icon('empty', 'var(--muted)', 64)}<div style="font-size:15px;margin-top:8px">${esc(t('emptyTitle'))}</div><div class="hint" style="margin-top:4px">${esc(t('emptyHint'))}</div>`;
    renderTree(true);
  }
  function statusCell(d) {
    const size = liveSize(d), dl = liveDl(d);
    if (d.status === 'complete') return `<span class="st-complete">${esc(t('s_complete'))}</span>`;
    if (d.status === 'error') return `<span class="st-error" title="${esc(d.error)}">${esc(t('s_error'))}${dl > 0 && size > 0 ? ' ' + pct(dl, size).toFixed(1) + '%' : ''}</span>`;
    if (d.status === 'connecting') return `<span class="st-active">${esc(t('s_connecting'))}</span>`;
    if (d.status === 'merging') return `<span class="st-active">${esc(t('s_merging'))}</span>`;
    if (d.status === 'downloading') {
      if (size > 0) { const p = pct(dl, size); return `<span class="cellbar st-active"><span>${p.toFixed(2)}%</span><i><b style="width:${p}%"></b></i></span>`; }
      return `<span class="st-active">${ltr(fmtSize(dl))}</span>`;
    }
    if (d.status === 'queued') return `<span class="st-queued">${esc(t('s_queued'))}</span>`;
    if (dl > 0 && size > 0) return `<span class="st-paused">${esc(t('s_paused'))} ${pct(dl, size).toFixed(1)}%</span>`;
    return '';
  }
  function fillRow(tr, d) {
    const p = S.progress[d._id];
    const active = ACTIVE.includes(d.status);
    const c = tr.children;
    c[0].innerHTML = `<div class="fname"><i class="ficon" style="background:${fileColor(d.fileName, d.category)}"></i><span class="ltr-text" dir="auto">${esc(d.fileName)}</span></div>`;
    c[0].title = d.url;
    c[1].textContent = d.queueId ? qIndex(d.queueId) : '';
    c[2].innerHTML = ltr(fmtSize(liveSize(d)));
    c[3].innerHTML = statusCell(d);
    c[4].textContent = active && p ? fmtTime(p.eta) : '';
    c[5].innerHTML = active && p ? ltr(fmtSpeed(p.speed)) : '';
    c[6].textContent = fmtDate(d.lastTry || d.createdAt);
    c[7].textContent = d.status === 'error' ? d.error : (d.description || '');
    c[7].title = c[7].textContent;
  }
  function updateRow(id) {
    const d = S.downloads.get(id);
    const tr = rowEls.get(id);
    if (!d) { tr && tr.remove(); rowEls.delete(id); return; }
    if (!tr) { if (inView(d)) renderGrid(); return; }
    if (!inView(d)) { renderGrid(); return; }
    fillRow(tr, d);
  }

  /* ================= selection ================= */
  function setSel(ids, anchor) {
    S.sel = new Set(ids);
    if (anchor !== undefined) S.anchor = anchor;
    for (const [id, tr] of rowEls) tr.classList.toggle('sel', S.sel.has(id));
    updateToolbar();
  }
  $('#grid tbody').addEventListener('mousedown', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = tr.dataset.id;
    if (e.button === 2 && S.sel.has(id)) return;
    if (e.shiftKey && S.anchor) {
      const ids = [...rowEls.keys()];
      const a = ids.indexOf(S.anchor), b = ids.indexOf(id);
      setSel(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(S.sel); s.has(id) ? s.delete(id) : s.add(id); setSel([...s], id);
    } else setSel([id], id);
  });
  $('#gridwrap').addEventListener('mousedown', (e) => { if (!e.target.closest('tr') && !e.target.closest('th')) setSel([]); });
  $('#grid tbody').addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const d = S.downloads.get(tr.dataset.id);
    if (d.status === 'complete') api.call('open', d._id).catch(err => toast(err.message, true));
    else api.call('openProgress', d._id);
  });
  $('#grid tbody').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!e.target.closest('tr')) return;
    rowMenu(e.clientX, e.clientY);
  });
  $('#gridwrap').addEventListener('contextmenu', (e) => {
    if (e.target.closest('tr')) return;
    e.preventDefault();
    showMenu([{ label: t('addNew'), action: () => DLG.addUrl() }, { label: t('addBatch'), action: () => DLG.batch() }], e.clientX, e.clientY, 'ctxmenu');
  });

  function sel() { return APP.selected(); }

  function rowMenu(x, y) {
    const items = sel(); if (!items.length) return;
    const one = items.length === 1 ? items[0] : null;
    const canStart = items.some(d => !ACTIVE.includes(d.status) && d.status !== 'complete');
    const canStop = items.some(d => ACTIVE.includes(d.status) || d.status === 'queued');
    const inQueueView = S.view.type === 'queue';
    showMenu([
      one && one.status === 'complete' && { label: t('open'), key: 'Enter', action: () => api.call('open', one._id) },
      one && { label: t('openFolder'), action: () => api.call('openFolder', one._id) },
      one && one.status !== 'complete' && { label: t('showProgress'), action: () => api.call('openProgress', one._id) },
      '-',
      { label: t('downloadNow'), disabled: !canStart, action: () => cmd('resume') },
      { label: t('stop'), disabled: !canStop, action: () => cmd('stop') },
      one && { label: t('redownload'), action: () => api.call('redownload', one._id) },
      '-',
      { label: t('moveToQueue'), sub: S.queues.map(q => ({ label: t(q.name), radio: items.every(d => d.queueId === q._id), action: () => api.call('moveToQueue', items.map(d => d._id), q._id) })) },
      items.some(d => d.queueId) && { label: t('removeFromQueue'), action: () => api.call('moveToQueue', items.map(d => d._id), '') },
      inQueueView && one && { label: t('moveUp'), action: () => api.call('reorder', one._id, -1) },
      inQueueView && one && { label: t('moveDown'), action: () => api.call('reorder', one._id, 1) },
      '-',
      { label: t('copyUrl'), action: () => { navigator.clipboard.writeText(items.map(d => d.url).join('\n')); toast(t('copied')); } },
      items.length === 2 && { label: t('merge'), action: () => doMerge(items) },
      one && one.status === 'complete' && { label: t('verify'), action: () => DLG.verify(one) },
      { label: t('exportList'), action: () => api.call('exportList', items.map(d => d._id)) },
      '-',
      { label: t('remove'), key: 'Del', action: () => cmd('delete') },
      one && { label: t('properties'), action: () => DLG.properties(one) },
    ], x, y, 'ctxmenu');
  }

  async function doMerge(items) {
    const v = items.find(d => /\.(mp4|webm|mkv|m4v)$/i.test(d.fileName) && !/audio/i.test(d.fileName)) || items[0];
    const a = items.find(d => d !== v);
    if (!v || !a || v.status !== 'complete' || a.status !== 'complete') return toast(t('selectTwo'), true);
    try { const r = await api.call('merge', v._id, a._id); toast(t('mergeDone', r.fileName)); } catch (e) { toast(e.message, true); }
  }

  /* ================= tree ================= */
  function renderTree(countsOnly) {
    const all = [...S.downloads.values()];
    const cnt = (f) => all.filter(f).length;
    if (countsOnly && $('#tree').childElementCount) {
      $$('#tree .tree-item').forEach(el => { const f = treeFilters[el.dataset.key]; if (f) el.querySelector('.cnt').textContent = cnt(f) || ''; });
      return;
    }
    const tree = $('#tree'); tree.innerHTML = '';
    treeFilters = {};
    const item = (key, label, lvl, ic, color, view, filter, extra = '') => {
      treeFilters[key] = filter;
      const el = h('div', { class: `tree-item l${lvl}` + (S.view.type === view.type && S.view.id === view.id ? ' sel' : ''), 'data-key': key });
      el.innerHTML = `${icon(ic, color, 16)}<span>${esc(label)}</span>${extra}<span class="cnt">${filter ? (cnt(filter) || '') : ''}</span>`;
      el.onclick = () => { S.view = view; setSel([]); renderTree(); renderGrid(); };
      el.oncontextmenu = (e) => { e.preventDefault(); treeMenu(view, e.clientX, e.clientY); };
      tree.append(el);
    };
    item('root', t('cat_root'), 0, 'folder', '#f2b632', { type: 'all', id: '' }, null);
    item('all', t('cat_all'), 1, 'folder', '#f2b632', { type: 'all', id: '' }, () => true);
    for (const c of S.categories) item('c:' + c.name, t(c.name), 2, 'folder', UI.CAT_COLORS[c.name] || '#60a5fa', { type: 'cat', id: c.name }, d => d.category === c.name);
    item('c:General', t('General'), 2, 'folder', '#94a3b8', { type: 'cat', id: 'General' }, d => d.category === 'General' || !S.categories.some(c => c.name === d.category));
    item('unf', t('unfinished'), 1, 'folder', '#f59e0b', { type: 'unfinished', id: '' }, d => d.status !== 'complete');
    item('fin', t('finished'), 1, 'folder', '#16a34a', { type: 'finished', id: '' }, d => d.status === 'complete');
    item('qroot', t('queues'), 0, 'queue', '#2563eb', { type: 'queues', id: '' }, null);
    for (const q of S.queues) item('q:' + q._id, t(q.name), 1, 'queue', '#2563eb', { type: 'queue', id: q._id }, d => d.queueId === q._id, S.runningQueues.has(q._id) ? '<i class="dot" title="running"></i>' : '');
  }
  let treeFilters = {};
  function treeMenu(view, x, y) {
    if (view.type === 'cat') {
      const c = S.categories.find(c => c.name === view.id);
      showMenu([
        c && { label: t('editCat'), action: () => DLG.category(c) },
        { label: t('addCat'), action: () => DLG.category(null) },
        c && { label: t('removeCat'), action: () => api.call('removeCategory', c.name) },
      ], x, y, 'ctxmenu');
    } else if (view.type === 'queue') {
      const run = S.runningQueues.has(view.id);
      showMenu([
        { label: t('startNowQ'), disabled: run, action: () => api.call('startQueue', view.id) },
        { label: t('stopNowQ'), disabled: !run, action: () => api.call('stopQueue', view.id) },
        '-',
        { label: t('scheduler'), action: () => DLG.scheduler(view.id) },
      ], x, y, 'ctxmenu');
    } else if (view.type === 'queues') {
      showMenu([{ label: t('q_new'), action: () => DLG.scheduler('__new') }], x, y, 'ctxmenu');
    }
  }

  /* ================= status bar & toolbar ================= */
  function renderStatus() {
    const all = [...S.downloads.values()];
    const active = all.filter(d => ACTIVE.includes(d.status));
    const speed = active.reduce((a, d) => a + (S.progress[d._id]?.speed || 0), 0);
    const rq = [...S.runningQueues].map(id => t(S.queues.find(q => q._id === id)?.name || id));
    const lim = S.settings.speedLimit > 0 ? t('speedOn', S.settings.speedLimit) : '';
    $('#statusbar').innerHTML = `<span>${esc(t('active'))}: <b>${active.length}</b></span><span>${esc(t('totalSpeed'))}: <b>${ltr(fmtSpeed(speed) || '0 B/s')}</b></span>` +
      `<span>${rq.length ? esc(rq.join('، ')) + ' — ' + esc(t('queueRunning')) : esc(t('noQueue'))}</span>${lim ? `<span>${esc(lim)}</span>` : ''}<span class="sp">${all.length} ${esc(t('items'))}</span>`;
    document.title = active.length ? `${active.length} ↓ ${fmtSpeed(speed)} — Barq` : 'Barq Download Manager';
  }
  function updateToolbar() {
    const items = sel();
    const tb = (c) => $(`.tb[data-cmd="${c}"]`);
    tb('resume').disabled = !items.some(d => !ACTIVE.includes(d.status) && d.status !== 'complete');
    tb('stop').disabled = !items.some(d => ACTIVE.includes(d.status) || d.status === 'queued');
    tb('delete').disabled = !items.length;
    const qid = S.view.type === 'queue' ? S.view.id : 'main';
    tb('startQueue').disabled = S.runningQueues.has(qid);
    tb('stopQueue').disabled = !S.runningQueues.size;
  }

  /* ================= commands ================= */
  async function cmd(c) {
    const items = sel();
    try {
      switch (c) {
        case 'add': return DLG.addUrl();
        case 'resume': return api.call('start', items.filter(d => !ACTIVE.includes(d.status) && d.status !== 'complete').map(d => d._id));
        case 'stop': return api.call('pause', items.map(d => d._id));
        case 'stopAll': return api.call('stopAll');
        case 'delete': {
          if (!items.length) return;
          const box = h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'delfiles' }), t('deleteFiles'));
          const hasDone = items.some(d => d.status === 'complete');
          if (await UI.confirmBox(t('confirmDelete', items.length), hasDone ? box : null)) {
            await api.call('remove', items.map(d => d._id), hasDone && box.querySelector('input').checked);
          }
          return;
        }
        case 'deleteCompleted': return api.call('removeCompleted');
        case 'options': return DLG.options();
        case 'scheduler': return DLG.scheduler(S.view.type === 'queue' ? S.view.id : 'main');
        case 'startQueue': return api.call('startQueue', S.view.type === 'queue' ? S.view.id : 'main');
        case 'stopQueue': return api.call('stopQueue', S.view.type === 'queue' && S.runningQueues.has(S.view.id) ? S.view.id : [...S.runningQueues][0]);
        default: return null;
      }
    } catch (e) { toast(e.message, true); }
  }
  window.APP.cmd = cmd;
  $$('#toolbar .tb').forEach(b => { b.onclick = () => cmd(b.dataset.cmd); });
  $$('#toolbar i[data-ic]').forEach(i => { i.outerHTML = icon(i.dataset.ic, i.dataset.c, 30); });
  $('#search').addEventListener('input', (e) => { S.filter = e.target.value.trim(); renderGrid(); });

  /* ================= menubar ================= */
  const MENUS = {
    tasks: () => [
      { label: t('addNew'), key: 'Ctrl+N', action: () => DLG.addUrl() },
      { label: t('addBatch'), key: 'Ctrl+B', action: () => DLG.batch() },
      { label: t('addBatchClip'), action: async () => DLG.batch(await api.call('readClipboard')) },
      '-',
      { label: t('importList'), action: async () => { const urls = await api.call('importList'); if (urls.length) DLG.batch(urls.join('\n')); } },
      { label: t('exportList'), action: () => api.call('exportList', []) },
      '-',
      { label: t('exit'), key: 'Ctrl+Q', action: () => api.call('quit') },
    ],
    file: () => {
      const items = sel(); const one = items.length === 1 ? items[0] : null;
      return [
        { label: t('downloadNow'), disabled: !items.length, action: () => cmd('resume') },
        { label: t('stop'), disabled: !items.length, action: () => cmd('stop') },
        { label: t('redownload'), disabled: !one, action: () => api.call('redownload', one._id) },
        { label: t('remove'), key: 'Del', disabled: !items.length, action: () => cmd('delete') },
        '-',
        { label: t('open'), disabled: !one || one.status !== 'complete', action: () => api.call('open', one._id) },
        { label: t('openFolder'), disabled: !one, action: () => api.call('openFolder', one._id) },
        { label: t('properties'), disabled: !one, action: () => DLG.properties(one) },
      ];
    },
    downloads: () => [
      { label: t('stopAll'), action: () => cmd('stopAll') },
      { label: t('deleteCompleted'), action: () => cmd('deleteCompleted') },
      '-',
      { label: t('scheduler'), action: () => cmd('scheduler') },
      { label: t('startQueue'), sub: S.queues.map(q => ({ label: t(q.name), disabled: S.runningQueues.has(q._id), action: () => api.call('startQueue', q._id) })) },
      { label: t('stopQueue'), sub: S.queues.map(q => ({ label: t(q.name), disabled: !S.runningQueues.has(q._id), action: () => api.call('stopQueue', q._id) })) },
      '-',
      { label: t('speedLimiter'), sub: [
        { label: t('turnOn'), radio: S.settings.speedLimit > 0, action: () => DLG.speedLimit() },
        { label: t('turnOff'), radio: !S.settings.speedLimit, action: () => api.call('saveSettings', { speedLimit: 0 }) },
      ] },
      { label: t('options'), action: () => DLG.options() },
    ],
    view: () => [
      { label: t('theme'), sub: [
        { label: t('light'), radio: S.settings.theme !== 'dark', action: () => api.call('saveSettings', { theme: 'light' }) },
        { label: t('dark'), radio: S.settings.theme === 'dark', action: () => api.call('saveSettings', { theme: 'dark' }) },
      ] },
      { label: t('language'), sub: [
        { label: 'العربية', radio: S.settings.lang === 'ar', action: () => api.call('saveSettings', { lang: 'ar' }) },
        { label: 'English', radio: S.settings.lang === 'en', action: () => api.call('saveSettings', { lang: 'en' }) },
      ] },
      { label: t('showCategories'), check: S.showSidebar, action: () => { S.showSidebar = !S.showSidebar; $('#sidebar').classList.toggle('hidden', !S.showSidebar); } },
    ],
    help: () => [
      { label: t('bs_title'), action: () => DLG.browserSetup() },
      { label: t('cliHelp'), action: () => DLG.info(t('cliHelp'), t('cliText')) },
      '-',
      { label: t('about'), action: () => DLG.about() },
    ],
  };
  $$('.menu-top').forEach(el => {
    const open = () => {
      closeMenus();
      el.classList.add('open');
      const r = el.getBoundingClientRect();
      const m = showMenu(MENUS[el.dataset.menu](), document.documentElement.dir === 'rtl' ? r.right : r.left, r.bottom + 2);
      if (document.documentElement.dir === 'rtl') m.style.left = Math.max(4, r.right - m.offsetWidth) + 'px';
    };
    el.addEventListener('mousedown', (e) => { e.stopPropagation(); el.classList.contains('open') ? closeMenus() : open(); });
    el.addEventListener('mouseenter', () => { if ($('.menu-top.open') && !el.classList.contains('open')) open(); });
  });

  /* ================= keyboard, paste, drag & drop ================= */
  document.addEventListener('keydown', (e) => {
    if ($('.overlay')) return;
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'n') { e.preventDefault(); DLG.addUrl(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'b') { e.preventDefault(); DLG.batch(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'q') { e.preventDefault(); api.call('quit'); }
    else if (inField) return;
    else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); setSel([...rowEls.keys()]); }
    else if (e.key === 'Delete') cmd('delete');
    else if (e.key === 'Enter') { const s = sel(); if (s.length === 1) s[0].status === 'complete' ? api.call('open', s[0]._id) : api.call('openProgress', s[0]._id); }
  });
  document.addEventListener('paste', (e) => {
    if ($('.overlay') || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    const txt = e.clipboardData.getData('text');
    const urls = (txt.match(/https?:\/\/[^\s"'<>]+/g) || []);
    if (urls.length === 1) DLG.addUrl(urls[0]); else if (urls.length > 1) DLG.batch(urls.join('\n'));
  });
  const gw = $('#gridwrap');
  let dz = null;
  gw.addEventListener('dragover', (e) => { e.preventDefault(); if (!dz) { dz = h('div', { id: 'dropzone' }, t('dropHere')); gw.append(dz); } });
  gw.addEventListener('dragleave', (e) => { if (!gw.contains(e.relatedTarget)) { dz?.remove(); dz = null; } });
  gw.addEventListener('drop', (e) => {
    e.preventDefault(); dz?.remove(); dz = null;
    const txt = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    const urls = txt.split(/\s+/).filter(u => /^https?:\/\//i.test(u));
    if (urls.length === 1) DLG.addUrl(urls[0]); else if (urls.length > 1) DLG.batch(urls.join('\n'));
  });

  /* ================= events from main process ================= */
  api.on('evt:update', (rec) => {
    const old = S.downloads.get(rec._id);
    S.downloads.set(rec._id, rec);
    if (!old || old.status !== rec.status || old.queueId !== rec.queueId || old.category !== rec.category) { renderGrid(); }
    else updateRow(rec._id);
    renderStatus(); updateToolbar();
  });
  api.on('evt:progress', (batch) => {
    Object.assign(S.progress, batch);
    for (const id of Object.keys(batch)) updateRow(id);
    renderStatus();
  });
  api.on('evt:removed', (ids) => { ids.forEach(id => { S.downloads.delete(id); S.sel.delete(id); }); renderGrid(); renderStatus(); updateToolbar(); });
  api.on('evt:reload', (st) => applyState(st));
  api.on('evt:settings', (s) => {
    const langChanged = s.lang !== S.settings.lang;
    S.settings = s; UI.applyTheme(s.theme);
    if (langChanged) { I18N.set(s.lang); refreshAll(); } else renderStatus();
  });
  api.on('evt:queues', (q) => { S.runningQueues = new Set(q); renderTree(); renderStatus(); updateToolbar(); });
  api.on('evt:external', (data) => DLG.fileInfo(data));
  api.on('evt:batch', (items) => DLG.batch(items.map(i => i.url).join('\n'), items));
  api.on('evt:command', (c) => { if (c === 'add-url') DLG.addUrl(); });
  api.on('evt:sound', () => UI.chime());
  api.on('evt:toast', (m) => toast(m));

  load().then(() => {
    // أول تشغيل على هذا الجهاز: معالج ربط المتصفح
    if (!S.settings.extWizardShown) { api.call('saveSettings', { extWizardShown: true }); setTimeout(() => DLG.browserSetup(true), 600); }
  }).catch(e => toast(e.message, true));
})();
