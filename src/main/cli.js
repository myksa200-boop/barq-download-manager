'use strict';
/**
 * وسائط سطر الأوامر بنفس صيغة IDM:
 *   Barq.exe /d URL [/p local_path] [/f local_file_name] [/q] [/h] [/n] [/a] [/s]
 *   /d رابط التنزيل   /p مجلد الحفظ   /f اسم الملف   /q الخروج بعد الاكتمال
 *   /n وضع صامت بدون نوافذ   /a أضف إلى قائمة الانتظار دون البدء   /s شغّل قائمة الانتظار
 *   /h قطع الاتصال بعد الاكتمال (مقبول للتوافق)
 * تُقبل أيضاً الصيغة --d / -d.
 */
function parseCli(argv) {
  const out = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const m = /^(?:\/|--?)([a-z])$/i.exec(a);
    if (!m) continue;
    switch (m[1].toLowerCase()) {
      case 'd': out.url = args[++i]; break;
      case 'p': out.path = args[++i]; break;
      case 'f': out.file = args[++i]; break;
      case 'q': out.quit = true; break;
      case 'h': out.hangup = true; break;
      case 'n': out.silent = true; break;
      case 'a': out.add = true; break;
      case 's': out.startQueue = true; break;
      default: break;
    }
  }
  return out;
}
module.exports = { parseCli };
