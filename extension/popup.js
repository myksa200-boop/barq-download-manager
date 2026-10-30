/* Chrome / Edge / Brave / Opera / Vivaldi: chrome.*  —  Firefox: browser.* */
const B = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const fmt = (b) => { if (!(b > 0)) return ''; const u = ['KB', 'MB', 'GB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < 2); return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i]; };
const TYPE = { hls: 'بث', dash: 'بث', http: 'فيديو', audio: 'صوت' };
(async () => {
  const [tab] = await B.tabs.query({ active: true, currentWindow: true });
  const s = await B.runtime.sendMessage({ type: 'status' });
  $('stt').textContent = s.alive ? 'متصل' : 'البرنامج مغلق';
  $('st').classList.toggle('ok', s.alive);
  $('ver').textContent = s.extVersion;
  if (!s.alive) $('hint').textContent = 'شغّل برنامج برق من قائمة ابدأ ثم أعد فتح هذه النافذة.';
  $('intercept').checked = s.cfg.intercept; $('panel').checked = s.cfg.panel; $('port').value = s.port || s.cfg.port;
  if (s.alive && s.port && s.port !== s.cfg.port) $('auto').textContent = 'تلقائي';
  const warn = (html, err) => { $('warn').innerHTML = html; $('warn').classList.remove('hidden'); $('warn').classList.toggle('err', !!err); };
  if (s.oldApp) warn(`النسخة القديمة <b>Nazzil</b> تعمل على المنفذ ${s.oldApp.port}. أغلقها (زر يمين على أيقونتها بجانب الساعة ← خروج) وأزل تثبيتها.`, !s.alive);
  else if (s.alive && s.appVersion && s.appVersion.split('.').slice(0, 2).join('.') !== s.extVersion.split('.').slice(0, 2).join('.')) {
    warn(`إصدار الإضافة (${s.extVersion}) لا يطابق البرنامج (${s.appVersion}). من البرنامج: مساعدة ← ربط المتصفح، وحمّلها من المجلد الذي يفتحه.`);
  }
  $('intercept').onchange = (e) => B.storage.local.set({ intercept: e.target.checked });
  $('panel').onchange = (e) => B.storage.local.set({ panel: e.target.checked });
  $('port').onchange = (e) => { const n = Number(String(e.target.value).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))); B.storage.local.set({ port: n >= 1024 && n <= 65535 ? n : 46321 }); };

  // الفيديو الظاهر في الصفحة: في مواقع التواصل نأخذ رابط منشوره لا رابط الصفحة الرئيسية
  const pv = await B.tabs.sendMessage(tab.id, { type: 'pageVideo' }).catch(() => null);
  const target = pv?.url || tab.url;
  if (pv?.social) $('pageLbl').textContent = pv.post ? `تنزيل فيديو المنشور الظاهر (${pv.name})` : 'افتح المنشور أو مرّر إلى الفيديو';
  if (pv?.social && !pv.post) $('page').disabled = true;
  if (pv?.notVideo) { $('pageLbl').textContent = 'افتح فيديو أو مرّر المؤشر على مصغّرته'; $('page').disabled = true; }
  const send = async (msg) => {
    const r = await B.runtime.sendMessage(msg);
    if (r && r.ok) window.close(); else $('hint').textContent = r?.error || 'تعذّر الاتصال بالبرنامج';
  };
  $('page').onclick = () => send({ type: 'download', url: target, kind: 'ytdlp', referer: tab.url });
  $('all').onclick = async (e) => {
    e.preventDefault();
    const links = await B.tabs.sendMessage(tab.id, { type: 'collectLinks' }).catch(() => []);
    if (links && links.length) send({ type: 'batch', urls: links, referer: tab.url });
    else $('hint').textContent = 'لا توجد روابط في هذه الصفحة';
  };
  // Firefox MV3: صلاحية الوصول للمواقع يمنحها المستخدم يدوياً
  if (B.permissions && !(await B.permissions.contains({ origins: ['<all_urls>'] }))) {
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.style.cssText = 'margin-top:8px;background:#b45309';
    btn.textContent = 'منح صلاحية الوصول للمواقع (مطلوب في Firefox)';
    btn.onclick = () => B.permissions.request({ origins: ['<all_urls>'] }).then(() => window.close());
    $('page').after(btn);
  }
  // الملفات الملتقطة: لا نعرضها في مواقع التواصل (تخص كل المنشورات)، وبأسماء مفهومة في غيرها
  if (pv?.social) return;
  const m = await B.runtime.sendMessage({ type: 'getMedia', tabId: tab.id });
  const title = (tab.title || 'فيديو').replace(/\s*[-|–]\s*[^-|–]+$/, '').trim() || 'فيديو';
  const items = (m.items || []).filter(it => it.kind !== 'ytdlp').slice(0, 5);
  items.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'm'; d.title = it.url;
    const isAudio = /^audio/i.test(it.mime || '') || /^audio/i.test(it.label || '');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = items.length > 1 ? `${title} (${i + 1})` : title;
    const t = document.createElement('span'); t.className = 't'; t.textContent = isAudio ? TYPE.audio : (TYPE[it.kind] || 'ملف');
    const z = document.createElement('span'); z.className = 's'; z.textContent = fmt(it.size);
    d.append(n, t, z);
    d.onclick = () => send({ type: 'download', url: it.url, kind: it.kind, referer: tab.url });
    $('media').append(d);
  });
  $('mediaBox').classList.toggle('hidden', !items.length);
})();
