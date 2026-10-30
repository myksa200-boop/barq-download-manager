/* أدوات مشتركة: أيقونات، تنسيق، نوافذ حوار، قوائم، إشعارات */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- icons (original SVG set) ---------- */
  const P = {
    add: '<circle cx="16" cy="16" r="13" fill="C"/><path d="M16 9v14M9 16h14" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>',
    resume: '<circle cx="16" cy="16" r="13" fill="C"/><path d="M13 10.5l9 5.5-9 5.5z" fill="#fff"/>',
    stop: '<circle cx="16" cy="16" r="13" fill="C"/><rect x="11" y="11" width="10" height="10" rx="1.5" fill="#fff"/>',
    stopall: '<rect x="3" y="7" width="20" height="20" rx="5" fill="C" opacity=".45"/><rect x="9" y="3" width="20" height="20" rx="5" fill="C"/><rect x="14" y="8" width="10" height="10" rx="1.5" fill="#fff"/>',
    del: '<path d="M9 11h14l-1.4 16.2a2 2 0 0 1-2 1.8h-7.2a2 2 0 0 1-2-1.8z" fill="C"/><rect x="6" y="6.5" width="20" height="3.2" rx="1.6" fill="C"/><rect x="13" y="3" width="6" height="3" rx="1" fill="C"/>',
    delc: '<path d="M9 11h14l-1.4 16.2a2 2 0 0 1-2 1.8h-7.2a2 2 0 0 1-2-1.8z" fill="C"/><rect x="6" y="6.5" width="20" height="3.2" rx="1.6" fill="C"/><path d="M12 19l3 3 5.5-6" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
    opt: '<g fill="none" stroke="C" stroke-width="3.4" stroke-linecap="round"><circle cx="16" cy="16" r="5.5"/><path d="M16 3.5v4M16 24.5v4M3.5 16h4M24.5 16h4M7.2 7.2l2.8 2.8M22 22l2.8 2.8M7.2 24.8l2.8-2.8M22 10l2.8-2.8"/></g>',
    sched: '<rect x="4" y="6" width="24" height="22" rx="4" fill="#fff" stroke="C" stroke-width="2.4"/><path d="M4 10a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v2H4z" fill="C"/><circle cx="16" cy="20" r="5" fill="none" stroke="C" stroke-width="2"/><path d="M16 17.2V20h2.6" stroke="C" stroke-width="2" fill="none" stroke-linecap="round"/>',
    startq: '<rect x="3" y="5" width="17" height="4" rx="2" fill="C"/><rect x="3" y="13" width="17" height="4" rx="2" fill="C"/><rect x="3" y="21" width="10" height="4" rx="2" fill="C"/><path d="M18 17l11 6.5L18 30z" fill="#16a34a"/>',
    stopq: '<rect x="3" y="5" width="17" height="4" rx="2" fill="C"/><rect x="3" y="13" width="17" height="4" rx="2" fill="C"/><rect x="3" y="21" width="10" height="4" rx="2" fill="C"/><rect x="18" y="18" width="11" height="11" rx="2" fill="#dc2626"/>',
    folder: '<path d="M2 6.5A1.5 1.5 0 0 1 3.5 5h6l2 2.2h13A1.5 1.5 0 0 1 26 8.7V24a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 2 24z" fill="C"/>',
    queue: '<rect x="3" y="6" width="22" height="4" rx="2" fill="C"/><rect x="3" y="13" width="22" height="4" rx="2" fill="C" opacity=".75"/><rect x="3" y="20" width="14" height="4" rx="2" fill="C" opacity=".5"/>',
    logo: '<rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="#1d3a9e"/><path d="M18 4 L9.4 17.9 H14.9 L12.9 26.2 L22.2 12.2 H16.7 Z" fill="#facc15"/><path d="M7 22 v3.2 a1.8 1.8 0 0 0 1.8 1.8 h14.4 a1.8 1.8 0 0 0 1.8 -1.8 V22" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/>',
    check: '<circle cx="16" cy="16" r="14" fill="C"/><path d="M9.5 16.5l4.5 4.5 8.5-9" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    warn: '<path d="M16 3l14 25H2z" fill="C"/><path d="M16 12v7" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="23.5" r="1.8" fill="#fff"/>',
    empty: '<path d="M4 20l5-12h14l5 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="none" stroke="C" stroke-width="2"/><path d="M4 20h7l2 3h6l2-3h7" fill="none" stroke="C" stroke-width="2"/>',
  };
  function icon(name, color = 'currentColor', size = 32) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">${(P[name] || '').replace(/="C"/g, `="${color}"`)}</svg>`;
  }

  const CAT_COLORS = { Compressed: '#ca8a04', Documents: '#dc2626', Music: '#16a34a', Programs: '#0891b2', Video: '#db2777', General: '#64748b' };
  const EXT_COLORS = { iso: '#7c3aed', img: '#7c3aed', pptx: '#ea580c', ppt: '#ea580c', xlsx: '#16a34a', xls: '#16a34a', docx: '#2563eb', doc: '#2563eb', pdf: '#dc2626' };
  function fileColor(name, cat) {
    const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
    return EXT_COLORS[(ext || '').toLowerCase()] || CAT_COLORS[cat] || '#64748b';
  }

  /* ---------- formatting ---------- */
  function fmtSize(b) {
    if (b == null || b < 0) return '';
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
    return (b >= 100 ? b.toFixed(1) : b.toFixed(2)) + ' ' + u[i];
  }
  const fmtSpeed = (bps) => (bps > 0 ? fmtSize(bps) + '/s' : '');
  function fmtTime(sec) {
    if (sec == null || sec < 0 || !isFinite(sec)) return '';
    sec = Math.round(sec);
    const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return `${d} ${t('day')} ${hr} ${t('hr')}`;
    if (hr) return `${hr} ${t('hr')} ${m} ${t('min')}`;
    if (m) return `${m} ${t('min')} ${s} ${t('sec')}`;
    return `${s} ${t('sec')}`;
  }
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleString(I18N.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  const pct = (a, b) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
  /** قيم إنجليزية/رقمية داخل واجهة عربية: عزلها كي لا تنقلب (48.00 MB) */
  const ltr = (s) => (s ? `<bdi dir="ltr">${esc(s)}</bdi>` : '');

  /* ---------- toasts & sound ---------- */
  function toast(msg, err = false) {
    let box = $('#toasts');
    if (!box) { box = h('div', { id: 'toasts', class: 'toasts' }); document.body.append(box); }
    const el = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    box.append(el);
    setTimeout(() => el.remove(), err ? 6000 : Math.max(3200, String(msg).length * 70));
  }
  function chime() {
    try {
      const ctx = new AudioContext();
      [[880, 0], [1320, 0.12]].forEach(([f, at]) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35);
        o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.4);
      });
    } catch { /* ignore */ }
  }

  /* ---------- modal dialogs ---------- */
  function modal({ title, body, buttons = [], width = 560, onClose, iconName }) {
    const overlay = h('div', { class: 'overlay' });
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(v); };
    const head = h('div', { class: 'modal-h', html: (iconName ? icon(iconName, 'var(--accent)', 18) : '') + `<span>${esc(title)}</span>` });
    head.append(h('span', { class: 'x', text: '✕', onclick: () => close(null) }));
    const b = h('div', { class: 'modal-b' });
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.append(body);
    const foot = h('div', { class: 'modal-f' });
    const api = { close, el: overlay, body: b, foot };
    for (const btn of buttons) {
      if (btn === 'sp') { foot.append(h('span', { class: 'sp' })); continue; }
      if (btn.nodeType) { foot.append(btn); continue; }
      const el = h('button', { class: 'btn ' + (btn.cls || ''), onclick: async () => { const r = await (btn.onClick ? btn.onClick(api) : true); if (r !== false) close(btn.value ?? true); } }, btn.label);
      if (btn.id) el.id = btn.id;
      foot.append(el);
    }
    const m = h('div', { class: 'modal', style: { width: width + 'px' } }, head, b, buttons.length ? foot : null);
    overlay.append(m);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { const p = foot.querySelector('.btn.primary'); if (p && !p.disabled && overlay.isConnected && overlay === $$('.overlay').pop()) { e.preventDefault(); p.click(); } }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    setTimeout(() => { const f = b.querySelector('[autofocus]') || b.querySelector('input:not([type=checkbox]),select,textarea'); f && f.focus(); f && f.select && f.type !== 'number' && f.select?.(); }, 30);
    return api;
  }
  function confirmBox(text, extra) {
    return new Promise(res => {
      const body = h('div', {}, h('p', { style: { marginTop: 0 } }, text), extra || '');
      modal({ title: t('app'), body, width: 420, iconName: 'warn', buttons: ['sp', { label: t('ok'), cls: 'primary', value: 'ok' }, { label: t('cancel'), value: null }], onClose: v => res(v === 'ok') });
    });
  }
  function tabs(defs) {
    const bar = h('div', { class: 'tabs' });
    const wrap = h('div');
    defs.forEach((d, i) => {
      const tab = h('div', { class: 'tab' + (i ? '' : ' on') }, d.label);
      const pane = h('div', { class: 'tabpane' + (i ? '' : ' on') });
      pane.append(d.content);
      tab.onclick = () => { $$('.tab', bar).forEach(x => x.classList.remove('on')); $$(':scope > .tabpane', wrap).forEach(x => x.classList.remove('on')); tab.classList.add('on'); pane.classList.add('on'); d.onShow && d.onShow(); };
      bar.append(tab); wrap.append(pane);
    });
    return h('div', {}, bar, wrap);
  }

  /* ---------- menus ---------- */
  let openMenu = null;
  function closeMenus() { $$('.dropdown, .ctxmenu').forEach(m => m.remove()); $$('.menu-top.open').forEach(m => m.classList.remove('open')); openMenu = null; }
  function showMenu(items, x, y, cls = 'dropdown', parent) {
    const m = h('div', { class: cls });
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { m.append(h('div', { class: 'msep' })); continue; }
      const el = h('div', { class: 'mi' + (it.disabled ? ' dis' : '') + (it.sub ? ' sub' : '') });
      el.innerHTML = `<span class="ic">${it.check ? '✓' : it.radio ? '●' : (it.icon || '')}</span><span>${esc(it.label)}</span>` + (it.key ? `<span class="k">${esc(it.key)}</span>` : '');
      if (it.sub) {
        el.addEventListener('mouseenter', () => {
          $$('.submenu', m.parentElement || document).forEach(s => { if (s.dataset.owner !== String(items.indexOf(it)) || s._parent !== m) s.remove(); });
          const r = el.getBoundingClientRect();
          const rtl = document.documentElement.dir === 'rtl';
          const sm = showMenu(it.sub, rtl ? r.left : r.right, r.top - 5, 'dropdown submenu', m);
          sm.dataset.owner = String(items.indexOf(it)); sm._parent = m;
          if (rtl) sm.style.left = Math.max(4, r.left - sm.offsetWidth) + 'px';
        });
      } else {
        el.addEventListener('mouseenter', () => { $$('.submenu').forEach(s => { if (s._parent === m) s.remove(); }); });
        el.addEventListener('click', (e) => { e.stopPropagation(); if (it.disabled) return; closeMenus(); it.action && it.action(); });
      }
      m.append(el);
    }
    document.body.append(m);
    const vw = innerWidth, vh = innerHeight;
    const w = m.offsetWidth, hh = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(x, vw - w - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, vh - hh - 4)) + 'px';
    return m;
  }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.dropdown, .ctxmenu, .menu-top')) closeMenus(); });
  window.addEventListener('blur', closeMenus);

  function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'; }

  window.UI = { $, $$, h, esc, ltr, icon, fileColor, fmtSize, fmtSpeed, fmtTime, fmtDate, pct, toast, chime, modal, confirmBox, tabs, showMenu, closeMenus, applyTheme, CAT_COLORS };
})();
