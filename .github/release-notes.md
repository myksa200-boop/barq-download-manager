## برق 1.4.1 — Barq Download Manager

**التثبيت:** حمّل `Barq-Setup-1.4.1.exe` وشغّله. إن كان لديك إصدار سابق فسيُرقّى في مكانه وتبقى تنزيلاتك وإعداداتك كما هي.

| الملف | الوصف |
|---|---|
| `Barq-Setup-1.4.1.exe` | مثبّت ويندوز (64-bit) |
| `barq-chromium.zip` | الإضافة لـ Chrome / Edge / Brave / Opera |
| `barq-firefox.zip` | الإضافة لـ Firefox |

### الإصلاحات في 1.4.1
- **فيديوهات HLS بصيغة fMP4 كانت تخرج تالفة أحياناً:** مقطع التهيئة (`EXT-X-MAP`) كان يُجلب بعد بدء تنزيل المقاطع، فإذا انتهت المقاطع قبله (أو عند استئناف تنزيل كل مقاطعه موجودة) يُدمج الملف بدونه. صار يُجلب أولاً، وإن تعذّر جلبه يظهر خطأ واضح بدل ملف تالف.
- **تسرّب ذاكرة في تنزيلات HLS و DASH:** كل مقطع كان يترك مستمع إيقاف في الذاكرة حتى نهاية التنزيل (آلاف في الفيديوهات الطويلة). صار يُزال فوراً، والإيقاف المؤقت صار يقطع الاتصال الجاري فوراً بدل انتظار انتهاء المقطع.
- **ملفات كوكيز مؤقتة:** ملفات الكوكيز التي يمرّرها برق إلى yt-dlp كانت تبقى على القرص إذا أُغلق البرنامج أثناء التنزيل. صارت تُحذف عند بدء البرنامج وعند إيقاف التنزيل أثناء التجهيز.
- **النسبة المئوية في عمود الحالة** كانت تظهر مقلوبة («%45.7 متوقف»)، وكذلك «جارٍ تجهيز … %».
- **حقول الأرقام في الخيارات** كانت تعرض الأرقام بالهندية (٣٠) خلافاً لبقية البرنامج؛ صارت لاتينية، والأرقام العربية المكتوبة تُحوَّل تلقائياً.
- نافذة إضافة التنزيل المستقلة كانت تستبدل قائمة الطوابير بمعرّفات الطوابير الشغّالة.
- إعداد «أقصى عدد اتصالات» يُقرأ رقماً لا نصاً.
- نوافذ البرنامج تعمل الآن داخل بيئة Chromium المعزولة (sandbox).

### Fixes in 1.4.1
- HLS fMP4 (`EXT-X-MAP`) downloads could be merged without their init segment (corrupt video) when the media segments finished first or on resume; the init segment is now fetched first.
- Memory leak: one abort listener per HLS/DASH segment was kept until the download ended; pausing now also stops the in-flight segment immediately.
- Temporary yt-dlp cookie files left behind after a crash are deleted at startup.
- Reversed percent sign in the status column and in "Preparing … %".
- Number fields in Options now use Latin digits.
- The standalone add-download window no longer overwrites its queue list.
- Renderer sandbox enabled.

**SHA-256:** `55E2BFB8CEEE2F909F4291748419B93FAB07245E1410DDE327DF37F52F7177DD`

> ملف التثبيت غير موقّع رقمياً؛ قد يعرض Windows SmartScreen تنبيهاً عند التشغيل: اختر «مزيد من المعلومات» ثم «تشغيل على أي حال».
