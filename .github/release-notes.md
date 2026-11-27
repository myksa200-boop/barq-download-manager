## برق 1.4.3 — Barq Download Manager

**التثبيت:** حمّل `Barq-Setup-1.4.3.exe` وشغّله. إن كان لديك إصدار سابق فسيُرقّى في مكانه وتبقى تنزيلاتك وإعداداتك كما هي.

| الملف | الوصف |
|---|---|
| `Barq-Setup-1.4.3.exe` | مثبّت ويندوز (64-bit) |
| `barq-chromium.zip` | الإضافة لـ Chrome / Edge / Brave / Opera |
| `barq-firefox.zip` | الإضافة لـ Firefox |

### الجديد في 1.4.3
- **خطأ «HTTP Error 103» عند استخراج الفيديو من الصفحة:** بعض المواقع (مثل خوادم Meta و muse.ai) ترسل ردّاً تمهيدياً 103 (Early Hints) كان yt-dlp يعدّه خطأً. صار برق يعيد المحاولة تلقائياً بمحاكاة متصفح Chrome، ويتذكّر الموقع ليستعملها في التنزيل أيضاً.
- **رسائل أوضح** حين لا يجد yt-dlp فيديو في الصفحة أو حين يطلب الموقع تسجيل الدخول: تشرح أن تشغّل الفيديو ثم تختاره من قائمة برق على الفيديو (MP4) بدلاً من «الصفحة»، بدل النص الإنجليزي الخام.

### What's new in 1.4.3
- **"HTTP Error 103" when extracting a video from a page:** some servers (e.g. Meta / muse.ai) send a 103 Early Hints response that yt-dlp treated as an error. Barq now retries with Chrome impersonation and remembers the site so the download uses it too.
- **Clearer messages** when yt-dlp finds no video on a page or the site needs a login, pointing to the video's own MP4 entry in Barq's menu instead of "Page".

**SHA-256:** `552CFA30CCE962E31E3FB2C068CC06EDC5A0D24021616CDD2A1D59F8FAE91D9C`

> ملف التثبيت غير موقّع رقمياً؛ قد يعرض Windows SmartScreen تنبيهاً عند التشغيل: اختر «مزيد من المعلومات» ثم «تشغيل على أي حال».