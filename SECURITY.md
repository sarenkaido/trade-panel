# امنیت / Security

هر کس این پروژه را روی **حساب Cloudflare خودش** دیپلوی می‌کند، داده‌هایش (آلارم‌ها، حساب، توکن ربات) فقط در KV/D1 همان حساب می‌ماند. این مخزن هیچ توکن، شناسه یا ایمیل شخصی‌ای ندارد.

## قبل از استفاده
- بلافاصله بعد از دیپلوی، ثبت‌نام کن؛ هر کسی که آدرس ورکر را زودتر ببیند و ثبت‌نام کند، صاحب آن می‌شود. برای قفل کردن ثبت‌نام روی ایمیل خودت، متغیر `OWNER_EMAIL` را بگذار (راهنما در `wrangler.toml`).
- توکن Cloudflare را فقط با دسترسی‌های لازم بساز (Workers + KV + D1) و **هرگز** در فایل یا Issue ننویس. همه‌ی رازها فقط در Secrets گیت‌هاب بمانند.
- توکن ربات تلگرام و کلید Resend را فقط داخل خود سایت وارد کن (در KV/D1 خودت ذخیره می‌شوند)، نه در این مخزن.
- اگر کلیدی لو رفت: در BotFather توکن را Revoke کن، در Cloudflare و Resend کلید جدید بساز.

## چه چیزهایی انجام شده
رمزها با PBKDF2-SHA256 (۱۰۰هزار دور + salt) هش می‌شوند، نشست با کوکی HttpOnly/Secure/SameSite=Strict و امضای HMAC، قفل موقت بعد از چند ورود ناموفق، کد ایمیل با سقف تلاش، و هدرهای `nosniff`، `no-referrer`، `HSTS`، `X-Frame-Options: DENY` و `noindex`.

## گزارش آسیب‌پذیری
لطفاً مشکل امنیتی را به‌صورت عمومی در Issue ننویس. از بخش **Security → Report a vulnerability** همین مخزن در گیت‌هاب گزارش بده.

---

Everyone who deploys this runs it on **their own** Cloudflare account; data stays in their own KV/D1. This repository contains no tokens, IDs or personal e-mails. Register right after deploying (or set `OWNER_EMAIL`), keep all secrets in GitHub Secrets, and report vulnerabilities privately via **Security → Report a vulnerability**.
