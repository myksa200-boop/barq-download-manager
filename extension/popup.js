/* Chrome / Edge / Brave / Opera / Vivaldi: chrome.*  —  Firefox: browser.* */
const B = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
(async () => {
  const [tab] = await B.tabs.query({ active: true, currentWindow: true });
  const s = await B.runtime.sendMessage({ type: 'status' });
  $('st').textContent = s.alive ? 'متصل' : 'البرنامج لا يعمل';
  $('st').classList.toggle('ok', s.alive);
  $('ver').textContent = 'v' + s.extVersion;
  $('hint').textContent = s.alive ? '' : 'شغّل برنامج برق (Barq Download Manager) من قائمة ابدأ ثم أعد فتح هذه النافذة.';
  $('intercept').checked = s.cfg.intercept; $('panel').checked = s.cfg.panel; $('port').value = s.port || s.cfg.port;
  if (s.alive && s.port && s.port !== s.cfg.port) $('auto').textContent = '(اكتُشف تلقائياً)';
  const warn = (html, err) => { $('warn').innerHTML = html; $('warn').classList.remove('hidden'); $('warn').classList.toggle('err', !!err); };
  if (s.oldApp) warn(`النسخة القديمة <b>Nazzil</b> تعمل على المنفذ ${s.oldApp.port}. أغلقها (زر يمين على أيقونتها بجانب الساعة ← خروج) وأزل تثبيتها.`, !s.alive);
  else if (s.alive && s.appVersion && s.appVersion.split('.').slice(0, 2).join('.') !== s.extVersion.split('.').slice(0, 2).join('.')) {
    warn(`إصدار الإضافة (${s.extVersion}) لا يطابق البرنامج (${s.appVersion}). يبدو أنها محمّلة من مجلد قديم. في البرنامج: مساعدة ← ربط المتصفح، ثم حمّلها من المجلد الذي يفتحه (تتحدث بعدها تلقائياً).`);
  }
  $('intercept').onchange = (e) => B.storage.local.set({ intercept: e.target.checked });
  $('panel').onchange = (e) => B.storage.local.set({ panel: e.target.checked });
  $('port').onchange = (e) => { const n = Number(String(e.target.value).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))); B.storage.local.set({ port: n >= 1024 && n <= 65535 ? n : 46321 }); };
  $('page').onclick = async () => {
    const r = await B.runtime.sendMessage({ type: 'download', url: tab.url, kind: 'ytdlp', referer: tab.url });
    if (r && r.ok) window.close(); else $('hint').textContent = r?.error || '';
  };
  $('all').onclick = async () => {
    const links = await B.tabs.sendMessage(tab.id, { type: 'collectLinks' }).catch(() => []);
    if (links && links.length) { const r = await B.runtime.sendMessage({ type: 'batch', urls: links, referer: tab.url }); if (r.ok) window.close(); }
  };
  // Firefox MV3: صلاحية الوصول للمواقع يمنحها المستخدم يدوياً
  if (B.permissions && !(await B.permissions.contains({ origins: ['<all_urls>'] }))) {
    const btn = document.createElement('button');
    btn.textContent = 'منح صلاحية الوصول للمواقع (مطلوب في Firefox)';
    btn.style.background = '#b45309';
    btn.onclick = () => B.permissions.request({ origins: ['<all_urls>'] }).then(() => window.close());
    document.body.insertBefore(btn, $('media'));
  }
  const m = await B.runtime.sendMessage({ type: 'getMedia', tabId: tab.id });
  for (const it of (m.items || []).slice(0, 8)) {
    const d = document.createElement('div'); d.className = 'm';
    const a = document.createElement('span'); a.textContent = it.url.split('?')[0].split('/').pop() || it.url;
    const b = document.createElement('b'); b.textContent = it.label;
    d.append(a, b);
    d.onclick = async () => { await B.runtime.sendMessage({ type: 'download', url: it.url, kind: it.kind, referer: tab.url }); window.close(); };
    $('media').append(d);
  }
})();
