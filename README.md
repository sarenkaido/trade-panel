# Trade Panel — Telegram Mini App

این شاخه نسخه مستقل Mini App پنل اصلی است. رابط کاربری از پنل وب اصلی منتقل شده و احراز هویت با حساب تلگرام انجام می‌شود.

## معماری

- **Telegram Serverless**: میزبانی Mini App، اجرای endpointهای API، احراز هویت معتبر Telegram initData و دیتابیس SQLite.
- **Cloudflare Worker مستقل**: فقط زمان‌بندی بررسی قیمت‌ها با Cron؛ داده‌های کاربر و آلارم‌ها را ذخیره نمی‌کند.
- **Telegram Bot API**: ارسال هشدارها به چت همان کاربری که Mini App را باز کرده است.

تمام عملیات CRUD از طریق Telegram.WebApp.Serverless.call به endpoint تلگرام می‌رود. هر درخواست با ctx.initData.user.id به کاربر صاحب داده محدود می‌شود.

## بخش‌های منتقل‌شده

- آلارم‌ها و دسته‌بندی آن‌ها
- واچ‌لیست
- سناریوها
- پوزیشن‌ها
- استراتژی‌ها
- تسک‌ها
- تب‌های شخصی و یادداشت‌ها
- ماشین‌حساب سمت کاربر
- تنظیمات ظاهری و زبان
- اعلان تلگرام

تنظیم ایمیل و ورود با رمز عبور پنل وب در Mini App استفاده نمی‌شود؛ هویت و دسترسی از Telegram تأیید می‌شود.

## GitHub Actions configuration

در Repository → Settings → Secrets and variables → Actions:

### Secrets
- TGCLOUD_TOKEN: توکن CLI از BotFather → ربات → Serverless → CLI Access.
- CLOUDFLARE_API_TOKEN: توکن Cloudflare با دسترسی Deploy کردن Worker.
- TELEGRAM_BOT_TOKEN: توکن Bot API همان ربات.

### Variables
- CLOUDFLARE_ACCOUNT_ID: شناسه حساب Cloudflare.

شناسه برنامه از TGCLOUD_TOKEN استخراج می‌شود. آدرس Worker و URL برنامه به‌صورت خودکار در مرحله Deploy تنظیم می‌شوند. هیچ توکنی نباید در کد یا فایل تنظیمات commit شود.

## Deploy خودکار

هر Push به شاخه مینی-اپ این مراحل را اجرا می‌کند:

1. نصب وابستگی‌ها و build فایل‌های Mini App
2. تنظیم آدرس برنامه Telegram Serverless در Worker
3. Deploy کردن Worker زمان‌بندی‌کننده مستقل
4. انتشار endpointها و رابط Mini App روی Telegram Serverless
5. اجرای migration دیتابیس Telegram Serverless
6. اجرای smoke test برای endpoint زمان‌بندی هشدارها

## اجرای محلی

برای build کردن فایل‌های رابط از npm ci و npm run build استفاده کن. برای بررسی وضعیت انتشار از npx tgcloud status استفاده کن.

برای اجرای کامل Mini App باید آن را از داخل ربات تلگرام باز کنی؛ مرورگر عادی داده احراز هویت تلگرام را فراهم نمی‌کند.

## ساختار مهم

- index.html: رابط کامل پنل
- tgcloud/endpoints/api.js: API و CRUD داده‌های کاربر
- tgcloud/endpoints/cron.js: بررسی آلارم‌های همه کاربران و ارسال اعلان
- tgcloud/schema.js: جداول SQLite
- worker/src/index.js: فراخوانی زمان‌بندی‌شده endpoint تلگرام
- .github/workflows/deploy-miniapp.yml: انتشار خودکار
