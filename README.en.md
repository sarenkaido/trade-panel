# Price Alert Panel

A self-hosted dashboard for cryptocurrency and stock price alerts. Create alerts in the web panel or Telegram Mini App and receive notifications in Telegram (and optionally by email). The project runs on your own infrastructure.

[فارسی](README.md) · **English**

## Features

- Email/password sign-up and login in the web version
- Long / Short alerts (or directionless alerts) with multiple targets
- Live prices, filters, and categories
- Scenario, positions, strategy, trade tasks, and watchlist tabs
- Position size calculator with risk, leverage, entry, stop-loss, and optional take-profit
- Custom tabs and notes
- Light and dark themes; chart-paper style
- Persian and English interface
- While the panel is open, alert checks update within seconds; background checks run every minute

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Deployment: choose a method

There are **four deployment paths**. First choose which version you want, then choose how to deploy it.

| Version | Deployment method | Best for |
|---|---|---|
| Web app on Cloudflare Workers | GitHub Actions | You want to deploy by selecting a target in GitHub |
| Telegram Mini App | GitHub Actions | You want the Mini App and scheduled alert worker deployed by one workflow |
| Web app on Cloudflare Workers | Manually in the Cloudflare dashboard | You prefer the graphical Cloudflare editor and do not want GitHub Actions |
| Telegram Mini App | Manually in BotFather and Cloudflare dashboards | You prefer to configure the app modules and files through graphical interfaces |

**Which guide should I follow?**
- For GitHub Actions, follow [Deploy with GitHub Actions](#deploy-with-github-actions).
- To avoid GitHub Actions, go directly to [Manual deployment](#manual-deployment-without-github-actions).
- For the web version, follow only the Cloudflare web steps. For the Telegram version, follow only the Mini App steps. To run both versions, deploy each separately.

## Deploy with GitHub Actions

This method uses a personal fork of the repository. You choose the deployment target each time you run the workflow. Pushing code does not deploy anything automatically.

### 1. Prepare your own repository

1. Sign in to GitHub and create a fork: [Fork this project](https://github.com/sarenkaido/trade-panel/fork).
2. Open your fork and go to **Actions**. If GitHub asks, enable workflows for the repository.
3. Open **Settings → Secrets and variables → Actions**. Add the required values here in your own fork.
4. Never put tokens, passwords, or account identifiers in the public upstream repository or in source files.

### 2. Deploy the web version to Cloudflare

This publishes the panel as a website that you can open in a browser.

**A. Create storage**
1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Go to **Storage & Databases → KV** and create a Namespace, for example `trade-panel`.
3. Copy the Namespace ID.

**B. Create a Cloudflare API Token**
1. In Cloudflare, open **My Profile → API Tokens** and create a token.
2. Grant the permissions required to manage and deploy Workers, scoped to your account.
3. Copy the token and your Cloudflare **Account ID**.

**C. Add GitHub secrets**

In your fork, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `KV_NAMESPACE_ID` | The KV Namespace ID |

D1 is optional. If you use it, add the database ID as `D1_DATABASE_ID`. Otherwise, you can skip it.

**D. Deploy**
1. In your fork, open **Actions → Deploy Trade Panel**.
2. Click **Run workflow**.
3. Select **Web only — Cloudflare Worker** and start the workflow.
4. When deployment succeeds, open **Workers & Pages** in Cloudflare and visit the Worker URL.

**E. First-time website setup**
1. Open the Worker URL in your browser and start registration.
2. To send email verification codes, create an account at [Resend](https://resend.com/) and provide an API key as prompted by the panel. Check Resend's current sending limits for free accounts.
3. Verify your email and sign in. Connecting a Telegram bot in the panel settings is optional and is only for notifications.

### 3. Deploy the Telegram Mini App

This version opens inside Telegram. It requires a Telegram bot, a Telegram Serverless / Mini App project in TGCLOUD, and Cloudflare for the scheduled alert checker.

**A. Create a Telegram bot**
1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Choose a bot name and username, then keep the Bot Token private.

**B. Create the TGCLOUD app**
1. Create an account at [TGCLOUD](https://tgcloud.ai/) and create a Telegram Serverless / Mini App project.
2. Obtain the access token for that project. This is the TGCLOUD project token, not the regular Telegram Bot Token.

**C. Prepare Cloudflare**
1. Sign in to Cloudflare.
2. Create an API token with permission to deploy Workers and copy your Account ID.

**D. Add GitHub secrets and variables**

In your fork, open **Settings → Secrets and variables → Actions** and add:

| Name | Type | Value |
|---|---|---|
| `TGCLOUD_TOKEN` | Secret | TGCLOUD project token |
| `CLOUDFLARE_API_TOKEN` | Secret | Cloudflare API token |
| `TELEGRAM_BOT_TOKEN` | Secret | Bot Token from BotFather |
| `CLOUDFLARE_ACCOUNT_ID` | Secret or variable | Cloudflare Account ID |

**E. Deploy the Mini App**
1. Open **Actions → Deploy Trade Panel → Run workflow**.
2. Select **Telegram — Telegram Mini App** and run the workflow.
3. Wait for the Mini App and scheduled alert Worker deployment steps to finish successfully.
4. Open your bot in Telegram, press **Start**, then open the Mini App using its button.

This version signs users in with their Telegram account; web email registration is not required.

## Manual deployment without GitHub Actions

If you do not want to use GitHub Actions, you can deploy the web version entirely through the Cloudflare dashboard. The Telegram Mini App can also be configured through BotFather's graphical Serverless interface, with a Cloudflare Worker for scheduled alert checks.

### Manual method A — Web version using the Cloudflare dashboard

**1. Create a KV Namespace**
1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Go to **Storage & Databases → KV** and create a Namespace.
3. Give it a name such as `trade-panel`.

**2. Create a Worker and paste the code**
1. Open **Workers & Pages** and create a Worker.
2. Open **Edit code**.
3. Open [worker.js](https://github.com/sarenkaido/trade-panel/blob/Main/worker.js) in this repository, copy its full contents, and replace the sample code in the Cloudflare editor.
4. Save the Worker. Set its Compatibility date to `2026-01-01` or later.

**3. Bind KV**
1. In the Worker, open **Settings → Bindings → Add → KV Namespace**.
2. Set the variable name to exactly `ALERTS_KV`.
3. Select the Namespace created in step 1 and save.

**4. Enable scheduled alert checks**
1. Open **Settings → Triggers** or **Cron Triggers**.
2. Add the Cron expression `* * * * *` to run the check every minute.
3. Save and deploy the Worker.

**5. Test**
- Open the `workers.dev` URL shown on the Worker page.
- Create an account and sign in.
- Check **Settings → Logs** in the panel to confirm the latest background check.

**Optional D1 binding:** If you also use D1, create a database in Cloudflare and bind it under **Settings → Bindings → Add → D1 database** with the variable name exactly `DB`. Do not delete the KV Namespace when migrating existing data.

> This method deploys only the web version. The `worker.js` file does not install the Telegram Mini App.

### Manual method B — Telegram Mini App using BotFather's graphical interface

This method does not require GitHub Actions or the TGCLOUD deployment CLI. You can manage the server modules, database schema, and Mini App files through BotFather's Serverless interface. A scheduled Worker is also required in Cloudflare.

**1. Create a bot and enable Serverless**
1. Open [@BotFather](https://t.me/BotFather) and create a bot with `/newbot`.
2. Select your bot from **My Bots**.
3. Open **Serverless** and enable it.

**2. Download the project files**
1. Open the [project repository](https://github.com/sarenkaido/trade-panel), select **Code → Download ZIP**, and extract the archive.
2. The root `index.html` file is the Mini App interface file described by this guide.
3. Locate these files in the `tgcloud` directory:
   - `tgcloud/schema.js`
   - `tgcloud/handlers/message.js`
   - `tgcloud/endpoints/api.js`
   - `tgcloud/endpoints/cron.js`
   - `tgcloud/endpoints/profile.js`
   - `tgcloud/lib/config.js`

**3. Add the modules in BotFather**

In your bot's **Serverless** interface, add or replace the corresponding modules:

| BotFather section | Module name | Project file |
|---|---|---|
| Database / Schema | `schema.js` | `tgcloud/schema.js` |
| Handlers | `message` | `tgcloud/handlers/message.js` |
| Endpoints | `api` | `tgcloud/endpoints/api.js` |
| Endpoints | `cron` | `tgcloud/endpoints/cron.js` |
| Endpoints | `profile` | `tgcloud/endpoints/profile.js` |
| Library | `config` | `tgcloud/lib/config.js` |

Paste the complete contents of each matching file and save it. Keep the module names and paths consistent because the files import one another using these names.

**4. Configure the Mini App URL**
1. Find the App ID in the Serverless / CLI Access area. Do not share the access token. The App ID is the numeric part after `app` and before `:` in the token.
2. In the `config` Library module, replace `APP_ID` in `https://appAPP_ID.tgcloud.ai/` with your own App ID.
3. Save the module.

**5. Upload the Mini App interface**
1. In **Serverless → Mini App Files**, upload the root `index.html`.
2. Make sure it is set as the main Mini App page, named `index.html`.
3. The app URL follows this format: `https://app<APP_ID>.tgcloud.ai/`.

**6. Apply the database schema**

Open **Serverless → Database**. Confirm that the tables from `schema.js` are registered, then use the available Apply / Save or migration action to create them. The endpoints cannot store data until the schema is applied.

**7. Create the scheduled alert Worker in Cloudflare**

This Worker calls the Telegram app's internal endpoint every minute to check alerts.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Workers & Pages** and create a Worker.
2. Open [worker/src/index.js](https://github.com/sarenkaido/trade-panel/blob/Main/worker/src/index.js), copy its full contents, and paste them into **Edit code**.
3. Set the Compatibility date to `2026-11-01` or later.
4. Under **Settings → Variables and Secrets**, add a text variable named `TGCLOUD_APP_URL` with your app URL, for example `https://app123456.tgcloud.ai`.
5. Add a secret named `TELEGRAM_BOT_TOKEN` and enter the regular Bot Token from BotFather.
6. Under **Settings → Triggers → Cron Triggers**, add `* * * * *`.
7. Deploy the Worker.

**8. Configure the bot button and test**
1. In BotFather, set your Mini App URL as the Main Mini App or Menu Button URL.
2. Open your bot and press **Start**. The bot should show the “Open Price Alert Panel” button.
3. Press the button and confirm that the panel opens inside Telegram.
4. Create a test alert and check it after a minute.

> BotFather's graphical Serverless interface supports managing modules, database, and Mini App files. In this manual method, you copy the project files into the matching modules yourself. GitHub Actions or the CLI is more convenient if you want repeatable automated deployments.

Official references: [Telegram Serverless](https://core.telegram.org/bots/serverless) · [Cloudflare Workers dashboard](https://developers.cloudflare.com/workers/)

## Updates

For GitHub Actions deployments, push your changes to your fork, then open **Actions → Deploy Trade Panel → Run workflow** and select the target again. Push does not trigger deployment automatically. For manual deployments, repeat the relevant file update and deploy steps in the Cloudflare or BotFather dashboard.

## First use

- **Web version:** Open your Worker URL, register with email, and verify your address. To receive Telegram notifications, connect your own bot in the panel settings.
- **Telegram Mini App:** Open your bot, press **Start**, and select the Mini App button.

### Create your first alert

Click **＋ New Alert**, enter an asset symbol (for example, BTC) and a target price, then save.

## Storage and database

The web version uses Cloudflare KV by default. You can optionally configure D1 by adding the `D1_DATABASE_ID` secret to your own repository. The database ID must belong to your Cloudflare account.

## Stocks and coins

- **Coins:** Enter the symbol only (`BTC`, `ETH`, etc.).
- **Stocks:** Enter the ticker only (`AMZN`, `TSLA`, `NVDA`, etc.). The app appends `USDT.P` and retrieves the price from futures markets. Symbols ending in `.P` are also treated as perpetual contracts.
- In **Settings → Logs**, a green “Everything is healthy” message indicates that checks are working. Otherwise, the log explains the issue, such as a symbol whose price could not be retrieved.

## Install on your phone or computer

The web version is a web app and can be installed:
- **Android (Chrome):** ⋮ menu → **Install app** or **Add to Home screen**.
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Desktop (Chrome/Edge):** Use the install icon in the address bar.

## Troubleshooting

| Problem | What to check |
|---|---|
| Website returns error 500 | Open Worker → **Logs** in Cloudflare. A “limit exceeded” message may mean the free KV write quota has been reached. |
| KV is not connected | Check the KV binding; its variable name must be exactly `ALERTS_KV`. |
| Alerts do not arrive | Open **Settings → Logs** and inspect the current price, distance to each target, and Telegram delivery result. The Cron expression must be `* * * * *`. |
| Telegram messages do not arrive | Use **Settings → Telegram test** and make sure you have pressed **Start** in your bot. |
| Duplicate messages | An old Worker may still have an active Cron trigger. Disable the old trigger. |
| Deployment fails | Check the failed deployment step and the service configuration. |

## Notes

- **Change password:** Settings → Account. Changing your password closes other sessions.
- **Security:** Bot tokens and Resend keys are stored in KV and are not returned to the browser.
- **Deleting KV** deletes accounts and alerts stored there.
- **Free quota:** 1,000 KV writes per day; the code writes only when data changes.
- Five failed sign-in attempts lock an IP for 10 minutes.

---

## ☕ Support the project

Free, open source (MIT) and runs on **your own** infrastructure — no central server, no ads, no tracking. If it ever saved you from missing a trade (or a stop-loss), consider buying me a coffee. Any amount helps keep the updates coming. 💙

| Network | Wallet |
|---|---|
| **Ethereum** & **BNB Chain** (BSC) | `0x92D262062d36688261032051b2B9Ae08F3644b89` |
| **Solana** | `4oWwKYuiEfaTWvTPu3isGSqHtsKydTy5oLD3qo5PRpKR` |
| **Tron** (TRX / USDT-TRC20) | `TCbk4NGW57Wiy6YJXQmx1pPV2hsw1SQndY` |

> Send only on the listed network, and double-check the address against this page before sending. A ⭐ star on the repo is just as appreciated.

---

## Full backup

Use **Backup & Support** to export a JSON file and move it between the web version and Telegram Mini App. The backup includes alerts, categories, watchlist, scenarios, positions, strategies, tasks, custom tabs, language, and local browser settings (calculator, filters, theme, and active tab).

- Backup files can be moved between the web version and Mini App.
- Login credentials, passwords, bot tokens, and API keys are intentionally excluded.
- The configured email is included, but its verification status must be checked again after restore.
- Back up the destination data before restoring; restore replaces the destination data.
