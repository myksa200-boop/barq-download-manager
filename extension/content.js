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
      <span id="lbl">Download this video</span><span id="arr">▾</span><span class="x" id="x" title="Hide">✕</span></button>
    <div class="menu" id="m"></div>
  </div>`;
  const $ = (id) => root.getElementById(id);
  const ar = /^ar/i.test(navigator.language);
  $('lbl').textContent = ar ? 'تنزيل هذا الفيديو' : 'Download this video';
  document.documentElement.appendChild(host);

  // التوست في عنصر مستقل ظاهر دائماً (لا يختفي مع إخفاء الزر)
  const toastHost = document.createElement('div');
  toastHost.style.cssText = 'position:fixed;bottom:0;right:0;width:0;height:0;z-index:2147483647';
  const toastRoot = toastHost.attachShadow({ mode: 'closed' });
  toastRoot.innerHTML = '<style>.toast{position:fixed;bottom:20px;right:20px;max-width:420px;background:#0f172a;color:#fff;padding:10px 14px;border-radius:8px;font:13px "Segoe UI",Tahoma,Arial,sans-serif;line-height:1.6;box-shadow:0 6px 20px rgba(0,0,0,.4)}</style>';
  document.documentElement.appendChild(toastHost);

  /* ---------- أمان: بعد تحديث الإضافة تلقائياً يصبح هذا السكربت قديماً؛ نزيله بهدوء بدل زر لا يعمل ---------- */
  const ac = new AbortController();
  const L = { signal: ac.signal };
  const LP = { signal: ac.signal, passive: true };
  let mo = null;
  const alive = () => { try { return !!(B.runtime && B.runtime.id); } catch { return false; } };
  function teardown() {
    try { ac.abort(); mo && mo.disconnect(); host.remove(); toastHost.remove(); } catch { /* ignore */ }
    window.__barq = false;
  }
  async function send(msg) {
    if (!alive()) { teardown(); return null; }
    try { return await B.runtime.sendMessage(msg); } catch (e) {
      if (/context invalidated|Extension context/i.test(String(e && e.message))) teardown();
      return null;
    }
  }
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const fileOf = (u) => safeDecode((String(u).split('?')[0].split('#')[0].split('/').pop() || ''));

  /* ---------- قائمة عناصر الفيديو (مع Shadow DOM مثل ريديت) — تُحدَّث عند تغيّر الصفحة فقط ---------- */
  let videos = [];
  const SHADOW_HOSTS = 'shreddit-player, shreddit-player-2, [data-shadow-player]';
  function collectVideos() {
    const out = [...document.querySelectorAll('video')];
    if (document.querySelector(SHADOW_HOSTS)) {
      const walk = (root, depth) => {
        if (depth > 5) return;
        for (const h of root.querySelectorAll(depth ? '*' : SHADOW_HOSTS)) if (h.shadowRoot) { out.push(...h.shadowRoot.querySelectorAll('video')); walk(h.shadowRoot, depth + 1); }
      };
      walk(document, 0);
    }
    videos = out;
    for (const v of out) hook(v);
  }
  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return; scanQueued = true;
    const run = () => { scanQueued = false; if (alive()) collectVideos(); else teardown(); };
    (window.requestIdleCallback ? requestIdleCallback(run, { timeout: 600 }) : setTimeout(run, 250));
  }
  const up = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const closestDeep = (el, sel) => { for (let e = el, i = 0; e && i < 60; e = up(e), i++) if (e.matches && e.matches(sel)) return e; return null; };
  const countVideos = (el) => el.querySelectorAll('video').length + el.querySelectorAll('shreddit-player, shreddit-player-2').length;
  const fmt = (b) => { if (!(b > 0)) return ''; const u = ['KB', 'MB', 'GB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < 2); return b.toFixed(1) + ' ' + u[i]; };
  const title = () => (document.title || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120);
  const srcOf = (v) => (v && v.tagName === 'VIDEO' ? (v.currentSrc || v.src || '') : '');

  /* ---------- فحص الصفحة: روابط وسائط في الوسوم وog:video وJSON-LD ---------- */
  const MEDIA_RE = /\.(mp4|webm|mkv|mov|m4v|flv|avi|mp3|m4a|ogg|opus|wav|flac|m3u8|mpd)(\?|#|$)/i;
  function scanPage() {
    const found = new Map();
    const add = (u) => { try { u = new URL(u, location.href).href; } catch { return; } if (/^https?:/i.test(u) && MEDIA_RE.test(u)) found.set(u, { url: u }); };
    document.querySelectorAll('video[src], source[src], video source').forEach(e => add(e.getAttribute('src')));
    document.querySelectorAll('meta[property^="og:video"], meta[name="twitter:player:stream"], meta[itemprop="contentUrl"]').forEach(e => add(e.content));
    document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
      try { JSON.stringify(JSON.parse(sc.textContent)).replace(/"(?:contentUrl|embedUrl)":"([^"]+)"/g, (_, u) => { add(u.replace(/\\\//g, '/')); return ''; }); } catch { /* ignore */ }
    });
    const list = [...found.values()];
    if (list.length) send({ type: 'pageMedia', items: list });
    return list;
  }

  const UNSUPPORTED = /(^|\.)(netflix\.com|disneyplus\.com|primevideo\.com|shahid\.mbc\.net|osn\.com)$/i.test(location.hostname);
  const YT = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(location.hostname);
  const YT_VIDEO_PAGE = /^\/(watch|shorts\/|embed\/|live\/)/;
  /** رابط الفيديو في عنوان صفحة يوتيوب (فقط لصفحات الفيديو؛ وإلا null) */
  function ytUrl() {
    const u = new URL(location.href);
    const shorts = /^\/shorts\/([\w-]{6,})/.exec(u.pathname);
    if (shorts) return `https://www.youtube.com/shorts/${shorts[1]}`;
    const emb = /^\/(?:embed|live)\/([\w-]{6,})/.exec(u.pathname);
    if (emb) return `https://www.youtube.com/watch?v=${emb[1]}`;
    if (u.searchParams.get('v')) return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
    if (u.pathname === '/playlist' && u.searchParams.get('list')) return `https://www.youtube.com/playlist?list=${u.searchParams.get('list')}`;
    return null;
  }
  /** أي مشغّل يوتيوب (مقطع القناة، المشغّل المصغّر، المعاينة…) يحوي رابط عنوانه .ytp-title-link */
  function ytPlayerUrl(v) {
    const pl = closestDeep(v, '.html5-video-player, #movie_player, ytd-player');
    const a = pl && pl.querySelector('a.ytp-title-link[href*="v="], a.ytp-title-fullerscreen-link[href*="v="]');
    if (a) { const id = new URL(a.href, location.href).searchParams.get('v'); if (id) return `https://www.youtube.com/watch?v=${id}`; }
    // مقطع القناة/المشغّل المصغّر: أقرب حاوية فيها رابط لفيديو واحد فقط (معرّف واحد مميّز) — وإلا لا نخمّن
    if (pl && !(YT_VIDEO_PAGE.test(location.pathname) && closestDeep(v, '#movie_player'))) {
      for (let el = up(pl), i = 0; el && el !== document.body && i < 6; el = up(el), i++) {
        const ids = new Set([...el.querySelectorAll('a[href*="watch?v="]')].map(x => { try { return new URL(x.href, location.href).searchParams.get('v'); } catch { return null; } }).filter(Boolean));
        if (ids.size === 1) return `https://www.youtube.com/watch?v=${[...ids][0]}`;
        if (ids.size > 1) break;
      }
    }
    // المشغّل الرئيسي في صفحة المشاهدة/شورتس
    if (YT_VIDEO_PAGE.test(location.pathname) && closestDeep(v, '#movie_player, #shorts-player, ytd-reel-video-renderer') && !closestDeep(v, 'ytd-video-preview, #video-preview, ytd-rich-item-renderer, ytd-compact-video-renderer')) return ytUrl();
    return null;
  }

  /* مواقع التواصل: الصفحة (مثل x.com/home) تحوي عشرات المنشورات، فنأخذ رابط المنشور الذي يحتوي الفيديو نفسه */
  const SOCIAL = [
    { re: /(^|\.)(x\.com|twitter\.com|mobile\.twitter\.com)$/i, name: 'X', self: /^\/(\w+|i\/web|i)\/status\/\d+/, link: /^\/(\w+|i\/web|i)\/status\/\d+\/?$/ },
    { re: /(^|\.)instagram\.com$/i, name: 'Instagram', self: /^\/([\w.]+\/)?(p|reels?|tv)\/[\w-]+/, link: /^\/([\w.]+\/)?(p|reels?|tv)\/[\w-]+\/?$/ },
    { re: /(^|\.)(facebook\.com|fb\.watch)$/i, name: 'Facebook', self: /^\/(watch\/?\?v=|reel\/|share\/[vr]\/)|\/videos\/[\w.-]*\d/, link: /\/videos\/([\w.-]+\/)?\d+|\/reel\/\d+|\/watch\/?\?v=\d+|\/share\/[vr]\/\w+|\/posts\/\w+|story_fbid=|\/permalink\.php/ },
    { re: /(^|\.)tiktok\.com$/i, name: 'TikTok', self: /^\/@[\w.-]*\/(video|photo)\/\d+/, link: /^\/@[\w.-]+\/video\/\d+/ },
    { re: /(^|\.)reddit\.com$/i, name: 'Reddit', self: /\/comments\/\w+/, link: /\/comments\/\w+/ },
    { re: /(^|\.)(threads\.net|threads\.com)$/i, name: 'Threads', self: /^\/@[\w.]+\/post\/[\w-]+/, link: /^\/@[\w.]+\/post\/[\w-]+\/?$/ },
    { re: /(^|\.)snapchat\.com$/i, name: 'Snapchat', self: /^\/spotlight\/[\w-]+/, link: /^\/spotlight\/[\w-]+/ },
    { re: /(^|\.)linkedin\.com$/i, name: 'LinkedIn', self: /^\/(posts|feed\/update)\//, link: /^\/(posts\/[\w-]+|feed\/update\/[\w:%-]+)/ },
    { re: /(^|\.)pinterest\.[a-z.]+$/i, name: 'Pinterest', self: /^\/pin\/\d+/, link: /^\/pin\/\d+/ },
  ];
  const social = SOCIAL.find(x => x.re.test(location.hostname));
  const BOX = 'article, shreddit-post, [role="article"], [data-e2e="recommend-list-item-container"], [data-testid="tweet"], [data-pagelet^="FeedUnit"]';
  /** رابط المنشور الذي يحتوي عنصر الفيديو.
   *  1) إن وُجد حاوي المنشور (article…) نبحث داخله فقط — ولا نخرج منه أبداً.
   *  2) بدونه نصعد من الفيديو ونتوقف عند أي عنصر يحوي فيديو آخر أو أكثر من منشور. */
  function postUrl(v) {
    if (!social || !v) return null;
    const ok = (a) => {
      try {
        const u = new URL(a.href, location.href);
        return social.re.test(u.hostname) && (social.link.test(u.pathname) || social.link.test(u.pathname + u.search));
      } catch { return false; }
    };
    const findIn = (el) => {
      const pl = el.getAttribute && el.getAttribute('permalink');          // ريديت
      if (pl) return clean(new URL(pl, location.href).href);
      if (social.name === 'TikTok') {                                       // رقم الفيديو في معرّف المشغّل
        const cands = [el, ...el.querySelectorAll('[id*="xgwrapper"], [data-video-id], [id]')].slice(0, 400);
        for (const n of cands) {
          const m = /(\d{18,20})/.exec((n.id || '') + ' ' + ((n.getAttribute && n.getAttribute('data-video-id')) || ''));
          if (m) {
            const au = /\/@([\w.-]+)/.exec([...el.querySelectorAll('a[href*="/@"]')].map(x => x.getAttribute('href')).find(Boolean) || '');
            return `https://www.tiktok.com/@${au ? au[1] : ''}/video/${m[1]}`;
          }
        }
      }
      const timed = [...el.querySelectorAll('a[href] time')].map(t => t.closest('a')).find(a => a && ok(a));   // X: رابط الوقت
      if (timed) return clean(timed.href);
      const a = (el.matches && el.matches('a[href]') && ok(el)) ? el : [...el.querySelectorAll('a[href]')].find(ok);
      return a ? clean(a.href) : null;
    };
    const box = closestDeep(v, BOX);
    if (box) {
      const r = findIn(box);
      if (r) return r;
    } else {
      for (let el = up(v), i = 0; el && el !== document.body && el !== document.documentElement && i < 40; el = up(el), i++) {
        if (countVideos(el) > 1 || el.querySelectorAll(BOX).length > 1) break;
        const r = findIn(el);
        if (r) return r;
      }
    }
    return social.self.test(location.pathname + location.search) ? clean(location.href) : null;
  }
  function clean(u) {
    try {
      const x = new URL(u, location.href);
      const keep = new URLSearchParams();
      for (const k of ['v', 'story_fbid', 'id']) if (x.searchParams.get(k)) keep.set(k, x.searchParams.get(k));
      x.search = keep.toString(); x.hash = '';
      return x.href.replace(/(\/status\/\d+)\/(photo|video)\/\d+\/?$/, '$1');
    } catch { return u; }
  }
  const pageTitle = () => (document.title || 'video').replace(/^\(\d+\)\s*/, '').replace(/\s*[-|]\s*YouTube\s*$/i, '').trim();
  const ytItem = (url, t) => ({ url, kind: 'ytdlp', label: 'YouTube', size: -1, title: t || pageTitle() });

  /** المرشحون للتنزيل للعنصر الحالي (فيديو أو مصغّرة يوتيوب) */
  function candidates() {
    if (YT) {
      if (current && current.tagName !== 'VIDEO') return ytHover ? [ytItem(ytHover.url, ytHover.title)] : [];
      const u = ytPlayerUrl(current) || (current ? null : ytUrl());
      if (!u) return [];
      const out = [ytItem(u)];
      const lst = new URL(location.href).searchParams.get('list');
      if (lst && /^\/watch/.test(location.pathname) && u === ytUrl()) out.push({ url: `https://www.youtube.com/playlist?list=${lst}`, kind: 'ytdlp', label: ar ? 'القائمة كاملة' : 'Playlist', size: -1, title: ar ? 'قائمة التشغيل كاملة' : 'Whole playlist' });
      return out;
    }
    const src = srcOf(current);
    const post = postUrl(current);
    if (post) {
      // مواقع التواصل: خيار واحد = فيديو هذا المنشور (الملفات الملتقطة تخص كل المنشورات فلا نعرضها)
      return [{ url: post, kind: 'ytdlp', label: social.name, size: -1, title: ar ? 'تنزيل فيديو هذا المنشور' : 'Download this post\'s video' }];
    }
    const list = [...items];
    if (/^https?:/i.test(src) && !list.some(x => x.url === src)) list.unshift({ url: src, kind: /\.m3u8/i.test(src) ? 'hls' : /\.mpd/i.test(src) ? 'dash' : 'http', label: 'Video', size: -1 });
    if (social) {
      const own = list.filter(x => x.url === src);
      if (own.length) return own;
      return [];      // صفحة متابعة بلا رابط منشور: لا نرسل الصفحة ولا ملفات منشورات أخرى
    }
    // الترتيب: الفيديو الذي تشير إليه، ثم البث (HLS/DASH)، ثم الملفات، ثم الصوت
    const rank = (x) => (x.url === src ? 0 : x.kind === 'hls' || x.kind === 'dash' ? 1 : /^audio/i.test(x.label || x.mime || '') ? 3 : 2);
    const sorted = list.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(p => p[0]);
    if (!UNSUPPORTED) sorted.push({ url: location.href, kind: 'ytdlp', label: ar ? 'الصفحة' : 'Page', size: -1, title: ar ? 'استخراج الفيديو من هذه الصفحة' : 'Extract video from this page', page: true });
    return sorted;
  }
  /** الخيار الوحيد المؤكد إن وُجد؛ وإلا null فتظهر قائمة للاختيار */
  function directPick() {
    const list = candidates();
    if (list.length <= 1) return list[0] || null;
    const src = srcOf(current);
    const own = list.find(x => x.url === src && !x.page);
    if (own) return own;
    const files = list.filter(x => !x.page);
    if (!files.length) return list.find(x => x.page) || null;
    // ملف وحيد: نختاره مباشرة إلا إن كان ملف mp4 عادياً والفيديو الحالي blob (قد يكون إعلاناً) ← نعرض القائمة
    if (files.length === 1 && (files[0].kind !== 'http' || !/^blob:/i.test(src))) return files[0];
    return null;
  }
  function typeLabel(it) {
    if (it.page) return ar ? 'الصفحة' : 'Page';
    if (it.kind === 'ytdlp') return it.label || 'Video';
    if (/^audio/i.test(it.label || '') || /^audio/i.test(it.mime || '')) return ar ? 'صوت' : 'Audio';
    if (it.kind === 'hls' || it.kind === 'dash') return ar ? 'بث' : 'Stream';
    return ar ? 'فيديو' : 'Video';
  }
  function emptyMsg() {
    if (UNSUPPORTED) return ar ? 'هذا الموقع يستخدم بثاً محمياً (DRM) لا يمكن تنزيله' : 'This site uses protected (DRM) streaming that cannot be downloaded';
    if (YT) return ar ? 'افتح الفيديو أو مرّر المؤشر على مصغّرته' : 'Open the video or hover its thumbnail';
    if (social) return ar ? 'تعذّر معرفة رابط هذا الفيديو — افتح المنشور نفسه (اضغط عليه) ثم حاول' : 'Could not find this video\'s link — open the post itself, then try again';
    return ar ? 'لم يتم رصد ملف قابل للتنزيل بعد — شغّل الفيديو ثم حاول مجدداً' : 'No downloadable stream detected yet — play the video and try again';
  }
  function renderMenu() {
    const m = $('m'); m.replaceChildren();
    const list = candidates();
    if (!list.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = emptyMsg(); m.append(e); return; }
    list.forEach((it, i) => {
      const row = document.createElement('div'); row.className = 'it';
      const raw = fileOf(it.url);
      // أسماء ملفات البث عشوائية (مثل 9VYGwq….m3u8): نعرض عنوان الصفحة بدلها
      const name = it.title || (it.kind === 'http' && /\.\w{2,4}$/.test(raw) && raw.length < 60 ? raw : title() + (list.length > 1 ? ` (${i + 1})` : ''));
      row.innerHTML = '<span class="n"><span class="tag"></span></span><span class="s"></span>';
      row.querySelector('.tag').textContent = typeLabel(it);
      row.querySelector('.n').append(document.createTextNode(name));
      row.querySelector('.s').textContent = fmt(it.size);
      row.onclick = (e) => { e.stopPropagation(); m.classList.remove('on'); download(it); };
      m.append(row);
    });
  }
  async function download(it) {
    const raw = fileOf(it.url);
    const ext = (/\.(\w{2,4})$/.exec(raw) || [, 'mp4'])[1];
    const fileName = it.kind === 'ytdlp' ? '' : it.kind === 'hls' ? title() + '.ts' : it.kind === 'dash' ? title() + '.mp4' : (/\.\w{2,4}$/.test(raw) && !/^(index|master|playlist|video|manifest)\./i.test(raw) ? raw : title() + '.' + ext);
    const lbl = $('lbl'); const old = lbl.textContent;
    lbl.textContent = ar ? 'جارٍ الفتح…' : 'Opening…';
    let r = null;
    try { r = await send({ type: 'download', url: it.url, kind: it.kind, referer: location.href, fileName }); } finally { lbl.textContent = old; }
    if (!alive()) return;
    if (!r || !r.ok) toast(r?.error || (ar ? 'برنامج برق لا يعمل — شغّله ثم أعد المحاولة' : 'Barq is not running'));
  }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    toastRoot.append(t); setTimeout(() => t.remove(), Math.max(4000, String(msg).length * 70));
  }

  /* ---------- إظهار/إخفاء الزر ---------- */
  const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  function place(v) {
    if (!v || !v.isConnected) return hide();
    const r = v.getBoundingClientRect();
    if (r.width < 160 || r.height < 90 || r.bottom < 0 || r.top > innerHeight) return hide();
    host.style.display = 'block';
    host.style.top = (window.scrollY + Math.max(r.top, 0) + 10) + 'px';
    host.style.left = (window.scrollX + r.right - 10 - host.offsetWidth) + 'px';
  }
  function hide() {
    clearTimeout(hideTimer); hideTimer = null; host.style.display = 'none'; $('m').classList.remove('on');
    if (current && current.tagName !== 'VIDEO') { ytHover = null; current = null; }
  }
  function laterHide(ms) { if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; hide(); }, ms); }
  function show(el) {
    if (!enabled) return;
    if (el.tagName === 'VIDEO') ytHover = null;
    current = el; clearTimeout(hideTimer); hideTimer = null;
    place(el);
    try { $('arr').style.display = directPick() ? 'none' : ''; } catch { $('arr').style.display = ''; }
  }
  $('b').addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.composedPath().includes($('x'))) { enabled = false; hide(); return; }
    if (!alive()) { teardown(); return; }
    if ($('m').classList.contains('on')) { $('m').classList.remove('on'); return; }
    try { scanPage(); } catch { /* ignore */ }
    const pick = directPick();
    // فيديو واحد (يوتيوب، مواقع التواصل، أغلب المواقع): نافذة التنزيل مباشرة دون قائمة
    if (pick) { download(pick); return; }
    renderMenu(); $('m').classList.add('on');
  }, L);
  host.addEventListener('mouseenter', () => { clearTimeout(hideTimer); hideTimer = null; }, L);
  document.addEventListener('click', () => $('m').classList.remove('on'), L);

  /* ---------- يوتيوب: زر فوق أي مصغّرة عند تمرير المؤشر (بدون فتح الفيديو) ---------- */
  let ytHover = null;
  const YT_LINK = 'a[href*="/watch?v="], a[href^="/shorts/"], a[href*="youtube.com/shorts/"]';
  function ytLinkUrl(a) {
    try {
      const u = new URL(a.href, location.href);
      const sh = /^\/shorts\/([\w-]{6,})/.exec(u.pathname);
      if (sh) return `https://www.youtube.com/shorts/${sh[1]}`;
      const v = u.searchParams.get('v');
      return v ? `https://www.youtube.com/watch?v=${v}` : null;
    } catch { return null; }
  }
  function ytTitle(a) {
    const box = a.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, yt-lockup-view-model, ytd-video-preview') || a;
    const t = box.querySelector('#video-title, h3, [title]');
    return ((t && (t.getAttribute('title') || t.textContent)) || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim().slice(0, 150);
  }
  function ytThumbAt(target) {
    const a = target && target.closest && target.closest(YT_LINK);
    if (!a || a.closest('.html5-video-player')) return null;      // روابط داخل المشغّل نفسه ليست مصغّرات
    const url = ytLinkUrl(a); if (!url) return null;
    const area = a.closest('ytd-thumbnail, yt-thumbnail-view-model, .ytThumbnailViewModelHost') || a;
    const r = area.getBoundingClientRect();
    if (r.width < 150 || r.height < 80) return null;
    return { a, url, area };
  }

  /* ---------- تتبع المؤشر (مرة لكل إطار رسم) ---------- */
  let lastHref = location.href;
  function checkNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    items = []; ytHover = null; current = null; hide(); queueScan();
  }
  let mx = -1, my = -1, rafQueued = false, lastTarget = null;
  function onPointer() {
    rafQueued = false;
    if (!enabled) return;
    checkNavigation();
    // فوق الزر نفسه: لا شيء
    if (host.style.display !== 'none' && (inRect(host.getBoundingClientRect(), mx, my) || ($('m').classList.contains('on') && inRect($('m').getBoundingClientRect(), mx, my)))) { clearTimeout(hideTimer); hideTimer = null; return; }
    if (YT) {
      const th = ytThumbAt(lastTarget);
      if (th) {
        if (!ytHover || ytHover.url !== th.url || current !== th.area || host.style.display === 'none') {
          ytHover = { url: th.url, title: ytTitle(th.a) };
          current = th.area; clearTimeout(hideTimer); hideTimer = null; place(th.area); $('arr').style.display = 'none';
        } else { clearTimeout(hideTimer); hideTimer = null; }
        return;
      }
    }
    for (const v of videos) {
      if (!v.isConnected) continue;
      const r = v.getBoundingClientRect();
      if (r.width && inRect(r, mx, my)) {
        if (current !== v || host.style.display === 'none') show(v); else { clearTimeout(hideTimer); hideTimer = null; }
        return;
      }
    }
    // المؤشر خارج كل شيء: نخفي بعد مهلة
    if (host.style.display !== 'none') laterHide($('m').classList.contains('on') ? 2500 : 1500);
  }
  document.addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY; lastTarget = e.target;
    if (!rafQueued) { rafQueued = true; requestAnimationFrame(onPointer); }
  }, LP);
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) laterHide(800); }, LP);
  // التمرير داخل أي حاوية (شورتس، تيك توك، النوافذ المنبثقة…): نعيد تموضع الزر أو نخفيه
  document.addEventListener('scroll', () => {
    if (host.style.display === 'none' || !current) return;
    const r = current.getBoundingClientRect();
    if (!inRect(r, mx, my)) hide(); else place(current);
  }, { signal: ac.signal, passive: true, capture: true });
  window.addEventListener('yt-navigate-finish', () => { ytHover = null; current = null; hide(); queueScan(); }, L);
  window.addEventListener('popstate', checkNavigation, L);

  function hook(v) { if (v.__nz) return; v.__nz = true; }
  collectVideos();
  mo = new MutationObserver((muts) => { if (muts.some(m => m.addedNodes.length)) queueScan(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(() => { try { scanPage(); } catch { /* ignore */ } }, 1500);
  send({ type: 'getMedia' }).then((r) => { if (r) { items = r.items || []; enabled = r.panel !== false; } });
  try {
    B.runtime.onMessage.addListener((msg, _s, reply) => {
      if (!alive()) { teardown(); return; }
      if (msg.type === 'media') { items = msg.items || []; if ($('m').classList.contains('on')) renderMenu(); }
      if (msg.type === 'toast') toast(msg.msg);
      // الطلبات التالية تخص الصفحة الرئيسية فقط (لا الإطارات الإعلانية)
      if (window !== window.top && (msg.type === 'pageVideo' || (msg.type === 'collectLinks' && !msg.selection))) return;
      if (msg.type === 'pageVideo') {
        if (YT) {
          const visibleHover = host.style.display !== 'none' && ytHover;
          let u = visibleHover ? ytHover.url : ytUrl();
          if (!u) { const pv = videos.find(v => v.isConnected && !v.paused && v.getBoundingClientRect().width > 150); u = pv ? ytPlayerUrl(pv) : null; }
          reply(u ? { url: u, social: false } : { url: location.href, social: false, notVideo: true });
          return;
        }
        let best = null, area = 0;
        for (const v of videos) {
          if (!v.isConnected) continue;
          const r = v.getBoundingClientRect();
          const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
          if (a > area) { area = a; best = v; }
        }
        const post = postUrl(best);
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
  } catch { teardown(); }
})();
