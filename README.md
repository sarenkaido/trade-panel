# Price Alerts — Telegram Mini App

این شاخه یک پروژه مستقل برای **Telegram Mini App** است. کد پروژه قدیمی Cloudflare در این شاخه نگهداری نمی‌شود.

## معماری

- **Telegram Serverless**: میزبانی فایل‌های Mini App و مدیریت Bot/endpointهای داخلی.
- **Cloudflare Worker مستقل**: API آلارم‌ها، اعتبارسنجی Telegram initData، بررسی قیمت‌ها با Cron و ارسال اعلان تلگرام.
- **Cloudflare D1 مستقل**: ذخیره آلارم‌ها برای Worker.
- **Telegram Bot API**: ارسال اعلان‌ها به چت کاربر.

Mini App مستقیماً به API ورکر وصل می‌شود. ورکر امضای `initData` را با `TELEGRAM_BOT_TOKEN` بررسی می‌کند؛ بنابراین شناسه کاربر ارسالی از مرورگر به‌تنهایی قابل اعتماد نیست. توکن‌ها فقط در Secrets تنظیم می‌شوند.

## نیازمندی‌های GitHub Actions

در Repository → Settings → Secrets and variables → Actions:

### Secrets
- `TGCLOUD_TOKEN`: توکن CLI از BotFather → ربات → Serverless → CLI Access.
- `CLOUDFLARE_API_TOKEN`: توکن Cloudflare با دسترسی ویرایش و Deploy کردن Workers و مدیریت D1.
- `TELEGRAM_BOT_TOKEN`: توکن Bot API ربات.
- `WORKER_API_SECRET`: یک رشته تصادفی بلند برای محافظت از endpointهای مدیریتی Worker (برای فراخوانی‌های server-to-server آینده).

### Variables
- `CLOUDFLARE_ACCOUNT_ID`: شناسه حساب Cloudflare.
- `D1_DATABASE_ID`: شناسه دیتابیس D1 مخصوص همین Mini App.
- `WORKER_API_URL`: آدرس Worker پس از اولین Deploy، مانند `https://trade-alerts-mini.<subdomain>.workers.dev`.
- `TELEGRAM_BOT_USERNAME`: نام ربات بدون @ (صرفاً برای نمایش/راهنما).

> هیچ‌کدام از توکن‌ها را در کد، فایل‌های تنظیمات یا چت قرار نده.

## راه‌اندازی یک‌باره منابع Cloudflare

1. در Cloudflare یک D1 Database با نام `telegram-mini-alerts` بساز.
2. شناسه آن را در GitHub Variable با نام `D1_DATABASE_ID` قرار بده.
3. یک API Token بساز که برای همان Account اجازه Deploy کردن Workers و مدیریت D1 داشته باشد.
4. Secretها و Variableهای بالا را در GitHub تنظیم کن.

## Deploy خودکار

هر Push به شاخه `مینی-اپ`:
1. فایل‌های Mini App را build می‌کند.
2. `npx tgcloud push` را با `TGCLOUD_TOKEN` اجرا می‌کند.
3. Worker مستقل را با Wrangler Deploy می‌کند.
4. migration دیتابیس D1 را اجرا می‌کند.

آدرس Mini App بعد از اولین انتشار در خروجی مرحله Telegram Serverless در GitHub Actions چاپ می‌شود و باید به‌عنوان Mini App URL در BotFather ثبت شود.

## اجرای محلی

```bash
npm ci
npm run build
npx wrangler dev
```

برای اجرای واقعی داخل تلگرام، Mini App باید از داخل ربات باز شود؛ در مرورگر عادی احراز هویت معتبر Telegram وجود ندارد.

## API Worker

- `GET /api/health`: وضعیت سرویس.
- `GET /api/alerts`: فهرست آلارم‌های کاربر.
- `POST /api/alerts`: ساخت آلارم.
- `PATCH /api/alerts/:id`: فعال/غیرفعال کردن آلارم.
- `DELETE /api/alerts/:id`: حذف آلارم.

تمام endpointهای آلارم به `Authorization: tma <initData>` نیاز دارند. Cron هر دقیقه قیمت را بررسی می‌کند و برای هر هدفی که لمس شود پیام می‌فرستد.

## محدودیت نسخه اول

این نسخه هسته مستقل آلارم و Mini App را پیاده‌سازی می‌کند؛ امکانات جانبی پنل قدیمی (سناریوها، پوزیشن‌ها، استراتژی‌ها، ماشین‌حساب و ایمیل) عمداً به این شاخه منتقل نشده‌اند تا دو پروژه مخلوط نشوند.
