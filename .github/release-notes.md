## برق 1.4.0 — Barq Download Manager

**التثبيت:** حمّل `Barq-Setup-1.4.0.exe` وشغّله. إن كان لديك إصدار سابق فسيُرقّى في مكانه وتبقى تنزيلاتك وإعداداتك كما هي.

| الملف | الوصف |
|---|---|
| `Barq-Setup-1.4.0.exe` | مثبّت ويندوز (64-bit) |
| `barq-chromium.zip` | الإضافة لـ Chrome / Edge / Brave / Opera |
| `barq-firefox.zip` | الإضافة لـ Firefox |

### الجديد في 1.4.0
- **المواقع التي لا تسلّم ملفاتها إلا للمتصفح:** بعض المواقع تحمي ملفاتها بفحص ضد البرامج الآلية فترد على برق بخطأ 403. صارت الإضافة تسأل البرنامج أولاً قبل أن تلغي تنزيل المتصفح؛ فإن رفض الموقع برق يكمل التنزيل في المتصفح تلقائياً بدل ظهور نافذة خطأ.
- رسالة أوضح عند إضافة رابط من موقع كهذا يدوياً، بدل «الرابط منتهي الصلاحية».
- الإضافة المثبتة تحدّث نفسها إلى 1.4.0 بعد تحديث البرنامج.

### What's new in 1.4.0
- **Sites that only serve files to the browser:** some sites answer download managers with HTTP 403 (bot checks). The extension now asks Barq first, before cancelling the browser download; if the site refuses Barq, the download simply continues in the browser instead of failing.
- Clearer message when such a link is added manually.

**SHA-256:** `9BF15B93594ABF2F8327008E054B3F1276C99352C773D02F5059DEDCA19DC1FA`

> ملف التثبيت غير موقّع رقمياً؛ قد يعرض Windows SmartScreen تنبيهاً عند التشغيل: اختر «مزيد من المعلومات» ثم «تشغيل على أي حال».
