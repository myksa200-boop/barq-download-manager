/* نافذة مستقلة لمعلومات التنزيل: تُفتح عند التنزيل من المتصفح دون إظهار النافذة الرئيسية */
(function () {
  const api = window.api;
  const key = new URLSearchParams(location.search).get('k');
  const S = { downloads: new Map(), categories: [], queues: [], settings: {}, root: '' };
  window.APP = { S, refreshAll() {}, renderGrid() {}, renderTree() {}, selected: () => [] };

  // النافذة على قدر المحتوى تماماً
  let last = 0;
  function fit() {
    const m = document.querySelector('body > .overlay > .modal');
    if (!m) return;
    const hgt = Math.ceil(m.getBoundingClientRect().height);
    if (Math.abs(hgt - last) > 1) { last = hgt; api.resizeWindow(hgt); }
  }
  const ro = new ResizeObserver(fit);

  async function init() {
    const [st, data] = await Promise.all([api.call('state'), api.call('addData', key)]);
    S.categories = st.categories; S.queues = st.queues; S.settings = st.settings; S.root = st.root; S.logins = st.logins;
    UI.applyTheme(S.settings.theme); I18N.set(S.settings.lang);
    document.title = t('fileInfo') + ' — Barq';
    if (!data) return api.closeWindow();
    const m = await DLG.fileInfo(data);
    const ov = m.el;
    ov.classList.add('root');
    ro.observe(ov.querySelector('.modal'));
    // إغلاق الحوار الرئيسي = إغلاق النافذة
    new MutationObserver(() => { if (!ov.isConnected) api.closeWindow(); }).observe(document.body, { childList: true });
    setTimeout(fit, 30);
  }
  api.on('evt:settings', (s) => { S.settings = s; UI.applyTheme(s.theme); });
  api.on('evt:queues', (q) => { S.queues = q; });
  api.on('evt:reload', (st) => { S.categories = st.categories; S.queues = st.queues; });
  api.on('evt:toast', (m) => UI.toast(m));
  init().catch((e) => UI.toast(e.message, true));
})();
