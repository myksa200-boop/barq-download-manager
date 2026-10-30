/* Barq — لوحة "تنزيل هذا الفيديو" العائمة فوق مشغلات الفيديو */
(() => {
  const B = globalThis.browser ?? globalThis.chrome;
  if (window.__barq) return; window.__barq = true;
  let items = []; let enabled = true; let current = null; let hideTimer = null;

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483646;display:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{all:initial}
    *{box-sizing:border-box;font-family:'Segoe UI',Tahoma,Arial,sans-serif}
    .btn{display:flex;align-items:center;gap:7px;background:linear-gradient(#3b82f6,#1d4ed8);color:#fff;border:0;border-radius:7px;padding:6px 11px 6px 8px;font-size:12.5px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4);white-space:nowrap}
    .btn:hover{filter:brightness(1.08)}
    .lg{width:18px;height:18px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center}
    .x{opacity:.75;padding:0 2px;margin-inline-start:4px} .x:hover{opacity:1}
    .menu{position:absolute;top:36px;right:0;background:#fff;color:#0f172a;border-radius:8px;min-width:300px;max-width:420px;box-shadow:0 10px 30px rgba(0,0,0,.45);overflow:hidden;font-size:12.5px;display:none}
    .menu.on{display:block}
    .it{display:flex;justify-content:space-between;gap:16px;padding:8px 13px;border-bottom:1px solid #eef2f6;cursor:pointer}
    .it:hover{background:#dbeafe}
    .it .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}
    .it .s{color:#64748b;flex:none}
    .tag{display:inline-block;background:#e0e7ff;color:#3730a3;border-radius:4px;padding:0 5px;margin-right:6px;font-size:11px}
    .empty{padding:10px 13px;color:#64748b}
    .toast{position:fixed;bottom:20px;right:20px;background:#0f172a;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.4)}
  </style>
  <div class="wrap" style="position:relative">
    <button class="btn" id="b"><span class="lg"><svg width="13" height="13" viewBox="0 0 32 32"><path d="M18 3 L8.6 18 H14.6 L12.4 27 L22.6 12 H16.6 Z" fill="#f59e0b"/></svg></span>
      <span id="lbl">Download this video</span><span>▾</span><span class="x" id="x" title="Hide">✕</span></button>
    <div class="menu" id="m"></div>
  </div>`;
  const $ = (id) => root.getElementById(id);
  const ar = /^ar/i.test(navigator.language);
  $('lbl').textContent = ar ? 'تنزيل هذا الفيديو' : 'Download this video';
  document.documentElement.appendChild(host);

  const fmt = (b) => { if (!(b > 0)) return ''; const u = ['KB', 'MB', 'GB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < 2); return b.toFixed(1) + ' ' + u[i]; };
  const title = () => (document.title || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120);

  /* فحص الصفحة: روابط وسائط مخفية في الوسوم ووسوم og:video وبيانات JSON-LD */
  const MEDIA_RE = /\.(mp4|webm|mkv|mov|m4v|flv|avi|mp3|m4a|ogg|opus|wav|flac|m3u8|mpd)(\?|#|$)/i;
  function scanPage() {
    const found = new Map();
    const add = (u) => { try { u = new URL(u, location.href).href; } catch { return; } if (/^https?:/i.test(u) && MEDIA_RE.test(u)) found.set(u, { url: u }); };
    document.querySelectorAll('video[src], audio[src], source[src], video source, audio source').forEach(e => add(e.getAttribute('src')));
    document.querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"], meta[name="twitter:player:stream"], meta[itemprop="contentUrl"]').forEach(e => add(e.content));
    document.querySelectorAll('a[href]').forEach(a => { if (MEDIA_RE.test(a.getAttribute('href') || '')) add(a.href); });
    document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
      try { JSON.stringify(JSON.parse(sc.textContent)).replace(/"(?:contentUrl|embedUrl|url)":"([^"]+)"/g, (_, u) => { add(u.replace(/\\\//g, '/')); return ''; }); } catch { /* ignore */ }
    });
    const list = [...found.values()];
    if (list.length) B.runtime.sendMessage({ type: 'pageMedia', items: list }).catch(() => {});
    return list;
  }
  const UNSUPPORTED = /(^|\.)(netflix\.com|disneyplus\.com|primevideo\.com|shahid\.mbc\.net|osn\.com)$/i.test(location.hostname);
  const YT = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(location.hostname);
  /** رابط الفيديو الحالي في YouTube (يتغير بدون إعادة تحميل الصفحة) */
  function ytUrl() {
    const u = new URL(location.href);
    const shorts = /^\/shorts\/([\w-]{6,})/.exec(u.pathname);
    if (shorts) return `https://www.youtube.com/shorts/${shorts[1]}`;
    const emb = /^\/embed\/([\w-]{6,})/.exec(u.pathname);
    if (emb) return `https://www.youtube.com/watch?v=${emb[1]}`;
    if (u.searchParams.get('v')) return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
    if (u.searchParams.get('list')) return `https://www.youtube.com/playlist?list=${u.searchParams.get('list')}`;
    return location.href;
  }
  /* مواقع التواصل: الصفحة (مثل x.com/home) تحوي عشرات المنشورات، فنأخذ رابط المنشور الذي يحتوي الفيديو نفسه */
  const SOCIAL = [
    { re: /(^|\.)(x\.com|twitter\.com)$/i, name: 'X', self: /^\/[\w]+\/status\/\d+/, link: /^\/[\w]+\/status\/\d+\/?$/ },
    { re: /(^|\.)instagram\.com$/i, name: 'Instagram', self: /^\/(p|reels?|tv)\/[\w-]+/, link: /^\/([\w.]+\/)?(p|reels?|tv)\/[\w-]+\/?$/ },
    { re: /(^|\.)(facebook\.com|fb\.watch)$/i, name: 'Facebook', self: /^\/(watch|reel|[\w.]+\/videos)\b|\/videos\/\d+/, link: /\/(videos|reel)\/[\w.-]+|\/watch\/?\?v=\d+|\/posts\/[\w]+|story_fbid=/ },
    { re: /(^|\.)tiktok\.com$/i, name: 'TikTok', self: /^\/@[\w.-]+\/video\/\d+/, link: /^\/@[\w.-]+\/video\/\d+/ },
    { re: /(^|\.)reddit\.com$/i, name: 'Reddit', self: /\/comments\/\w+/, link: /\/comments\/\w+/ },
    { re: /(^|\.)(threads\.net|threads\.com)$/i, name: 'Threads', self: /^\/@[\w.]+\/post\/[\w-]+/, link: /^\/@[\w.]+\/post\/[\w-]+\/?$/ },
    { re: /(^|\.)snapchat\.com$/i, name: 'Snapchat', self: /^\/(spotlight|@)/, link: /^\/spotlight\/[\w-]+/ },
    { re: /(^|\.)linkedin\.com$/i, name: 'LinkedIn', self: /^\/(posts|feed\/update)\//, link: /^\/(posts\/[\w-]+|feed\/update\/[\w:%-]+)/ },
    { re: /(^|\.)pinterest\.[a-z.]+$/i, name: 'Pinterest', self: /^\/pin\/\d+/, link: /^\/pin\/\d+/ },
  ];
  const social = SOCIAL.find(x => x.re.test(location.hostname));
  /** رابط المنشور الذي يحتوي عنصر الفيديو (أو الصفحة نفسها إن كانت صفحة منشور) */
  function postUrl(v) {
    if (!social) return null;
    const ok = (a) => { try { const u = new URL(a.href, location.href); return social.re.test(u.hostname) && social.link.test(u.pathname + u.search); } catch { return false; } };
    if (v) {
      // X: رابط وقت التغريدة داخل نفس article هو رابطها الدائم
      const art = v.closest('article, shreddit-post, [role="article"], [data-e2e="recommend-list-item-container"]');
      if (art) {
        if (art.getAttribute('permalink')) return new URL(art.getAttribute('permalink'), location.href).href;
        const timed = [...art.querySelectorAll('a[href] time')].map(t => t.closest('a')).find(a => a && ok(a));
        if (timed) return clean(timed.href);
      }
      // صعوداً من الفيديو حتى نجد أقرب رابط منشور
      let el = v;
      for (let i = 0; el && i < 25; i++, el = el.parentElement) {
        const a = el.matches?.('a[href]') && ok(el) ? el : [...el.querySelectorAll('a[href]')].find(ok);
        if (a) return clean(a.href);
      }
    }
    return social.self.test(location.pathname) ? clean(location.href) : null;
  }
  function clean(u) { try { const x = new URL(u, location.href); if (!/story_fbid|[?&]v=/.test(x.search)) x.search = ''; x.hash = ''; return x.href.replace(/(\/status\/\d+)\/(photo|video)\/\d+\/?$/, '$1'); } catch { return u; } }
  const pageTitle = () => (document.title || 'video').replace(/^\(\d+\)\s*/, '').replace(/\s*[-|]\s*YouTube\s*$/i, '').trim();

  function candidates() {
    if (YT) {
      const u = ytUrl();
      const out = [{ url: u, kind: 'ytdlp', label: 'YouTube', size: -1, title: pageTitle() }];
      const lst = new URL(location.href).searchParams.get('list');
      if (lst && /[?&]v=/.test(location.search)) out.push({ url: `https://www.youtube.com/playlist?list=${lst}`, kind: 'ytdlp', label: ar ? 'القائمة كاملة' : 'Playlist', size: -1, title: ar ? 'قائمة التشغيل كاملة' : 'Whole playlist' });
      return out;
    }
    const list = [...items];
    if (current) {
      const src = current.currentSrc || current.src || '';
      if (/^https?:/i.test(src) && !list.some(x => x.url === src)) list.unshift({ url: src, kind: /\.m3u8/i.test(src) ? 'hls' : /\.mpd/i.test(src) ? 'dash' : 'http', label: current.tagName === 'AUDIO' ? 'Audio' : 'Video', size: -1 });
    }
    // الترتيب: الفيديو الذي تشير إليه أولاً، ثم قوائم البث (HLS/DASH)، ثم الفيديو، ثم الصوت
    const src = current ? (current.currentSrc || current.src || '') : '';
    const rank = (x) => (x.url === src ? 0 : x.kind === 'hls' || x.kind === 'dash' ? 1 : /^audio/i.test(x.label || '') ? 3 : 2);
    const sorted = list.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(p => p[0]);
    // دائماً: خيار استخراج الفيديو من الصفحة نفسها عبر yt-dlp (يدعم أكثر من 1000 موقع)
    const post = postUrl(current);
    if (post) {
      // مواقع التواصل: خيار واحد فقط = فيديو هذا المنشور (yt-dlp يجلب الفيديو مع الصوت وبأعلى جودة).
      // ملفات m3u8 الملتقطة تعود لكل المنشورات في الصفحة فلا نعرضها حتى لا تختلط.
      return [{ url: post, kind: 'ytdlp', label: social.name, size: -1, title: ar ? 'تنزيل فيديو هذا المنشور' : 'Download this post\'s video' }];
    }
    if (social) {
      // منشور بلا رابط ظاهر: لا نخلط ملفات المنشورات الأخرى، نكتفي بمصدر الفيديو نفسه إن وُجد
      const own = sorted.filter(x => x.url === src);
      if (own.length) return own;
    }
    if (!UNSUPPORTED) sorted.push({ url: location.href, kind: 'ytdlp', label: ar ? 'الصفحة' : 'Page', size: -1, title: ar ? 'استخراج الفيديو من هذه الصفحة' : 'Extract video from this page', page: true });
    return sorted;
  }
  function renderMenu() {
    const m = $('m'); m.replaceChildren();
    const list = candidates();
    if (!list.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = UNSUPPORTED
        ? (ar ? 'هذا الموقع يستخدم بثاً محمياً أو مشفراً (DRM) لا يمكن تنزيله' : 'This site uses protected/encrypted streaming (DRM) that cannot be downloaded')
        : (ar ? 'لم يتم رصد ملف قابل للتنزيل بعد — شغّل الفيديو ثم حاول مجدداً' : 'No downloadable stream detected yet — play the video and try again');
      m.append(e); return;
    }
    for (const it of list) {
      const row = document.createElement('div'); row.className = 'it';
      const name = it.title || decodeURIComponent((it.url.split('?')[0].split('/').pop() || 'video')).slice(0, 60);
      row.innerHTML = `<span class="n"><span class="tag"></span></span><span class="s"></span>`;
      row.querySelector('.tag').textContent = it.label || it.kind;
      row.querySelector('.n').append(document.createTextNode(name));
      row.querySelector('.s').textContent = (it.kind === 'hls' || it.kind === 'dash' || it.kind === 'ytdlp') ? (ar ? 'اختيار الجودة' : 'choose quality') : fmt(it.size);
      row.onclick = async (e) => {
        e.stopPropagation(); m.classList.remove('on');
        const ext = (/\.(\w{2,4})(\?|$)/.exec(it.url.split('?')[0]) || [, 'mp4'])[1];
        const fileName = it.kind === 'ytdlp' ? '' : it.kind === 'hls' ? title() + '.ts' : it.kind === 'dash' ? title() + '.mp4' : (/\.\w{2,4}$/.test(name) && !/^(index|master|playlist|video|manifest)\./i.test(name) ? name : title() + '.' + ext);
        const r = await B.runtime.sendMessage({ type: 'download', url: it.url, kind: it.kind, referer: location.href, fileName });
        if (!r || !r.ok) toast(r?.error || 'Barq?');
      };
      m.append(row);
    }
  }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; root.append(t); setTimeout(() => t.remove(), 4000);
  }
  function place(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) return hide();
    host.style.display = 'block';
    host.style.top = (window.scrollY + r.top + 10) + 'px';
    host.style.left = (window.scrollX + r.right - 10 - host.offsetWidth) + 'px';
  }
  function hide() { host.style.display = 'none'; $('m').classList.remove('on'); }
  function show(v) {
    if (!enabled) return;
    current = v; clearTimeout(hideTimer); place(v);
  }
  $('b').addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.composedPath().includes($('x'))) { enabled = false; hide(); return; }
    scanPage(); renderMenu(); $('m').classList.toggle('on');
  });
  host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  host.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 2500); });
  document.addEventListener('click', () => $('m').classList.remove('on'));

  function hook(v) {
    if (v.__nz) return; v.__nz = true;
    v.addEventListener('mouseenter', () => show(v));
    v.addEventListener('play', () => show(v));
    v.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 2500); });
  }
  const scan = () => document.querySelectorAll('video, audio[controls]').forEach(hook);
  scan();
  new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true });
  // المشغلات تغطي عنصر الفيديو بطبقات؛ نتتبع حركة الفأرة فوق مساحته
  document.addEventListener('mousemove', (e) => {
    if (!enabled) return;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { if (current !== v || host.style.display === 'none') show(v); return; }
    }
  }, { passive: true });
  window.addEventListener('scroll', () => { if (current && host.style.display !== 'none') place(current); }, { passive: true });

  setTimeout(scanPage, 1500);
  B.runtime.sendMessage({ type: 'getMedia' }).then((r) => { if (r) { items = r.items || []; enabled = r.panel !== false; } }).catch(() => {});
  B.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'media') { items = msg.items || []; if ($('m').classList.contains('on')) renderMenu(); }
    if (msg.type === 'toast') toast(msg.msg);
    if (msg.type === 'pageVideo') {
      // للنافذة المنبثقة: الفيديو الأوضح على الشاشة ← رابط منشوره (أو رابط يوتيوب أو الصفحة)
      if (YT) { reply({ url: ytUrl(), social: false }); return; }
      let best = null, area = 0;
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        if (a > area) { area = a; best = v; }
      }
      const post = postUrl(best || current);
      reply({ url: post || location.href, social: !!social, name: social ? social.name : '', post: !!post });
      return;
    }
    if (msg.type === 'collectLinks') {
      const sel = window.getSelection();
      let anchors = [...document.querySelectorAll('a[href]')];
      if (msg.selection && sel && sel.rangeCount) anchors = anchors.filter(a => sel.containsNode(a, true));
      const urls = [...new Set(anchors.map(a => a.href).filter(u => /^https?:/i.test(u)))];
      reply(urls.slice(0, 2000));
    }
  });
})();
