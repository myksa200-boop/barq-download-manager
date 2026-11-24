## برق 1.4.2 — Barq Download Manager

**التثبيت:** حمّل `Barq-Setup-1.4.2.exe` وشغّله. إن كان لديك إصدار سابق فسيُرقّى في مكانه وتبقى تنزيلاتك وإعداداتك كما هي.

| الملف | الوصف |
|---|---|
| `Barq-Setup-1.4.2.exe` | مثبّت ويندوز (64-bit) |
| `barq-chromium.zip` | الإضافة لـ Chrome / Edge / Brave / Opera |
| `barq-firefox.zip` | الإضافة لـ Firefox |

### الجديد في 1.4.2
- **محرك اتصال ثانٍ يدعم HTTP/2 و HTTP/3 (QUIC):** من الخيارات ← الاتصال ← «محرك الاتصال». يستخدم شبكة Chromium داخل البرنامج (بصمة متصفح حقيقية، ويحترم بروكسي النظام)، ويبقى لكل اتصال تنزيل اتصاله المستقل فلا يضيع تسريع تعدد الاتصالات. الافتراضي يبقى «تلقائي» (HTTP/1.1 باتصالات متعددة).
- **الخوادم التي ترفض برق:** بعض الخوادم كانت تقطع الاتصال على برق بينما تعمل في البرامج الأخرى. صار برق يجرّب تلقائياً هوية برنامج تنزيل صريحة ثم المحرك الآخر، ويتذكّر ما نجح لكل موقع.
- **«طلبات كثيرة» (429) و«الخدمة غير متاحة» (503) عند بدء التنزيل:** كان التنزيل يتوقف بخطأ فوراً؛ صار ينتظر المدة التي يطلبها الخادم (Retry-After) ويعيد المحاولة، وكذلك عند انقطاع عابر في أول اتصال.
- هوية المتصفح المرسلة صارت كروم 156 (نفس إصدار Chromium في البرنامج) بدل كروم 130 القديم.

### What's new in 1.4.2
- **Second network engine with HTTP/2 and HTTP/3 (QUIC):** Options → Connection → Network engine. It uses Chromium's network stack (real browser TLS fingerprint, system proxy), with an independent connection per download segment so multi-connection acceleration is kept. Default stays "Auto" (HTTP/1.1, multiple connections).
- **Servers that refused Barq:** on a reset or 403 Barq now retries with a plain download-manager identity, then with the other engine, and remembers what worked per site.
- **HTTP 429/503 when a download starts** no longer fails immediately: Barq honours Retry-After and retries; a transient reset on the first request is retried too.
- Default browser identity updated to Chrome 156.

**SHA-256:** `706FE8B3D89354D1097623B18E46236C59F7AA06D7F1E523DDC1CEB5723A398A`

> ملف التثبيت غير موقّع رقمياً؛ قد يعرض Windows SmartScreen تنبيهاً عند التشغيل: اختر «مزيد من المعلومات» ثم «تشغيل على أي حال».
