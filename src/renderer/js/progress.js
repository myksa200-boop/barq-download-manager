/* نافذة تقدم التنزيل — مع مؤشر التقطيع الديناميكي وجدول الاتصالات ونافذة الاكتمال */
(function () {
  const { $, $$, h, esc, ltr, icon, fmtSize, fmtSpeed, fmtTime, pct, toast } = UI;
  const api = window.api;
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  let rec = null; let prog = null; let settings = {}; let details = true; let view = '';

  const root = $('#root');
  const ACTIVE = ['connecting', 'downloading', 'merging'];

  async function init() {
    const r = await api.call('get', id);
    rec = r.rec; prog = r.progress; settings = r.settings;
    if (!rec) return api.closeWindow();
    UI.applyTheme(settings.theme); I18N.set(settings.lang);
    render();
  }

  function render() {
    const v = rec.status === 'complete' ? 'complete' : 'progress';
    if (v !== view) { view = v; v === 'complete' ? buildComplete() : buildProgress(); }
    if (view === 'progress') update();
  }

  /* ---------------- progress view ---------------- */
  function buildProgress() {
    root.innerHTML = '';
    const tabBar = h('div', { class: 'tabs', style: { marginBottom: 0, borderBottom: 'none' } });
    const panes = {};
    const tabDefs = [['status', t('p_status')], ['limiter', t('p_limiter')], ['done', t('p_onComplete')]];
    tabDefs.forEach(([k, l], i) => {
      const tab = h('div', { class: 'tab' + (i ? '' : ' on') }, l);
      tab.onclick = () => { $$('.tab', tabBar).forEach(x => x.classList.remove('on')); tab.classList.add('on'); Object.values(panes).forEach(p => p.classList.add('hidden')); panes[k].classList.remove('hidden'); fit(); };
      tabBar.append(tab);
    });
    // status pane
    panes.status = h('div', { class: 'pw-panel' },
      h('div', { id: 'url', class: 'mono muted', style: { fontSize: '11.5px', marginBottom: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'ltr', textAlign: 'start' } }),
      h('div', { class: 'pw-kv' },
        h('span', {}, t('c_status')), h('b', { id: 'st' }),
        h('span', {}, t('p_fileSize')), h('b', { id: 'sz' }),
        h('span', {}, t('p_downloaded')), h('b', { id: 'dl' }),
        h('span', {}, t('p_rate')), h('b', { id: 'rt' }),
        h('span', {}, t('p_left')), h('b', { id: 'lf' }),
        h('span', {}, t('p_resume')), h('b', { id: 'rs' })),
      h('div', { class: 'pbar', id: 'pbar' }, h('div')),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', margin: '10px 0 4px' } },
        h('button', { class: 'btn', id: 'btnDetails', onclick: toggleDetails }, t('hideDetails')),
        h('button', { class: 'btn primary', id: 'btnPause', onclick: pauseResume }, t('pause')),
        h('button', { class: 'btn', onclick: cancel }, t('cancel'))),
      h('div', { id: 'details' },
        h('div', { style: { margin: '8px 0 5px', fontSize: '12px' } }, t('p_conns')),
        h('canvas', { id: 'segcanvas' }),
        h('div', { class: 'conn-table' }, h('table', { class: 'mini' }, h('thead', {}, h('tr', {}, h('th', { style: { width: '48px' } }, t('p_n')), h('th', { style: { width: '120px' } }, t('p_downloaded')), h('th', {}, t('p_info')))), h('tbody', { id: 'conns' })))));
    // limiter pane
    const limChk = h('input', { type: 'checkbox' }); limChk.checked = rec.speedLimit > 0;
    const limIn = h('input', { class: 'field', type: 'number', min: 1, value: rec.speedLimit || 512, style: { width: '120px' } });
    const applyLim = () => api.call('props', id, { speedLimit: limChk.checked ? Math.max(1, Number(limIn.value) || 1) : 0 });
    limChk.onchange = applyLim; limIn.onchange = () => { if (limChk.checked) applyLim(); };
    panes.limiter = h('div', { class: 'pw-panel hidden' }, h('div', { class: 'row' }, h('label', { class: 'chk' }, limChk, t('limitThis')), limIn, h('span', { class: 'muted' }, 'KB/s')));
    // on-complete pane
    const showC = h('input', { type: 'checkbox' }); showC.checked = rec.showComplete !== false;
    showC.onchange = () => api.call('props', id, { showComplete: showC.checked });
    const after = h('select', { class: 'field' }, ...[['none', t('a_none')], ['exit', t('a_exit')], ['shutdown', t('a_shutdown')]].map(([v, l]) => h('option', { value: v, selected: rec.afterComplete === v }, l)));
    after.onchange = () => api.call('props', id, { afterComplete: after.value });
    panes.done = h('div', { class: 'pw-panel hidden' }, h('div', { class: 'form' }, h('span'), h('label', { class: 'chk' }, showC, t('showOnComplete')), h('label', {}, t('afterThis')), after));

    root.append(tabBar, panes.status, panes.limiter, panes.done);
    $('#url').textContent = rec.url;
    $('#url').title = rec.url;
    setTimeout(fit, 30);
  }

  function update() {
    const p = prog || {};
    const active = ACTIVE.includes(rec.status);
    const size = rec.size > 0 ? rec.size : (p.size > 0 ? p.size : -1);
    const dl = active && p.downloaded != null ? p.downloaded : rec.downloaded;
    const percent = pct(dl, size);
    document.title = (size > 0 ? Math.floor(percent) + '% ' : '') + rec.fileName;
    const stText = {
      connecting: t('i_connecting'), downloading: t('i_receiving'), merging: t('s_merging'), paused: t('s_paused'), stopped: t('s_paused'),
      queued: t('s_queued'), error: t('failed') + ' — ' + rec.error, complete: t('s_complete'),
    }[rec.status] || rec.status;
    const st = $('#st'); st.textContent = stText;
    st.style.color = rec.status === 'error' ? 'var(--err)' : active ? 'var(--accent)' : 'var(--warn)';
    st.title = stText;
    $('#sz').innerHTML = size > 0 ? ltr(fmtSize(size)) : esc(t('unknown'));
    $('#dl').innerHTML = p.hls ? `${ltr(fmtSize(dl))}  (${ltr(p.hlsDone + '/' + p.hlsTotal)} ${esc(t('segments'))})` : `${ltr(fmtSize(dl))}${size > 0 ? '  ' + ltr('( ' + percent.toFixed(2) + ' % )') : ''}`;
    $('#rt').innerHTML = active ? (ltr(fmtSpeed(p.speed)) || '—') : '';
    $('#lf').textContent = active ? fmtTime(p.eta) : '';
    const rs = $('#rs'); rs.textContent = t(rec.resumable ? 'yes' : 'no'); rs.style.color = rec.resumable ? 'var(--ok)' : 'var(--warn)';
    const bar = $('#pbar');
    bar.classList.toggle('indet', active && !(size > 0));
    bar.firstChild.style.width = (p.hls && p.hlsTotal ? (p.hlsDone / p.hlsTotal) * 100 : percent) + '%';
    const bp = $('#btnPause');
    bp.textContent = active || rec.status === 'queued' ? t('pause') : (rec.status === 'error' ? t('retry') : t('resume'));
    drawSegments(p, size);
    const tb = $('#conns'); const prevRows = tb.childElementCount; tb.innerHTML = '';
    for (const c of (p.conns || [])) {
      const info = c.info.startsWith('retry') ? t('i_retry', c.info.split(':')[1])
        : c.info.startsWith('preparing:') ? t('i_preparing', c.info.split(':')[1], c.info.split(':')[2])
        : c.info === 'preparing' ? t('i_preparing', '', '…').replace(' …%', '')
        : (p.ytdlp && c.info === 'receiving' && p.phase) ? `${t('i_receiving')} (${t('phase_' + p.phase)})`
        : t('i_' + c.info) || c.info;
      tb.append(h('tr', {}, h('td', {}, c.n), h('td', { html: ltr(fmtSize(c.bytes)) }), h('td', { style: { color: c.info === 'done' ? 'var(--ok)' : c.info === 'error' ? 'var(--err)' : '' } }, info)));
    }
    if (tb.childElementCount !== prevRows) fit();   // الجدول تغيّر طوله ⇒ النافذة على قدر المحتوى
  }

  function drawSegments(p, size) {
    const cv = $('#segcanvas'); if (!cv || !details) return;
    const dpr = devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--seg-bg').trim(); ctx.fillRect(0, 0, W, H);
    const blue = css.getPropertyValue('--seg').trim();
    const rtl = document.documentElement.dir === 'rtl';
    const X = (v) => (rtl ? W - v : v);
    const rect = (x0, x1, color) => { ctx.fillStyle = color; const a = X(x0), b = X(x1); ctx.fillRect(Math.min(a, b), 0, Math.abs(b - a), H); };
    if (rec.status === 'complete') { rect(0, W, blue); return; }
    if (p.hls && p.hlsMap && p.hlsMap.length) {
      const n = p.hlsMap.length; const w = W / n;
      p.hlsMap.forEach((d, i) => { if (d) rect(i * w, (i + 1) * w, blue); });
      return;
    }
    const segs = (p.segments && p.segments.length ? p.segments : rec.segments) || [];
    if (!(size > 0) || !segs.length) {
      if (size > 0) rect(0, (W * (p.downloaded || rec.downloaded)) / size, blue);
      return;
    }
    const grad = ctx.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#60a5fa'); grad.addColorStop(1, blue);
    for (const s of segs) {
      const x0 = (s.start / size) * W; const xd = (Math.min(s.pos, s.end + 1) / size) * W;
      rect(x0, xd, grad);
      ctx.fillStyle = '#0f172a'; ctx.fillRect(X(x0) - (rtl ? 1.5 : 0), 0, 1.5, H);
    }
  }

  function toggleDetails() {
    details = !details;
    $('#details').classList.toggle('hidden', !details);
    $('#btnDetails').textContent = details ? t('hideDetails') : t('showDetails');
    fit();
    if (details) update();
  }
  // ارتفاع النافذة = ارتفاع المحتوى الفعلي فقط (يصغر عند إخفاء التفاصيل)
  function fit() { requestAnimationFrame(() => requestAnimationFrame(() => api.resizeWindow(Math.ceil(root.getBoundingClientRect().height)))); }

  async function pauseResume() {
    try {
      if (ACTIVE.includes(rec.status) || rec.status === 'queued') await api.call('pause', [id]);
      else await api.call('start', [id]);
    } catch (e) { toast(e.message, true); }
  }
  async function cancel() {
    if (ACTIVE.includes(rec.status)) await api.call('pause', [id]);
    api.closeWindow();
  }

  /* ---------------- complete view ---------------- */
  function buildComplete() {
    document.title = t('completeTitle');
    root.innerHTML = '';
    const sep = rec.saveDir.includes('\\') ? '\\' : '/';
    const full = rec.saveDir.replace(/[\\/]+$/, '') + sep + rec.fileName;
    const dont = h('input', { type: 'checkbox' });
    dont.onchange = () => api.call('saveSettings', { showCompleteDialog: !dont.checked });
    root.append(
      h('div', { class: 'pw-panel', style: { borderRadius: '8px' } },
        h('div', { class: 'done-hero' }, h('div', { class: 'ok', html: icon('check', 'var(--ok)', 30) }),
          h('div', { style: { minWidth: 0 } }, h('div', { style: { fontSize: '16px', fontWeight: 700 } }, t('completeTitle')),
            h('div', { dir: 'auto', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, rec.fileName))),
        h('div', { class: 'pw-kv', style: { marginTop: '14px' } },
          h('span', {}, t('address')), h('b', { class: 'mono', style: { fontWeight: 400, direction: 'ltr', textAlign: 'start' }, title: rec.url }, rec.url),
          h('span', {}, t('size')), h('b', { html: ltr(fmtSize(rec.size)) }),
          h('span', {}, t('downloadedTo')), h('b', { class: 'mono', style: { fontWeight: 400 }, title: full }, full))),
      h('div', { class: 'row' }, h('label', { class: 'chk' }, dont, t('dontShowAgain')), h('span', { class: 'grow' }),
        h('button', { class: 'btn primary', onclick: async () => { try { await api.call('open', id); api.closeWindow(); } catch (e) { toast(e.message, true); } } }, t('openWith')),
        h('button', { class: 'btn', onclick: () => { api.call('openFolder', id); api.closeWindow(); } }, t('openFolder')),
        h('button', { class: 'btn', onclick: () => api.closeWindow() }, t('close'))));
    fit();
  }

  /* ---------------- events ---------------- */
  api.on('evt:update', (r) => { if (r._id !== id) return; rec = r; render(); });
  api.on('evt:progress', (p) => { if (p.id !== id) return; prog = p; if (view === 'progress') update(); });
  api.on('evt:complete', (r) => { rec = r; if (r.showComplete === false || !settings.showCompleteDialog) { api.closeWindow(); return; } render(); });
  api.on('evt:settings', (s) => { settings = s; UI.applyTheme(s.theme); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.closeWindow(); });
  window.addEventListener('resize', () => { if (view === 'progress') drawSegments(prog || {}, rec.size); });
  init().catch(e => toast(e.message, true));
})();
