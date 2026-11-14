/**
 * Price Alerts — a personal price-alert panel on a single Cloudflare Worker.
 * See ARCHITECTURE.md for how it works.
 *
 * Required binding:  ALERTS_KV (KV namespace)
 * Optional binding:  DB (D1 database) — if present it becomes the main store (far higher free write limit); data is copied from KV automatically
 * Optional (can also be set inside the site):
 *   RESEND_API_KEY / EMAIL_FROM        e-mail service for the sign-up code
 *   OWNER_EMAIL                        if set, only this e-mail may register
 *   TELEGRAM_TOKEN / TELEGRAM_CHAT_ID  fallback bot when none is connected in Settings
 */

const STOCK_TICKERS = new Set([
  "AAPL","TSLA","NVDA","GOOGL","GOOG","MSFT","AMZN","AMD","META","NFLX",
  "SPX","SPXL","BRK","JPM","V","DIS","PYPL","COIN","SQ","PLTR","SOFI",
  "NIO","XPEV","LI","MSTR","BABA","INTC","UBER","ORCL","CRM","ADBE","QCOM","AVGO","MU","TSM","ASML",
  "BA","KO","PEP","WMT","NKE","MCD","XOM","CVX","PFE","JNJ","UNH","HOOD","RBLX","SHOP","SNAP","ABNB",
  "MARA","RIOT","CRCL","GME","AMC","SPY","QQQ","IWM",
]);

// "AMZN", "amznusdt", "AMZNUSDT.P" -> { base: "AMZN", perp: true }. Stocks (and anything written with .P) are perpetual-futures symbols.
function splitCoin(raw) {
  const c = String(raw || "").toUpperCase().replace(/[\s\/_-]/g, "");
  const m = /^([A-Z0-9]{1,12}?)(?:USDT)?(\.P)?$/.exec(c);
  if (!m) return null;
  return { base: m[1], perp: !!m[2] || STOCK_TICKERS.has(m[1]) };
}
// What gets stored: stocks automatically get the USDT.P suffix (the format exchanges list them in).
function normalizeCoin(raw) {
  const x = splitCoin(raw);
  return x ? x.base + (x.perp ? "USDT.P" : "") : "";
}


async function apiCall(env, method, params, token) {
  const url = `https://api.telegram.org/bot${token || env.TELEGRAM_TOKEN}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v !== null && typeof v === "object" ? JSON.stringify(v) : v]))
      ).toString(),
    });
    const data = await res.json();
    if (!data.ok) console.log(`[api] ${method} failed: ${JSON.stringify(data)}`);
    return data;
  } catch (e) {
    console.log(`[api] ${method} error: ${e}`);
    return { ok: false, error: String(e) };
  }
}

// Destination chats. TELEGRAM_CHAT_ID may hold several ids; the old "main_chat" KV key is a fallback for migrated data.
async function chatIds(env) {
  const t = await kvGetJSON(env, "tg", {});
  if (t.chat) return [String(t.chat)];
  let ids = String(env.TELEGRAM_CHAT_ID || "").split(/[\s,]+/).filter(Boolean);
  if (!ids.length) { const old = await storeGet(env, "main_chat"); if (old) ids = [old]; }
  return ids;
}
// Reads every pending update (paged, so a big backlog can't hide the newest messages).
async function pullUpdates(env, token) {
  let off = 0; const all = [];
  for (let i = 0; i < 6; i++) {
    const params = { limit: 100, timeout: 0, allowed_updates: ["message"] };
    if (off) params.offset = off;
    let r = await apiCall(env, "getUpdates", params, token);
    if (!r.ok && r.error_code === 409 && i === 0) { await apiCall(env, "deleteWebhook", {}, token); r = await apiCall(env, "getUpdates", params, token); }
    if (!r.ok) return { ok: false, error: r.description || r.error || "getUpdates failed" };
    const list = r.result || [];
    all.push(...list);
    if (list.length < 100) break;
    off = list[list.length - 1].update_id + 1;
  }
  return { ok: true, all };
}
async function tgToken(env) { return (await kvGetJSON(env, "tg", {})).token || env.TELEGRAM_TOKEN || ""; }


// Rarely-changing keys are cached in the isolate for a few seconds (every API call reads "auth"): this removes a KV
// round-trip from almost every request. Writes made by this isolate update the cache immediately.
// Storage: if a D1 database is bound as "DB" it is the primary store (free plan: ~100k writes/day instead of KV's 1,000);
// otherwise everything stays in KV. With D1, a key not found yet is copied over from KV on first read, so no manual migration is needed.
let _dbInit = null;
async function dbReady(env) {
  if (!env.DB) return false;
  if (!_dbInit) _dbInit = env.DB.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID").catch((e) => { _dbInit = null; throw e; });
  await _dbInit;
  return true;
}
async function storeGet(env, key) {
  if (!(await dbReady(env))) return env.ALERTS_KV.get(key);
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first();
  if (r) return r.v;
  const old = env.ALERTS_KV ? await env.ALERTS_KV.get(key) : null;
  if (old !== null) await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)").bind(key, old).run();
  return old;
}
async function storePut(env, key, text) {
  if (!(await dbReady(env))) return env.ALERTS_KV.put(key, text);
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(key, text).run();
}
const HOT_KEYS = new Set(["auth", "mail", "tg", "settings", "cats", "wcats", "scats", "pcats", "gcats", "kcats"]);
const HOT_TTL_MS = 15000;
const _hot = new Map();
async function kvGetJSON(env, key, fallback) {
  const hot = HOT_KEYS.has(key);
  if (hot) {
    const c = _hot.get(key);
    if (c && Date.now() - c.t < HOT_TTL_MS) return c.v === null ? fallback : structuredClone(c.v);
  }
  const raw = await storeGet(env, key);
  let v = null;
  if (raw !== null) { try { v = JSON.parse(raw); } catch (e) { v = null; } }
  if (hot) { _hot.set(key, { v, t: Date.now() }); return v === null ? fallback : structuredClone(v); }
  return v === null ? fallback : v;
}
async function kvSetJSON(env, key, val) {
  await storePut(env, key, JSON.stringify(val));
  if (HOT_KEYS.has(key)) _hot.set(key, { v: structuredClone(val), t: Date.now() });
}


const PRICE_FETCH_TIMEOUT_MS = 3500;

// Perpetual-futures price (stocks are listed there as e.g. AMZNUSDT / AMZN_USDT, shown as AMZNUSDT.P). Same strategy as spot: last working exchange first, then all others at once.
const PERP_SOURCES = [
  (b) => ["https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + b + "USDT", (d) => d?.result?.list?.[0]?.lastPrice],
  (b) => ["https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=" + b + "USDT", (d) => d?.data?.[0]?.lastPr],
  (b) => ["https://www.okx.com/api/v5/market/ticker?instId=" + b + "-USDT-SWAP", (d) => d?.data?.[0]?.last],
  (b) => ["https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=" + b + "_USDT", (d) => d?.[0]?.last],
  (b) => ["https://contract.mexc.com/api/v1/contract/ticker?symbol=" + b + "_USDT", (d) => d?.data?.lastPrice],
  (b) => ["https://fapi.binance.com/fapi/v1/ticker/price?symbol=" + b + "USDT", (d) => d?.price],
  (b) => ["https://api-futures.kucoin.com/api/v1/ticker?symbol=" + b + "USDTM", (d) => d?.data?.price],
];
let _perpStart = 0;
async function getPerp(b) {
  const [u0, p0] = PERP_SOURCES[_perpStart](b);
  const v0 = await tryPrice(u0, p0, 2500);
  if (v0 !== null) return v0;
  return new Promise((resolve) => {
    let left = PERP_SOURCES.length - 1;
    PERP_SOURCES.forEach((src, i) => {
      if (i === _perpStart) return;
      const [url, pick] = src(b);
      tryPrice(url, pick).then((v) => {
        if (v !== null) { _perpStart = i; resolve(v); }
        else if (--left === 0) resolve(null);
      });
    });
  });
}

// Spot prices fall through a list of exchanges (some block Workers IPs). The last working one is tried first.
async function tryPrice(url, pick, ms) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(ms || PRICE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = parseFloat(pick(await res.json()));
    return isFinite(v) && v > 0 ? v : null;
  } catch (e) { return null; }
}
const SPOT_SOURCES = [
  (c) => ["https://www.okx.com/api/v5/market/ticker?instId=" + c + "-USDT", (d) => d?.data?.[0]?.last],
  (c) => ["https://api.bybit.com/v5/market/tickers?category=spot&symbol=" + c + "USDT", (d) => d?.result?.list?.[0]?.lastPrice],
  (c) => ["https://api.gateio.ws/api/v4/spot/tickers?currency_pair=" + c + "_USDT", (d) => d?.[0]?.last],
  (c) => ["https://api.mexc.com/api/v3/ticker/price?symbol=" + c + "USDT", (d) => d?.price],
  (c) => ["https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=" + c + "-USDT", (d) => d?.data?.price],
  (c) => ["https://api.bitget.com/api/v2/spot/market/tickers?symbol=" + c + "USDT", (d) => d?.data?.[0]?.lastPr],
  (c) => ["https://api.binance.com/api/v3/ticker/price?symbol=" + c + "USDT", (d) => d?.price],
];
let _srcStart = 1;
// The last working exchange is asked first (short timeout); if it fails, ALL the others are asked at once and the
// first valid answer wins — a blocked exchange (403 / timeout) no longer delays the result.
async function getSpot(c) {
  const [u0, p0] = SPOT_SOURCES[_srcStart](c);
  const v0 = await tryPrice(u0, p0, 2500);
  if (v0 !== null) return v0;
  return new Promise((resolve) => {
    let left = SPOT_SOURCES.length - 1;
    if (left <= 0) return resolve(null);
    SPOT_SOURCES.forEach((src, i) => {
      if (i === _srcStart) return;
      const [url, pick] = src(c);
      tryPrice(url, pick).then((v) => {
        if (v !== null) { _srcStart = i; resolve(v); }
        else if (--left === 0) resolve(null);
      });
    });
  });
}

// Short in-isolate cache (+ shared in-flight requests): the panel, the cron and tab switches never ask an exchange twice within a few seconds.
const _pc = new Map();
const PRICE_TTL_MS = 8000;
function getPrice(coin) {
  const c = coin.toUpperCase(), h = _pc.get(c);
  if (h && (h.p || Date.now() - h.t < (h.v == null ? 3000 : PRICE_TTL_MS))) return h.p || Promise.resolve(h.v);
  const e = { t: Date.now(), v: undefined, p: null };
  e.p = getPriceRaw(c).then((v) => { e.v = v; e.t = Date.now(); e.p = null; return v; }, () => { e.v = null; e.t = Date.now(); e.p = null; return null; });
  _pc.set(c, e);
  return e.p;
}
async function getPriceRaw(coin) {
  const x = splitCoin(coin) || { base: coin.toUpperCase(), perp: false };
  const c = x.base;
  if (x.perp) return getPerp(c);
  if (c === "HYPE" || c === "XMR") {
    try {
      const res = await fetch(
        `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${c}-USDT`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) }
      );
      const data = (await res.json())?.data;
      if (data && data.bestBid) return parseFloat(data.bestBid);
    } catch (e) { /* ignore */ }
    return getSpot(c);
  }
  return getSpot(c);
}

function parseNote(note) {
  const fields = {};
  for (const line of (note || "").split("\n")) {
    const i = line.indexOf(":");
    if (i !== -1) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}


// High/low of the last few 1-minute candles: a wick that touched a target between two cron ticks still fires the alert.
async function getRange(coin) {
  const c = (splitCoin(coin) || { base: coin.toUpperCase() }).base;
  const srcs = [
    [`https://api.bybit.com/v5/market/kline?category=linear&symbol=${c}USDT&interval=1&limit=3`, (d) => d?.result?.list],
    [`https://api.bybit.com/v5/market/kline?category=spot&symbol=${c}USDT&interval=1&limit=3`, (d) => d?.result?.list],
    [`https://www.okx.com/api/v5/market/candles?instId=${c}-USDT&bar=1m&limit=3`, (d) => d?.data],
  ];
  for (const [url, pick] of srcs) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(2500) });
      const rows = pick(await res.json());
      if (!Array.isArray(rows) || !rows.length) continue;
      const hi = Math.max(...rows.map((r) => parseFloat(r[2]))), lo = Math.min(...rows.map((r) => parseFloat(r[3])));
      if (isFinite(hi) && isFinite(lo) && hi > 0) return { hi, lo };
    } catch (e) { /* try next */ }
  }
  return null;
}

let _lastInfo = { pending: 0, missing: [] };

async function checkPricesOnce(env) {
  // Free KV plan = 1,000 writes/day, cron = 1,440 ticks/day, so: fetch each coin once per tick (in parallel)
  // and only write to KV when something really changed. Right before writing, the freshest "alerts" is re-read and
  // our changes are merged into it, so an add/delete made from the panel during the price calls is never lost.
  const snapshot = await kvGetJSON(env, "alerts", { alerts: [] });
  const alerts = snapshot.alerts || [];
  const pending = alerts.filter((a) => (a.triggered || []).length < (a.targets || []).length);
  _lastInfo = { pending: pending.length, missing: [] };
  if (pending.length === 0) return [];

  const priceMap = {};
  await Promise.all([...new Set(pending.map((a) => a.coin))].map(async (coin) => { priceMap[coin] = await getPrice(coin); }));

  // Wick detection costs one extra request per coin, so it is skipped when there are many coins (free plan: 50 subrequests per run).
  const rangeMap = {};
  const coinsP = [...new Set(pending.map((a) => a.coin))];
  if (coinsP.length <= 15) await Promise.all(coinsP.map(async (coin) => { rangeMap[coin] = await getRange(coin); }));

  const newMsgs = [];
  const updates = {};

  for (const a of pending) {
    const price = priceMap[a.coin];
    if (price === null || price === undefined) {
      console.log(`[price] no price for ${a.coin}`);
      if (!_lastInfo.missing.includes(a.coin)) _lastInfo.missing.push(a.coin);
      continue;
    }
    const prev = a.prev_price;
    const rg = rangeMap[a.coin], hi = rg ? Math.max(rg.hi, price) : price, lo = rg ? Math.min(rg.lo, price) : price;
    const upd = { prev_price: price, last_price: price, last_checked: new Date().toISOString(), newlyTriggered: [], lastTriggeredTs: {} };
    let needsPrevTracking = false;

    // Entry price captured at creation; old alerts self-heal from the first price seen.
    let entryPrice = a.entry_price != null ? a.entry_price : a.ref_price;
    let entryHealed = false;
    if (entryPrice === null || entryPrice === undefined) {
      const tp = (a.targets || []).map((t) => t.price);
      entryPrice = tp.length >= 2 ? (Math.min(...tp) + Math.max(...tp)) / 2 : price;
      entryHealed = true;
    }

    for (const t of a.targets || []) {
      const tid = t.id || 0;
      if ((a.triggered || []).includes(tid)) continue;
      const target = t.price;
      const direction = (parseNote(t.note || "")["جهت"] || "").toLowerCase().trim();
      let should = false;
      if ((direction === "long" || direction === "short") && target === entryPrice) {
        // EN (entry point): fires when price reaches/crosses it; the first observation only records the side.
        if (prev === null || prev === undefined) needsPrevTracking = true;
        else if ((prev < target && price >= target) || (prev > target && price <= target)) should = true;
        if (lo <= target && target <= hi && rg) should = true;
      } else if (direction === "long") {
        if (target >= entryPrice) { if (hi >= target) should = true; } // TP
        else { if (lo <= target) should = true; }                      // SL
      } else if (direction === "short") {
        if (target > entryPrice) { if (hi >= target) should = true; }  // SL
        else { if (lo <= target) should = true; }                       // TP
      } else {
        // Direction-less: fires only when the price actually REACHES the target, from either side.
        // The first observation just records which side the price is on (prev_price) — a target
        // below the current price must NOT count as already hit.
        needsPrevTracking = true;
        if (price === target || (rg && lo <= target && target <= hi)) should = true;
        else if (prev !== null && prev !== undefined && prev !== target) {
          if ((prev < target && price >= target) || (prev > target && price <= target)) should = true;
        }
      }
      if (price === target) should = true;
      const kind = (direction === "long" || direction === "short")
        ? (target === entryPrice ? "en" : direction === "long" ? (target > entryPrice ? "tp" : "sl") : (target > entryPrice ? "sl" : "tp"))
        : "n";
      if (should) {
        const lastTrig = a.last_triggered ? a.last_triggered[String(tid)] : null;
        const nowTs = Date.now() / 1000;
        // Only mark the target complete when a notification is actually queued.
        // A suppressed/recent or failed notification must remain eligible for retry.
        if (!lastTrig || nowTs - lastTrig >= 120) {
          upd.lastTriggeredTs[String(tid)] = nowTs;
          newMsgs.push([a, t, price, kind, a.entry_price]);
          upd.newlyTriggered.push(tid);
        }
      }
    }
    if (entryHealed) upd.ref_price = entryPrice;
    // Free KV = 1,000 writes/day. prev_price only matters for WHICH SIDE of each target the price is on, so it is written
    // only when that side changed (or was never recorded) — not every minute.
    let sideChanged = false;
    if (needsPrevTracking) {
      if (prev === null || prev === undefined) sideChanged = true;
      else for (const t of a.targets || []) {
        if ((a.triggered || []).includes(t.id || 0)) continue;
        if ((prev < t.price) !== (price < t.price) || (prev === t.price) !== (price === t.price)) { sideChanged = true; break; }
      }
    }
    if (upd.newlyTriggered.length === 0 && !sideChanged && !entryHealed) continue;
    updates[a.id] = upd;
  }

  if (Object.keys(updates).length > 0) {
    const fresh = await kvGetJSON(env, "alerts", { alerts: [] });
    for (const a of fresh.alerts || []) {
      const upd = updates[a.id];
      if (!upd) continue;
      a.prev_price = upd.prev_price;
      a.last_price = upd.last_price;
      a.last_checked = upd.last_checked;
      if (upd.ref_price !== undefined && a.entry_price == null && a.ref_price == null) a.ref_price = upd.ref_price;
      if (upd.newlyTriggered.length > 0) {
        if (!a.triggered) a.triggered = [];
        for (const tid of upd.newlyTriggered) if (!a.triggered.includes(tid)) a.triggered.push(tid);
      }
      if (Object.keys(upd.lastTriggeredTs).length > 0) {
        if (!a.last_triggered) a.last_triggered = {};
        Object.assign(a.last_triggered, upd.lastTriggeredTs);
      }
    }
    await kvSetJSON(env, "alerts", fresh);
  }
  return newMsgs;
}

// Heartbeat so the panel can show whether the automatic check really runs (≤ 1 write per 3–5 min).
async function heartbeat(env, err) {
  try {
    const prev = await kvGetJSON(env, "last_cron", {});
    const now = Date.now(), m = _lastInfo.missing.join(","), age = now - (prev.t || 0);
    if (!prev.t || age > 300000 || ((m !== (prev.m || "") || err !== (prev.e || "")) && age > 180000)) {
      await kvSetJSON(env, "last_cron", { t: now, p: _lastInfo.pending, m, e: err, n: prev.n });
    }
  } catch (e) { /* diagnostics must never break the check */ }
}

async function runScheduledCheck(env) {
  try {
    const newMsgs = await checkPricesOnce(env);
    await heartbeat(env, "");
    if (newMsgs.length === 0) return;
    const chats = await chatIds(env), tok = await tgToken(env);
    const lang = (await kvGetJSON(env, "settings", {})).lang || "fa", Lb = (fa, e) => (lang === "en" ? e : fa);
    const num = (v) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v >= 1000 ? 2 : v >= 1 ? 4 : 6 });
    const esc = (t) => String(t).replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
    const code = (t) => "`" + String(t).replace(/[`\\]/g, "\\$&") + "`";
    const LINE = "━━━━━━━━━━━━━━";
    const catMap = {};
    for (const c of (await kvGetJSON(env, "cats", [])) || []) catMap[c.id] = c.name;
    const blocks = newMsgs.map(([a, t, price, kind, entry]) => {
      const fields = parseNote(t.note || "");
      const dir = (fields["جهت"] || "").trim(), dl = dir.toLowerCase();
      const dirTxt = dl === "long" || dl === "لانگ" ? "🟢 Long" : dl === "short" || dl === "شورت" ? "🔴 Short" : dir;
      const head = { tp: Lb("✅ TP رسید", "✅ TP hit"), sl: Lb("🛑 استاپ خورد", "🛑 Stop-loss hit"), en: Lb("🚪 به نقطه‌ی ورود رسید", "🚪 Entry reached") }[kind] || Lb("🔔 تریگر خورد", "🔔 Triggered");
      const who = a.coin + (dirTxt ? " " + dirTxt : "");
      const rows = [[Lb("🎯 تارگت: ", "🎯 Target: "), num(t.price)], [Lb("💵 قیمت الان: ", "💵 Price now: "), num(price)]];
      if (kind === "tp" || kind === "sl") {
        const dp = ((price - t.price) / t.price) * 100;
        rows.push([Lb("📏 فاصله: ", "📏 Distance: "), (dp > 0 ? "+" : dp < 0 ? "-" : "") + Math.abs(dp).toFixed(2) + Lb("٪", "%")]);
        if (entry !== null && entry !== undefined) rows.push([Lb("🚪 ورود: ", "🚪 Entry: "), num(entry)]);
      }
      const note = fields["توضیحات"] || "";
      const md = ["*" + esc(a.coin) + "*"], plain = [a.coin];
      if (dirTxt) { md.push(esc(dirTxt)); plain.push(dirTxt); }
      const catName = a.cat ? (catMap[a.cat] || "") : "";
      if (catName) { const cl = Lb("📂 دسته: ", "📂 Category: ") + catName; md.push(esc(cl)); plain.push(cl); }
      if (note) { md.push(">" + esc("📝 " + note)); plain.push("📝 " + note); }
      md.push(LINE, "*" + esc(head) + "*", ...rows.map(([k, v]) => esc(k) + code(v)));
      plain.push(LINE, head, ...rows.map(([k, v]) => k + v));
      return { md: md.join("\n"), plain: plain.join("\n"), ch: a.ch || ["tg"], subject: head + " — " + who, aid: a.id, tid: t.id || 0 };
    });
    const tgBlocks = blocks.filter((x) => x.ch.includes("tg")), emBlocks = blocks.filter((x) => x.ch.includes("email"));
    // If Telegram rejects the formatting, resend as plain text so an alert is never lost.
    const send = async (md, plain) => {
      let ok = true, err = "";
      for (const chat of chats) {
        let r = await apiCall(env, "sendMessage", { chat_id: chat, text: md, parse_mode: "MarkdownV2" }, tok);
        if (!r.ok) r = await apiCall(env, "sendMessage", { chat_id: chat, text: plain }, tok);
        if (!r.ok) {
          ok = false;
          err = String(r.description || r.error || "unknown").slice(0, 80);
        }
      }
      return { ok, err };
    };
    // Free plan allows 50 subrequests per run, so bursts are combined into a few messages.
    // A group whose Telegram message could not be delivered is NOT marked as triggered: it is retried on a later tick.
    const SEP = "\n\n──────────\n\n";
    const failed = [];
    let notifyErr = "";
    const sendGroup = async (grp) => {
      const r = await send(grp.map((x) => x.md).join(SEP), grp.map((x) => x.plain).join(SEP));
      if (!r.ok) { notifyErr = r.err || notifyErr; failed.push(...grp); }
    };
    if (!chats.length) {
      console.log("[notify] no Telegram bot connected");
      if (tgBlocks.length) { notifyErr = "ربات تلگرام وصل نیست"; failed.push(...tgBlocks); }
    } else if (tgBlocks.length <= 3) {
      for (const bl of tgBlocks) await sendGroup([bl]);
    } else {
      let grp = [], len = 0;
      for (const bl of tgBlocks) {
        if (grp.length && len + bl.md.length > 3300) { await sendGroup(grp); grp = []; len = 0; }
        grp.push(bl); len += bl.md.length;
      }
      if (grp.length) await sendGroup(grp);
    }
    if (tgBlocks.length) {
      const fresh = await kvGetJSON(env, "alerts", { alerts: [] });
      if (failed.length) {
        for (const a of fresh.alerts || []) {
          const tids = failed.filter((f) => f.aid === a.id).map((f) => f.tid);
          if (tids.length) {
            a.triggered = (a.triggered || []).filter((x) => !tids.includes(x));
            // Clear the cooldown too; otherwise the next cron tick re-marks the
            // target as triggered without queuing a message, losing the alert.
            if (a.last_triggered) {
              for (const tid of tids) delete a.last_triggered[String(tid)];
            }
          }
        }
        await kvSetJSON(env, "alerts", fresh);
      }
      const lc = await kvGetJSON(env, "last_cron", {});
      await kvSetJSON(env, "last_cron", { ...lc, n: { t: Date.now(), ok: failed.length === 0, e: notifyErr } });
    }
    if (emBlocks.length) {
      const sett = await kvGetJSON(env, "settings", {});
      if (sett.verified && sett.email) {
        const r = await sendEmail(env, sett.email, emBlocks.length === 1 ? emBlocks[0].subject : Lb("🔔 " + emBlocks.length + " هشدار قیمت", "🔔 " + emBlocks.length + " price alerts"), emBlocks.map((x) => x.plain).join(SEP));
        if (!r.ok) console.log("[email] " + r.error);
      }
    }
  } catch (e) {
    console.log(`[check] ${e}`);
    await heartbeat(env, String(e).slice(0, 120));
  }
}


const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"512\" height=\"512\"><rect width=\"24\" height=\"24\" fill=\"#4a63f5\"/><g fill=\"none\" stroke=\"#fff\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" transform=\"translate(4.8 4.8) scale(.6)\"><path d=\"M3 20h18\"/><path d=\"M6 16V8\"/><rect x=\"4.5\" y=\"10\" width=\"3\" height=\"4\" rx=\".5\"/><path d=\"M12 14V4\"/><rect x=\"10.5\" y=\"6\" width=\"3\" height=\"4\" rx=\".5\"/><path d=\"M18 17v-6\"/><rect x=\"16.5\" y=\"12\" width=\"3\" height=\"3\" rx=\".5\"/></g></svg>";
const ICON_192 = "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";
const ICON_512 = "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";
const MANIFEST = JSON.stringify({
  name: "پنل آلارم", short_name: "آلارم", lang: "fa", dir: "rtl", start_url: "/", scope: "/", id: "/",
  display: "standalone", orientation: "portrait", background_color: "#0a0c12", theme_color: "#0a0c12",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});
// Tiny service worker: lets the site install as an app and open instantly; data (/api) is never cached.
const SW_JS = `const C="shell-v1";
self.addEventListener("install",e=>{self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request,u=new URL(r.url);
if(r.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api"))return;
e.respondWith(fetch(r).then(x=>{if(x.ok&&(r.mode==="navigate"||/^\\/(icon|manifest)/.test(u.pathname))){const c=x.clone();caches.open(C).then(h=>h.put(r,c))}return x}).catch(()=>caches.match(r).then(m=>m||(r.mode==="navigate"?caches.match("/"):undefined))))});`;
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const staticRes = (body, type) => new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=3600" } });

const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "strict-transport-security": "max-age=31536000", "permissions-policy": "camera=(), microphone=(), geolocation=()" };
const jsonRes = (o, s = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...SEC_HEADERS, ...headers } });

const _enc = new TextEncoder();
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", _enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, _enc.encode(msg))));
}
function safeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const SESSION_DAYS = 30;
// Account lives in KV key "auth": { user, salt, hash (PBKDF2-SHA256), secret (signs session cookies) }.
const rndHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(pw, saltHex) {
  const k = await crypto.subtle.importKey("raw", _enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, k, 256)));
}
async function newCreds(user, pw) { const salt = rndHex(16); return { user, salt, hash: await pbkdf2(pw, salt), secret: rndHex(32) }; }
const okUser = (u) => u.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(u);
const okPw = (p) => typeof p === "string" && p.length >= 8 && p.length <= 128;

async function makeSession(auth) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return exp + "." + (await hmacHex(auth.secret, exp + "|" + auth.user));
}
async function isLoggedIn(request, auth) {
  if (!auth) return false;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)session=(\d+)\.([0-9a-f]+)/);
  if (!m || Date.now() > Number(m[1])) return false;
  return safeEqual(await hmacHex(auth.secret, m[1] + "|" + auth.user), m[2]);
}

// Best-effort brute-force guard (per isolate): 5 wrong logins -> 10 minutes lock for that IP.
const _fails = new Map();
const lockedOut = (ip) => { const f = _fails.get(ip); return !!f && f.n >= 5 && Date.now() - f.t < 600000; };
const noteFail = (ip) => { const f = _fails.get(ip); if (!f || Date.now() - f.t > 600000) _fails.set(ip, { n: 1, t: Date.now() }); else f.n++; };

// Registration / password reset are confirmed with a one-time code e-mailed to the account address.
async function sendCode(env, to, label, code, ov, en) {
  const body = en ? label + "\n\nVerification code: " + code + "\n\nValid for 10 minutes. If you did not request this, ignore it." : label + "\n\nکد تایید: " + code + "\n\nاعتبار: ۱۰ دقیقه. اگر خودت درخواست ندادی نادیده بگیر.";
  return sendEmail(env, to, label, body, ov);
}

const cookie = (v, maxAge) => "session=" + v + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge;


async function mailReady(env) { return !!(env.RESEND_API_KEY || (await kvGetJSON(env, "mail", {})).key); }
async function sendEmail(env, to, subject, text, ov) {
  const m = await kvGetJSON(env, "mail", {});
  const key = (ov && ov.key) || env.RESEND_API_KEY || m.key || "";
  const from = (ov && ov.from) || env.EMAIL_FROM || m.from || "Alerts <onboarding@resend.dev>";
  if (!key) return { ok: false, error: "email service is not configured" };
  const h = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [to], subject, text,
        html: '<div dir="' + (/[\u0600-\u06FF]/.test(text) ? "rtl" : "ltr") + '" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.9">' + h(text).replace(/\n/g, "<br>") + "</div>",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: r.status + " " + (await r.text()).slice(0, 140) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function pickChannels(env, b) {
  const ch = (Array.isArray(b.ch) ? b.ch : ["tg"]).filter((c) => c === "tg" || c === "email");
  if (!ch.length) ch.push("tg");
  if (ch.includes("email") && !(await kvGetJSON(env, "settings", {})).verified) return null;
  return ch;
}


function apiTargets(b) {
  const direction = ["long", "short"].includes(b.direction) ? b.direction : "";
  const built = (Array.isArray(b.targets) ? b.targets : []).slice(0, 10)
    .map((t) => ({ price: Number(t.price), note: String(t.note || "").replace(/\s+/g, " ").trim().slice(0, 200) }))
    .filter((t) => isFinite(t.price) && t.price > 0)
    .map((t, i) => {
      // Direction is OPTIONAL — the "جهت" note line is only written when one was chosen.
      const f = direction ? ["جهت : " + direction, "وضعیت : فعال"] : ["وضعیت : فعال"];
      if (t.note) f.push("توضیحات : " + t.note);
      return { id: i + 1, price: t.price, note: f.join("\n") };
    });
  return { direction, built };
}

// KV "<key>" = { items: [...], last_id } — an old free-text value is migrated into items on the first read.
// KV "<ckey>" = [{id, name, color}]; deleting a category sets its items back to "uncategorized".
async function handleListApi(request, env, o) {
  const url = new URL(request.url), p = url.pathname, M = request.method;
  const body = async () => { try { return await request.json(); } catch (e) { return {}; } };
  const okColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ""));
  const readItems = async () => {
    const d = await kvGetJSON(env, o.key, {});
    if (Array.isArray(d.items)) return d;
    const old = String(d[o.key] || "");
    const items = [];
    if (o.kind === "w") {
      for (const line of old.split("\n")) {
        const t = line.trim(); if (!t) continue;
        const m = t.match(/^([A-Za-z0-9]{1,12})\s*(.*)$/);
        items.push({ id: items.length + 1, coin: (m ? m[1] : t.slice(0, 12)).toUpperCase(), note: (m ? m[2] : "").slice(0, 10000), cat: 0 });
        if (items.length >= 300) break;
      }
    } else if (old.trim()) {
      const ls = old.split("\n"), first = (ls[0] || "").trim();
      items.push({ id: 1, title: first.slice(0, 80) || "سناریو", text: ls.slice(1).join("\n").slice(0, 20000), cat: 0 });
    }
    const nd = { items, last_id: items.reduce((mx, i) => Math.max(mx, i.id || 0), 0) };
    if (old.trim()) await kvSetJSON(env, o.key, nd);
    return nd;
  };
  const readCats = async () => { const c = await kvGetJSON(env, o.ckey, []); return Array.isArray(c) ? c : []; };
  const validCat = async (cat) => cat === 0 || (await readCats()).some((c) => c.id === cat);
  const cRe = new RegExp("^/api/" + o.cbase + "/(\\d+)$"), iRe = new RegExp("^/api/" + o.base + "/(\\d+)$");

  // categories
  if (p === "/api/" + o.cbase || cRe.test(p)) {
    const cm = p.match(cRe);
    if (M === "GET") return jsonRes({ cats: await readCats() });
    if (M === "POST") {
      const b = await body();
      const name = String(b.name || "").trim().slice(0, 40);
      if (!name) return jsonRes({ error: "invalid" }, 400);
      const color = okColor(b.color) ? String(b.color).toUpperCase() : "#8B5CF6";
      const cs = await readCats();
      if (cs.some((c) => c.name === name)) return jsonRes({ error: "duplicate" }, 400);
      const cat = { id: cs.reduce((mx, c) => Math.max(mx, c.id || 0), 0) + 1, name, color };
      cs.push(cat);
      await kvSetJSON(env, o.ckey, cs);
      return jsonRes({ ok: true, cat });
    }
    if (cm) {
      const cs = await readCats();
      const cat = cs.find((c) => c.id === parseInt(cm[1], 10));
      if (!cat) return jsonRes({ error: "not found" }, 404);
      if (M === "PUT") {
        const b = await body();
        const name = String(b.name || "").trim().slice(0, 40);
        if (!name) return jsonRes({ error: "invalid" }, 400);
        if (cs.some((c) => c.id !== cat.id && c.name === name)) return jsonRes({ error: "duplicate" }, 400);
        cat.name = name;
        if (okColor(b.color)) cat.color = String(b.color).toUpperCase();
        await kvSetJSON(env, o.ckey, cs);
        return jsonRes({ ok: true, cat });
      }
      if (M === "DELETE") {
        await kvSetJSON(env, o.ckey, cs.filter((c) => c.id !== cat.id));
        const data = await readItems();
        let touched = false;
        for (const it of data.items || []) if (it.cat === cat.id) { it.cat = 0; touched = true; }
        if (touched) await kvSetJSON(env, o.key, data);
        return jsonRes({ ok: true });
      }
    }
  }

  // items
  if (p === "/api/" + o.base || iRe.test(p)) {
    const im = p.match(iRe);
    if (M === "GET") { const d = await readItems(); return jsonRes({ items: d.items || [], cats: await readCats() }); }
    if (M === "POST") {
      const b = await body();
      let it;
      if (o.kind === "w") {
        // The watchlist entry is a NAME (any language), not a coin symbol — keep it verbatim.
        const name = String(b.name != null ? b.name : b.coin || "").trim().slice(0, 60);
        if (!name) return jsonRes({ error: "invalid" }, 400);
        it = { coin: name, note: String(b.note || "").trim().slice(0, 10000) };
      } else {
        const title = String(b.title || "").trim().slice(0, 120), text = String(b.text || "").slice(0, 20000);
        if (!title && !text.trim()) return jsonRes({ error: "invalid" }, 400);
        it = { title: title || text.trim().slice(0, 40) || "سناریو", text };
      }
      let cat = Number(b.cat) || 0;
      if (cat && !(await validCat(cat))) cat = 0;
      it.cat = cat;
      const d = await readItems();
      it.id = (d.last_id || 0) + 1;
      d.items.push(it);
      d.last_id = it.id;
      if (d.items.length > 400) d.items = d.items.slice(-400);
      await kvSetJSON(env, o.key, d);
      return jsonRes({ ok: true, id: it.id });
    }
    if (im) {
      const id = parseInt(im[1], 10);
      const d = await readItems();
      const it = (d.items || []).find((x) => x.id === id);
      if (!it) return jsonRes({ error: "not found" }, 404);
      if (M === "PUT") {
        const b = await body();
        if (o.kind === "w") {
          const name = String(b.name != null ? b.name : b.coin || "").trim().slice(0, 60);
          if (!name) return jsonRes({ error: "invalid" }, 400);
          it.coin = name;
          it.note = String(b.note || "").trim().slice(0, 10000);
        } else {
          const title = String(b.title || "").trim().slice(0, 120), text = String(b.text || "").slice(0, 20000);
          if (!title && !text.trim()) return jsonRes({ error: "invalid" }, 400);
          it.title = title || text.trim().slice(0, 40) || "سناریو";
          it.text = text;
        }
        let cat = Number(b.cat) || 0;
        if (cat && !(await validCat(cat))) cat = 0;
        it.cat = cat;
        await kvSetJSON(env, o.key, d);
        return jsonRes({ ok: true });
      }
      if (M === "DELETE") {
        d.items = (d.items || []).filter((x) => x.id !== id);
        await kvSetJSON(env, o.key, d);
        return jsonRes({ ok: true });
      }
    }
  }
  return jsonRes({ error: "not found" }, 404);
}

async function handleApi(request, env, url) {
  const p = url.pathname, M = request.method;
  const body = async () => { try { return await request.json(); } catch (e) { return {}; } };

  const auth = await kvGetJSON(env, "auth", null);
  const ip = request.headers.get("CF-Connecting-IP") || "x";
  const sess = (c) => ({ "set-cookie": cookie(c, SESSION_DAYS * 86400) });
  const loggedIn = await isLoggedIn(request, auth);

  if (M === "GET" && p === "/api/auth/state") return jsonRes({ registered: !!auth, loggedIn, user: loggedIn ? auth.user : "", mail: await mailReady(env), legacy: !!auth && !okUser(auth.user) });
  if (M === "POST" && p === "/api/logout") return jsonRes({ ok: true }, 200, { "set-cookie": cookie("", 0) });

  if (M === "POST" && p === "/api/login") {
    if (!auth) return jsonRes({ error: "no account yet" }, 400);
    if (lockedOut(ip)) return jsonRes({ error: "too many attempts" }, 429);
    const b = await body();
    const hash = await pbkdf2(String(b.password || ""), auth.salt); // always computed, so timing doesn't reveal the email
    const ok = String(b.email || "").trim().toLowerCase() === auth.user && safeEqual(hash, auth.hash);
    if (!ok) { noteFail(ip); await new Promise((r) => setTimeout(r, 800)); return jsonRes({ error: "wrong password" }, 401); }
    _fails.delete(ip);
    return jsonRes({ ok: true }, 200, sess(await makeSession(auth)));
  }
  // Step 1 of register / forgot-password: validate, hash the password, e-mail a one-time code.
  if (M === "POST" && p === "/api/auth/code") {
    const b = await body(), purpose = b.purpose, en = b.lang === "en";
    if (purpose === "register" && auth) return jsonRes({ error: "already registered" }, 400);
    if (purpose === "reset" && !auth) return jsonRes({ error: "no account yet" }, 400);
    if (purpose !== "register" && purpose !== "reset" && purpose !== "email") return jsonRes({ error: "invalid" }, 400);
    if (purpose === "email") {
      if (!auth || !loggedIn) return jsonRes({ error: "unauthorized" }, 401);
      if (!safeEqual(await pbkdf2(String(b.current || ""), auth.salt), auth.hash)) return jsonRes({ error: "wrong password" }, 403);
    }
    const email = purpose !== "reset" ? String(b.email || "").trim().toLowerCase() : auth.user;
    if (!okUser(email) || (purpose !== "email" && !okPw(b.password))) return jsonRes({ error: "invalid email or password" }, 400);
    if (purpose === "email" && email === auth.user) return jsonRes({ error: "same email" }, 400);
    if (purpose !== "reset" && env.OWNER_EMAIL && email !== String(env.OWNER_EMAIL).trim().toLowerCase()) return jsonRes({ error: "this email is not allowed to register" }, 403);
    // First setup: the e-mail service key can be entered right here (kept only after the code is confirmed).
    let ov = null;
    if (!(await mailReady(env))) {
      const key = String(b.resendKey || "").trim().slice(0, 200);
      if (purpose === "reset" || !key) return jsonRes({ error: "email service key required" }, 400);
      ov = { key, from: String(b.from || "").trim().slice(0, 120) };
    }
    const prev = await kvGetJSON(env, "auth_pending", {});
    if (prev.t && Date.now() - prev.t < 60000) return jsonRes({ error: "wait a minute before requesting another code" }, 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const r = await sendCode(env, email, purpose === "register" ? (en ? "Sign-up — Alerts panel" : "ثبت‌نام در پنل آلارم") : purpose === "email" ? (en ? "Email verification — Alerts panel" : "تایید ایمیل پنل آلارم") : (en ? "Password recovery — Alerts panel" : "بازیابی رمز پنل آلارم"), code, ov, en);
    if (!r.ok) return jsonRes({ error: r.error }, 502);
    await kvSetJSON(env, "auth_pending", { purpose, code, t: Date.now(), exp: Date.now() + 600000, tries: 0, creds: purpose === "email" ? { ...auth, user: email, secret: rndHex(32) } : await newCreds(email, b.password), mail: ov });
    return jsonRes({ ok: true });
  }
  // Step 2: check the code, then create / replace the account and log in.
  if (M === "POST" && p === "/api/auth/confirm") {
    const code = String((await body()).code || "").trim();
    const v = await kvGetJSON(env, "auth_pending", {});
    if (!v.code || Date.now() > v.exp) return jsonRes({ error: "no active code, request a new one" }, 400);
    if ((v.tries || 0) >= 5) return jsonRes({ error: "too many attempts, request a new code" }, 429);
    if (code !== v.code) { v.tries = (v.tries || 0) + 1; await kvSetJSON(env, "auth_pending", v); return jsonRes({ error: "wrong code" }, 400); }
    if ((v.purpose === "register" && auth) || (v.purpose !== "register" && !auth) || (v.purpose === "email" && !loggedIn)) return jsonRes({ error: "state changed, start again" }, 400);
    if (v.mail && v.mail.key) await kvSetJSON(env, "mail", { key: v.mail.key, from: v.mail.from || "" });
    if (v.purpose !== "reset") await kvSetJSON(env, "settings", { ...(await kvGetJSON(env, "settings", {})), email: v.creds.user, verified: true }); // the account e-mail is already verified
    await kvSetJSON(env, "auth", v.creds);
    await kvSetJSON(env, "auth_pending", {});
    return jsonRes({ ok: true }, 200, sess(await makeSession(v.creds)));
  }

  if (!loggedIn) return jsonRes({ error: "unauthorized" }, 401);

  if (M === "POST" && p === "/api/lang") {
    const l = (await body()).lang === "en" ? "en" : "fa";
    const st = await kvGetJSON(env, "settings", {});
    if ((st.lang || "fa") !== l) { st.lang = l; await kvSetJSON(env, "settings", st); }
    return jsonRes({ ok: true });
  }

  // Change the password from the settings sheet (needs the current password); logs out other sessions.
  if (M === "POST" && p === "/api/auth/change") {
    const b = await body();
    if (!safeEqual(await pbkdf2(String(b.current || ""), auth.salt), auth.hash)) return jsonRes({ error: "wrong password" }, 403);
    if (!okPw(b.password)) return jsonRes({ error: "invalid password" }, 400);
    const c = await newCreds(auth.user, b.password);
    await kvSetJSON(env, "auth", c);
    return jsonRes({ ok: true }, 200, sess(await makeSession(c)));
  }

  // Telegram bot settings: only the bot token is needed. The chat is found automatically from the /start the owner sends.
  if (p.startsWith("/api/tg")) {
    const t = await kvGetJSON(env, "tg", {});
    const GREET = (await kvGetJSON(env, "settings", {})).lang === "en" ? "✅ Bot connected to the alerts panel. Alerts will arrive here from now on." : "✅ ربات به پنل آلارم وصل شد. از این به بعد اعلان‌ها همین‌جا می‌آیند.";
    const view = (x) => ({ connected: !!(x.token && x.chat), hasToken: !!x.token, bot: x.bot || "", link: x.token && !x.chat && x.bot ? "https://t.me/" + x.bot + "?start=" + x.code : "", viaEnv: !!env.TELEGRAM_TOKEN && !x.token });
    if (M === "GET" && p === "/api/tg") return jsonRes(view(t));
    if (M === "POST" && p === "/api/tg/token") {
      const token = String((await body()).token || "").trim();
      if (!/^\d{5,}:[\w-]{20,}$/.test(token)) return jsonRes({ error: "invalid token format" }, 400);
      const me = await apiCall(env, "getMe", {}, token);
      if (!me.ok || !me.result || !me.result.username) return jsonRes({ error: "Telegram rejected this token" }, 400);
      // A leftover webhook (e.g. from the old bot worker) swallows every message, so nothing could be detected here.
      let wh = false;
      const wi = await apiCall(env, "getWebhookInfo", {}, token);
      if (wi.ok && wi.result && wi.result.url) { await apiCall(env, "deleteWebhook", {}, token); wh = true; }
      const x = { token, bot: me.result.username, chat: null, code: rndHex(8), cands: [] };
      await kvSetJSON(env, "tg", x);
      return jsonRes({ ...view(x), wh });
    }
    if (M === "POST" && p === "/api/tg/detect") {
      if (!t.token || !t.code) return jsonRes({ error: "set a token first" }, 400);
      const pr = await pullUpdates(env, t.token);
      if (!pr.ok) return jsonRes({ error: pr.error }, 502);
      const msgs = pr.all.filter((u) => u.message && u.message.chat && u.message.chat.type === "private" && !(u.message.from || {}).is_bot).reverse();
      const hit = msgs.find((u) => String(u.message.text || "").includes(t.code));
      if (hit) {
        t.chat = hit.message.chat.id; t.cands = [];
        await kvSetJSON(env, "tg", t);
        await apiCall(env, "sendMessage", { chat_id: t.chat, text: GREET }, t.token);
        return jsonRes(view(t));
      }
      // No message carried our code (e.g. Start was pressed before the token was saved): let the owner pick the chat.
      const found = new Map((t.cands || []).map((c) => [c.id, c]));
      for (const u of msgs) { const c = u.message.chat; if (!found.has(c.id)) found.set(c.id, { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id), username: c.username || "" }); }
      t.cands = [...found.values()].slice(0, 8);
      if (!t.cands.length) return jsonRes({ error: "not found yet" }, 404);
      await kvSetJSON(env, "tg", t);
      return jsonRes({ ...view(t), pick: t.cands });
    }
    if (M === "POST" && p === "/api/tg/choose") {
      const id = String((await body()).chat || "");
      const c = (t.cands || []).find((x) => String(x.id) === id);
      if (!t.token || !c) return jsonRes({ error: "invalid chat" }, 400);
      t.chat = c.id; t.cands = [];
      await kvSetJSON(env, "tg", t);
      await apiCall(env, "sendMessage", { chat_id: t.chat, text: GREET }, t.token);
      return jsonRes(view(t));
    }
    if (M === "POST" && p === "/api/tg/disconnect") { await kvSetJSON(env, "tg", {}); return jsonRes(view({})); }
  }

  if (p === "/api/cats" || /^\/api\/cats\/(\d+)$/.test(p)) {
    const cm = p.match(/^\/api\/cats\/(\d+)$/);
    const readCats = async () => { const d = await kvGetJSON(env, "cats", []); return Array.isArray(d) ? d : []; };
    const okColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ""));
    if (M === "GET" && p === "/api/cats") return jsonRes({ cats: await readCats() });
    if (M === "POST" && p === "/api/cats") {
      const b = await body();
      const name = String(b.name || "").trim().slice(0, 40);
      if (!name) return jsonRes({ error: "invalid" }, 400);
      const color = okColor(b.color) ? String(b.color).toUpperCase() : "#8B5CF6";
      const cs = await readCats();
      if (cs.some((c) => c.name === name)) return jsonRes({ error: "duplicate" }, 400);
      const cat = { id: cs.reduce((mx, c) => Math.max(mx, c.id || 0), 0) + 1, name, color };
      cs.push(cat);
      await kvSetJSON(env, "cats", cs);
      return jsonRes({ ok: true, cat });
    }
    if (cm) {
      const cs = await readCats();
      const cat = cs.find((c) => c.id === parseInt(cm[1], 10));
      if (!cat) return jsonRes({ error: "not found" }, 404);
      if (M === "PUT") {
        const b = await body();
        const name = String(b.name || "").trim().slice(0, 40);
        if (!name) return jsonRes({ error: "invalid" }, 400);
        if (cs.some((c) => c.id !== cat.id && c.name === name)) return jsonRes({ error: "duplicate" }, 400);
        cat.name = name;
        if (okColor(b.color)) cat.color = String(b.color).toUpperCase();
        await kvSetJSON(env, "cats", cs);
        return jsonRes({ ok: true, cat });
      }
      if (M === "DELETE") {
        await kvSetJSON(env, "cats", cs.filter((c) => c.id !== cat.id));
        const data = await kvGetJSON(env, "alerts", { alerts: [] });
        let touched = false;
        for (const a of data.alerts || []) if (a.cat === cat.id) { a.cat = 0; touched = true; }
        if (touched) await kvSetJSON(env, "alerts", data);
        return jsonRes({ ok: true });
      }
    }
  }

  if (M === "GET" && p === "/api/alerts") {
    const x = url.searchParams.get("x");
    const [d, cs, lc, st, prov] = await Promise.all([
      kvGetJSON(env, "alerts", { alerts: [] }),
      kvGetJSON(env, "cats", []),
      x ? kvGetJSON(env, "last_cron", {}) : null,
      x === "2" ? kvGetJSON(env, "settings", {}) : null,
      x === "2" ? mailReady(env) : null,
    ]);
    const out = { alerts: d.alerts || [], cats: Array.isArray(cs) ? cs : [] };
    if (x) {
      out.status = { t: lc.t || 0, p: lc.p || 0, m: lc.m || "", e: lc.e || "", now: Date.now(), s: env.DB ? "D1" : "KV" };
      if (st) out.settings = { email: st.email || "", verified: !!st.verified, provider: prov };
    }
    return jsonRes(out);
  }
  if (M === "POST" && p === "/api/check-now") {
    // The open panel saw a price reach a target: run the same check as the cron right now (marks the tick + sends the Telegram message).
    await runScheduledCheck(env);
    return jsonRes({ ok: true });
  }
  if (M === "GET" && p === "/api/prices") {
    // 3s edge cache: repeated polls (tab switches, the 4s live poll) return instantly instead of
    // re-fetching every exchange upstream. Cache is only reached after the auth check above.
    try { const hit = await caches.default.match(request); if (hit) return hit; } catch (e) {}
    const coins = [...new Set((url.searchParams.get("coins") || "").toUpperCase().split(",").filter(Boolean))].slice(0, 40);
    const out = {};
    await Promise.all(coins.map(async (c) => {
      out[c] = await getPrice(c);
      if (out[c] == null) {
        try {
          const r = await fetch("https://www.okx.com/api/v5/market/ticker?instId=" + c + "-USDT", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(2500) });
          out["_why_" + c] = "okx " + r.status + " " + (await r.text()).slice(0, 70);
        } catch (e) { out["_why_" + c] = "okx error: " + e; }
      }
    }));
    const pres = jsonRes(out);
    try { pres.headers.set("cache-control", "public, max-age=3"); await caches.default.put(request, pres.clone()); } catch (e) {}
    return pres;
  }
  if (M === "POST" && p === "/api/alerts") {
    const b = await body();
    const coin = normalizeCoin(b.coin);
    const { direction, built } = apiTargets(b);
    if (!coin || built.length === 0) return jsonRes({ error: "invalid" }, 400);
    const entryIn = Number(b.entry);
    const hasEntry = isFinite(entryIn) && entryIn > 0;
    const ch = await pickChannels(env, b);
    if (!ch) return jsonRes({ error: "email not verified" }, 400);
    const refPrice = hasEntry ? null : await getPrice(coin);
    let cat = Number(b.cat) || 0;
    if (cat) { const cs = await kvGetJSON(env, "cats", []); if (!Array.isArray(cs) || !cs.some((c) => c.id === cat)) cat = 0; }
    const data = await kvGetJSON(env, "alerts", { alerts: [], last_id: 0 });
    const aid = (data.last_id || 0) + 1;
    data.alerts.push({ id: aid, coin, targets: built, triggered: [], prev_price: null, entry_price: hasEntry ? entryIn : null, ref_price: refPrice, ch, cat });
    data.last_id = aid;
    await kvSetJSON(env, "alerts", data);
    return jsonRes({ ok: true, id: aid });
  }
  if (M === "DELETE" && p === "/api/alerts") {
    await kvSetJSON(env, "alerts", { alerts: [], last_id: 0 });
    await kvSetJSON(env, "reported_ids", []);
    return jsonRes({ ok: true });
  }
  const m = p.match(/^\/api\/alerts\/(\d+)$/);
  if (m && M === "DELETE") {
    const id = parseInt(m[1], 10);
    const data = await kvGetJSON(env, "alerts", { alerts: [] });
    data.alerts = (data.alerts || []).filter((a) => a.id !== id);
    await kvSetJSON(env, "alerts", data);
    return jsonRes({ ok: true });
  }
  if (m && M === "PUT") {
    const id = parseInt(m[1], 10);
    const b = await body();
    const { direction, built } = apiTargets(b);
    if (built.length === 0) return jsonRes({ error: "invalid" }, 400);
    const data = await kvGetJSON(env, "alerts", { alerts: [] });
    const a = (data.alerts || []).find((x) => x.id === id);
    if (!a) return jsonRes({ error: "not found" }, 404);
    const oldT = a.targets || [];
    const oldDir = ((parseNote((oldT[0] || {}).note || "")["جهت"]) || "").toLowerCase().trim();
    const triggered = [];
    let targetsChanged = false;
    built.forEach((t, i) => {
      const o = oldT[i];
      if (o && o.price === t.price && oldDir === direction && (a.triggered || []).includes(o.id)) triggered.push(t.id);
      else targetsChanged = true;
    });
    const entryIn = Number(b.entry);
    const hasEntry = isFinite(entryIn) && entryIn > 0;
    const ch = await pickChannels(env, b);
    if (!ch) return jsonRes({ error: "email not verified" }, 400);
    a.ch = ch;
    const catsNow = await kvGetJSON(env, "cats", []);
    const catIn = Number(b.cat) || 0;
    a.cat = catIn && Array.isArray(catsNow) && catsNow.some((c) => c.id === catIn) ? catIn : 0;
    let entryChanged = false;
    if (hasEntry && entryIn !== a.entry_price) { a.entry_price = entryIn; entryChanged = true; }
    else if (!hasEntry && a.entry_price != null) { a.ref_price = a.entry_price; a.entry_price = null; }
    a.targets = built;
    a.triggered = entryChanged ? [] : triggered;
    a.last_triggered = {};
    if (entryChanged || targetsChanged) a.prev_price = null; // changed targets re-arm the alert: fresh crossing baseline
    await kvSetJSON(env, "alerts", data);
    return jsonRes({ ok: true });
  }
  if (M === "GET" && p === "/api/settings") {
    const st = await kvGetJSON(env, "settings", {});
    return jsonRes({ email: st.email || "", verified: !!st.verified, provider: await mailReady(env) });
  }
  if (M === "POST" && p === "/api/email/request") {
    const email = String((await body()).email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return jsonRes({ error: "invalid email" }, 400);
    const prev = await kvGetJSON(env, "email_verify", {});
    if (prev.t && Date.now() - prev.t < 60000) return jsonRes({ error: "wait a minute before requesting another code" }, 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const r = await sendEmail(env, email, "کد تایید ایمیل", "کد تایید شما: " + code + "\n\nاین کد ۱۰ دقیقه اعتبار دارد.");
    if (!r.ok) return jsonRes({ error: r.error }, 502);
    await kvSetJSON(env, "email_verify", { email, code, t: Date.now(), exp: Date.now() + 600000, tries: 0 });
    return jsonRes({ ok: true });
  }
  if (M === "POST" && p === "/api/email/verify") {
    const code = String((await body()).code || "").trim();
    const v = await kvGetJSON(env, "email_verify", {});
    if (!v.code || Date.now() > v.exp) return jsonRes({ error: "no active code, request a new one" }, 400);
    if ((v.tries || 0) >= 5) return jsonRes({ error: "too many attempts, request a new code" }, 429);
    if (code !== v.code) { v.tries = (v.tries || 0) + 1; await kvSetJSON(env, "email_verify", v); return jsonRes({ error: "wrong code" }, 400); }
    await kvSetJSON(env, "settings", { ...(await kvGetJSON(env, "settings", {})), email: v.email, verified: true });
    await kvSetJSON(env, "email_verify", {});
    return jsonRes({ ok: true });
  }
  if (M === "POST" && p === "/api/email/remove") {
    await kvSetJSON(env, "settings", { ...(await kvGetJSON(env, "settings", {})), email: "", verified: false });
    return jsonRes({ ok: true });
  }
  if (M === "POST" && p === "/api/test-notify") {
    const chats = await chatIds(env), tok = await tgToken(env), en0 = (await kvGetJSON(env, "settings", {})).lang === "en";
    const out = { tg: { ok: false, error: "ربات تلگرام وصل نیست (تنظیمات ← ربات تلگرام)" }, email: { ok: false, skipped: true, error: "" } };
    if (chats.length) {
      let err = "";
      for (const chat of chats) {
        const r = await apiCall(env, "sendMessage", { chat_id: chat, text: en0 ? "🔔 Test notification\n\nIf you can see this message, alerts will arrive here when they fire ✅" : "🔔 تست اعلان\n\nاگر این پیام را می‌بینی، وقتی آلارمی فایر شود همین‌جا خبر می‌دهم ✅" }, tok);
        if (!r.ok) err = r.description || r.error || "failed";
      }
      out.tg = { ok: !err, error: err };
    }
    const st = await kvGetJSON(env, "settings", {});
    if (st.verified && st.email) {
      const e = await sendEmail(env, st.email, en0 ? "🔔 Test notification" : "🔔 تست اعلان", en0 ? "If you can see this email, I will email you when an alert fires ✅" : "اگر این ایمیل را می‌بینی، وقتی آلارمی فایر شود برایت ایمیل می‌فرستم ✅");
      out.email = { ok: e.ok, skipped: false, error: e.error || "" };
    }
    return jsonRes(out);
  }
  if (M === "GET" && p === "/api/status") {
    const d = await kvGetJSON(env, "last_cron", {});
    return jsonRes({ t: d.t || 0, p: d.p || 0, m: d.m || "", e: d.e || "", n: d.n || null, now: Date.now(), s: env.DB ? "D1" : "KV" });
  }
  if (M === "POST" && p === "/api/alerts/reorder") {
    const ids = ((await body()).ids || []).map(Number);
    const data = await kvGetJSON(env, "alerts", { alerts: [] });
    const byId = new Map((data.alerts || []).map((x) => [x.id, x]));
    const out = [];
    for (const id of ids) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
    for (const x of byId.values()) out.push(x);
    data.alerts = out;
    await kvSetJSON(env, "alerts", data);
    return jsonRes({ ok: true });
  }
  if (M === "POST" && p === "/api/sync") {
    const msgs = await checkPricesOnce(env);
    return jsonRes({ ok: true, n: msgs.length });
  }
  const mt = p.match(/^\/api\/alerts\/(\d+)\/tick$/);
  if (mt && M === "POST") {
    const id = parseInt(mt[1], 10), tid = parseInt((await body()).tid, 10);
    const data = await kvGetJSON(env, "alerts", { alerts: [] });
    const a = (data.alerts || []).find((x) => x.id === id);
    if (!a || !(a.targets || []).some((t) => t.id === tid)) return jsonRes({ error: "not found" }, 404);
    a.triggered = a.triggered || [];
    const i = a.triggered.indexOf(tid);
    if (i >= 0) { a.triggered.splice(i, 1); a.prev_price = null; if (a.last_triggered) delete a.last_triggered[String(tid)]; } // re-armed: fresh crossing baseline
    else a.triggered.push(tid);
    await kvSetJSON(env, "alerts", data);
    return jsonRes({ ok: true, on: i < 0 });
  }
  // Bulk actions on selected alerts (selection mode): delete or move to a category — one KV write.
  if (M === "POST" && p === "/api/alerts/bulk") {
    const b = await body();
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isFinite(n));
    if (!ids.length) return jsonRes({ error: "invalid" }, 400);
    const data = await kvGetJSON(env, "alerts", { alerts: [] });
    if (b.act === "del") {
      data.alerts = (data.alerts || []).filter((a) => !ids.includes(a.id));
    } else if (b.act === "cat") {
      const cat = Number(b.cat) || 0;
      if (cat) { const cs = await kvGetJSON(env, "cats", []); if (!Array.isArray(cs) || !cs.some((c) => c.id === cat)) return jsonRes({ error: "invalid" }, 400); }
      for (const a of data.alerts || []) if (ids.includes(a.id)) a.cat = cat;
    } else return jsonRes({ error: "invalid" }, 400);
    await kvSetJSON(env, "alerts", data);
    return jsonRes({ ok: true });
  }

  // Structured watchlist & scenario, each with its own categories (like alerts).
  if (p === "/api/watchlist" || p.startsWith("/api/watchlist/") || p === "/api/wcats" || p.startsWith("/api/wcats/"))
    return handleListApi(request, env, { key: "watchlist", base: "watchlist", ckey: "wcats", cbase: "wcats", kind: "w" });
  if (p === "/api/scenario" || p.startsWith("/api/scenario/") || p === "/api/scats" || p.startsWith("/api/scats/"))
    return handleListApi(request, env, { key: "scenario", base: "scenario", ckey: "scats", cbase: "scats", kind: "s" });
  // Free-text notes with their own categories (same shape as scenario): positions, strategies, trade tasks.
  if (p === "/api/positions" || p.startsWith("/api/positions/") || p === "/api/pcats" || p.startsWith("/api/pcats/"))
    return handleListApi(request, env, { key: "positions", base: "positions", ckey: "pcats", cbase: "pcats", kind: "p" });
  if (p === "/api/strategies" || p.startsWith("/api/strategies/") || p === "/api/gcats" || p.startsWith("/api/gcats/"))
    return handleListApi(request, env, { key: "strategies", base: "strategies", ckey: "gcats", cbase: "gcats", kind: "g" });
  if (p === "/api/tasks" || p.startsWith("/api/tasks/") || p === "/api/kcats" || p.startsWith("/api/kcats/"))
    return handleListApi(request, env, { key: "tasks", base: "tasks", ckey: "kcats", cbase: "kcats", kind: "k" });
  return jsonRes({ error: "not found" }, 404);
}


const APP_HTML = String.raw`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark light">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="آلارم"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0c12" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f1f2fa" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b5cf6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 20h18'/%3E%3Cpath d='M6 16V8'/%3E%3Crect x='4.5' y='10' width='3' height='4' rx='.5'/%3E%3Cpath d='M12 14V4'/%3E%3Crect x='10.5' y='6' width='3' height='6' rx='.5'/%3E%3Cpath d='M18 18V9'/%3E%3Crect x='16.5' y='11' width='3' height='5' rx='.5'/%3E%3C/svg%3E">
<title>پنل آلارم</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/vazirmatn@33.0.3/Vazirmatn-font-face.css" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/vazirmatn@33.0.3/Vazirmatn-font-face.css"></noscript>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5/index.css" media="print" onload="this.media='all'">
<style>
/* Chart-paper design: ruled grid, flat surfaces, ultramarine ink. The price ruler (.trk) is the signature element. */
:root{
  --sans:Vazirmatn,"Segoe UI",Tahoma,system-ui,-apple-system,sans-serif;
  --mono:"JetBrains Mono Variable",ui-monospace,Menlo,Consolas,monospace;
  color-scheme:dark;
  --bg:#080d1b;--card:#0e1630;--card2:#131d3a;--line:#1d2849;--line2:#2c3a62;
  --tx:#e8edfb;--tx2:#bcc6e0;--mut:#8190b0;
  --acc:#8da2ff;--acc2:#4a63f5;--onacc:#fff;
  --long:#35d6a1;--short:#ff7085;--amb:#f5b94a;--cyan:#5cc8e8;
  --longS:#35d6a11c;--shortS:#ff70851c;--ambS:#f5b94a1c;--accS:#4a63f52b;--cyanS:#5cc8e81c;
  --chip:#ffffff0a;--sheet:#0e1630;--sheetline:#2c3a62;
  --ring:#4a63f566;--shadow:0 20px 44px -20px #000000b0;--shadowS:none;
  --grid:#8da2ff0f;--gridM:#8da2ff1a;
  --grad:var(--acc2);
  --r:10px;--rS:8px;
}
html[data-theme=light]{
  color-scheme:light;
  --bg:#eceff5;--card:#fbfcfe;--card2:#f1f4f9;--line:#d8deea;--line2:#c0cadb;
  --tx:#0e1a33;--tx2:#34435f;--mut:#63708a;
  --acc:#2540e8;--acc2:#2540e8;--onacc:#fff;
  --long:#08875a;--short:#cf2f48;--amb:#b97508;--cyan:#0e7490;
  --longS:#08875a17;--shortS:#cf2f4815;--ambS:#b9750817;--accS:#2540e813;--cyanS:#0e749016;
  --chip:#0e1a3309;--sheet:#fbfcfe;--sheetline:#d8deea;
  --ring:#2540e82e;--shadow:0 20px 44px -22px #0e1a3340;--shadowS:none;
  --grid:#0e1a3309;--gridM:#0e1a3312;
}
*{box-sizing:border-box;margin:0;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
*{scrollbar-width:none;-ms-overflow-style:none}
*::-webkit-scrollbar{display:none;width:0;height:0}
::selection{background:color-mix(in srgb,var(--acc2) 30%,transparent)}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
body{background:var(--bg);color:var(--tx);font:15px/1.8 var(--sans);min-height:100vh;padding-bottom:116px;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
.bgfx{position:fixed;inset:0;z-index:-1;pointer-events:none;
  background-image:linear-gradient(var(--gridM) 1px,transparent 1px),linear-gradient(90deg,var(--gridM) 1px,transparent 1px),
    linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:120px 120px,120px 120px,24px 24px,24px 24px;background-position:-1px -1px}
.w{max-width:680px;margin:0 auto;padding:0 16px;position:relative}
@media(pointer:coarse){input,textarea{font-size:16px}}
.top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:10px;
  margin:0 -16px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;
  background:color-mix(in srgb,var(--bg) 96%,transparent);border-bottom:1px solid var(--line)}
.lg{display:flex;align-items:center;gap:11px;flex:1;min-width:0}
.lg>i{flex:none;width:36px;height:36px;border-radius:9px;display:grid;place-items:center;color:#fff;background:var(--acc2)}
.lg>i svg{display:block}
.tt{min-width:0}
.top h1{font-size:16px;font-weight:700;line-height:1.45;letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top .st{font-size:11.5px;line-height:1.5;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.top .st b{font-family:var(--mono);font-size:10.5px;opacity:.85}
.ib{flex:none;width:36px;height:36px;border-radius:8px;border:1px solid var(--line);background:var(--card);
  color:var(--tx2);display:grid;place-items:center;cursor:pointer;padding:0;font:700 12px var(--mono);
  transition:border-color .15s,color .15s,background .15s}
.ib:hover{border-color:var(--acc);color:var(--acc)}
.ib:active{background:var(--chip)}
.ib svg{width:17px;height:17px}
.ib.warn{position:relative}
.ib.warn:after{content:"";position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--short);border:2px solid var(--card)}
#tbtn .sun,#tbtn .moon,#tbtn .mon{display:none}
html[data-tmode=light] #tbtn .sun{display:block}
html[data-tmode=dark] #tbtn .moon{display:block}
html[data-tmode=system] #tbtn .mon{display:block}
.side{display:contents}
.tb{display:flex;gap:0;margin:6px -16px 14px;padding:0 10px;border-bottom:1px solid var(--line);overflow-x:auto}
.tb button{flex:1 0 auto;display:flex;align-items:center;justify-content:center;gap:7px;min-height:46px;padding:6px 12px;border:0;
  background:none;color:var(--mut);font:600 13px var(--sans);cursor:pointer;white-space:nowrap;position:relative;
  transition:color .15s}
.tb button svg{width:17px;height:17px;flex:none}
.tb button.on{color:var(--tx);box-shadow:inset 0 -2px 0 var(--acc)}
.tb button.on svg{color:var(--acc)}
.tb button:not(.on):hover{color:var(--tx)}
@media (max-width:520px){.tb{padding:0 4px}.tb button{flex:1 1 0;min-width:0;flex-direction:column;gap:3px;font-size:10px;line-height:1.3;min-height:54px;padding:6px 2px;white-space:normal;text-align:center}}
.sbox{flex:none;width:20px;height:20px;border-radius:5px;border:1.5px solid var(--line2);color:transparent;
  font:800 12px/1 var(--sans);display:none;place-items:center;user-select:none;transition:background .15s,border-color .15s,color .15s}
body.selmode .sbox{display:grid}
.card.sel .sbox{background:var(--acc2);border-color:var(--acc2);color:#fff}
body.selmode .card{cursor:pointer}
#selbtn.on{color:var(--acc);border-color:var(--acc);background:var(--accS)}
#selbar{position:fixed;z-index:26;left:50%;transform:translateX(-50%);bottom:calc(20px + env(safe-area-inset-bottom));
  display:flex;align-items:center;gap:2px;background:var(--card);border:1px solid var(--line2);border-radius:12px;
  padding:5px 8px;box-shadow:var(--shadow);max-width:calc(100vw - 24px)}
#selbar b{font:700 12.5px var(--mono);color:var(--acc);min-width:30px;text-align:center;direction:ltr;flex:none}
#selbar .lk{padding:8px 9px;font-size:12.5px;flex:none}
#selbar .lk.bad{color:var(--short)}
.sTitle{font-weight:700;font-size:14.5px}
.wnote{padding:10px 15px 12px;font-size:13px;color:var(--tx2);border-top:1px solid var(--line);white-space:pre-wrap;word-break:break-word;line-height:1.9}
.stext{padding:11px 15px 13px;font-size:13.5px;line-height:2;color:var(--tx2);white-space:pre-wrap;word-break:break-word;
  border-top:1px solid var(--line);max-height:320px;overflow:auto}
.sst{margin:6px 0 10px}
.stn{font-size:12.5px;color:var(--mut);line-height:1.9;margin:4px 0 6px}.stn div{padding:3px 0;border-top:1px solid var(--line)}.stn .bad{color:var(--short)}.stn .ok{color:var(--long)}
.sp{display:none}.sp.on{display:block}
.sg{border-bottom:1px solid var(--line);padding:0 0 12px;margin:0 0 12px}
.sp .sg:last-of-type{border-bottom:0;margin-bottom:6px}
.sgh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;font-size:13.5px}
.sgh .st{margin:0;font-size:12px}
.sg input{margin-top:6px}.sg input:first-of-type{margin-top:0}
.row2{display:flex;gap:6px}.row2 .lk{flex:1}
.sec{background:var(--card2);border:1px solid var(--line);border-radius:var(--r);padding:4px 14px 14px;margin:12px 0}
.sech{font-size:13.5px;font-weight:700;color:var(--tx);margin:12px 0 2px}
.sec .st,.sec label{margin-inline:2px}
@keyframes fadein{from{opacity:0}}
@keyframes fadeout{to{opacity:0}}
@keyframes popout{to{opacity:0;transform:translateY(10px)}}
.sh.on{animation:fadein .16s ease-out}
.sh.on.bye{animation:fadeout .14s ease-in forwards}
.sh.on.bye .pn{animation:popout .14s ease-in forwards}
.px.pchg{animation:pchg .8s}
@keyframes pchg{0%{color:var(--acc);background:var(--accS)}}
html.theming,html.theming *{transition:background-color .25s ease,color .25s ease,border-color .25s ease!important}
#fstx{min-height:230px}
.mk{display:flex;gap:6px;overflow-x:auto;margin:0 0 14px;padding:0}
.mk:empty{display:none}
.mk h3{display:none}
.mr{flex:none;display:flex;gap:9px;align-items:center;padding:6px 11px;background:var(--card);border:1px solid var(--line);
  border-radius:8px;font:600 12px var(--mono);direction:ltr;font-variant-numeric:tabular-nums}
.mr b{color:var(--tx2);font-weight:700;position:relative;padding-left:12px}
.mr b:before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:5px;height:5px;border-radius:1px;background:var(--long)}
.fbar{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:10px;margin:0 0 14px;display:flex;flex-direction:column;gap:9px}
.frow{display:flex;gap:8px}
.fbar .srch{flex:1;min-width:0;min-height:42px;background:var(--card2);border:1px solid var(--line);border-radius:var(--rS);
  padding:9px 13px;font:500 14px var(--sans);color:var(--tx);outline:0;transition:border-color .15s,box-shadow .15s}
.fbar .srch::placeholder{color:var(--mut);opacity:.8}
.fbar .srch:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}
.fcl{flex:none;width:42px;min-height:42px;background:var(--card2);border:1px solid var(--line);border-radius:var(--rS);
  color:var(--mut);cursor:pointer;font-size:14px;padding:0;transition:color .15s,border-color .15s}
.fcl:hover{color:var(--short);border-color:var(--short)}
.fchips{display:flex;gap:6px;overflow-x:auto;padding-bottom:1px}
.fc{flex:none;display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:6px 12px;border-radius:7px;
  border:1px solid var(--line);background:var(--card2);color:var(--tx2);font:600 12.5px var(--sans);cursor:pointer;
  white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.fc:hover{border-color:var(--line2);color:var(--tx)}
.fc .dot{width:8px;height:8px;border-radius:2px;flex:none}
.fc b{font:600 10.5px var(--mono);opacity:.6}
.fc.on{color:var(--acc);border-color:var(--acc);background:var(--accS)}
#fchips .mgrb{border-style:dashed;color:var(--mut)}
.fsegs{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.seg{display:flex;gap:2px;background:var(--card2);border:1px solid var(--line);border-radius:var(--rS);padding:2px}
.seg button{flex:1;min-height:36px;border:0;border-radius:6px;background:none;color:var(--mut);
  font:600 12.5px var(--sans);cursor:pointer;padding:4px 2px;transition:color .15s,background .15s;white-space:nowrap}
.seg button:hover{color:var(--tx2)}
.seg button.on{color:var(--acc);background:var(--accS)}
.seg button.on[data-s=act]{color:var(--amb);background:var(--ambS)}
.seg button.on[data-s=done]{color:var(--long);background:var(--longS)}
.seg button.on[data-d=long]{color:var(--long);background:var(--longS)}
.seg button.on[data-d=short]{color:var(--short);background:var(--shortS)}
@media(max-width:430px){.fsegs{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);margin-bottom:10px;position:relative;
  overflow:hidden;transition:border-color .15s;content-visibility:auto;contain-intrinsic-size:auto 118px}
.card.long{border-inline-start:3px solid var(--long)}
.card.short{border-inline-start:3px solid var(--short)}
.card.neu{border-inline-start:3px solid var(--line2)}
.card:hover{border-color:var(--line2)}
.hd{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--line);min-width:0}
.av{flex:none;width:34px;height:34px;border-radius:7px;display:grid;place-items:center;font:700 11px var(--mono);
  color:var(--tx2);background:var(--card2);border:1px solid var(--line2)}
.card.long .av{color:var(--long);border-color:color-mix(in srgb,var(--long) 50%,transparent)}
.card.short .av{color:var(--short);border-color:color-mix(in srgb,var(--short) 50%,transparent)}
.idn{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.coin{font:700 15.5px var(--mono);letter-spacing:.3px;direction:ltr}
.pill{font:700 9.5px var(--mono);padding:2px 7px;border-radius:4px;letter-spacing:.6px;direction:ltr;border:1px solid var(--line2);color:var(--mut)}
.card.long .pill{color:var(--long);background:var(--longS);border-color:transparent}
.card.short .pill{color:var(--short);background:var(--shortS);border-color:transparent}
.card.neu .pill{color:var(--mut);background:var(--chip)}
.catpill{font:600 10.5px var(--sans);padding:2px 8px;border-radius:4px;border:1px solid;white-space:nowrap;
  background:color-mix(in srgb,currentColor 12%,transparent)}
.pxw{margin-inline-start:auto;direction:ltr;display:flex;flex-direction:column;align-items:flex-end;line-height:1.35;flex:none}
.pxw .px{margin:0;font:700 16px var(--mono);font-variant-numeric:tabular-nums;border-radius:4px;padding:0 3px}
.dist{font:600 10.5px var(--sans);color:var(--mut)}
.x{flex:none;width:32px;height:32px;border-radius:7px;background:none;border:1px solid transparent;color:var(--mut);
  cursor:pointer;display:grid;place-items:center;font-size:13.5px;padding:0;transition:color .15s,border-color .15s,background .15s}
.x:hover{color:var(--tx);border-color:var(--line);background:var(--chip)}
.x.ed:hover{color:var(--acc);border-color:var(--acc)}
.dh{flex:none;cursor:grab;user-select:none;-webkit-user-select:none;color:var(--mut);opacity:.55;font-size:15px;
  padding:4px 1px;touch-action:none;line-height:1}
.dh:hover{opacity:1}
.card.drag{box-shadow:var(--shadow);border-color:var(--acc)!important}
.ph{border:1.5px dashed var(--acc);border-radius:var(--r);margin-bottom:10px;opacity:.45;background:var(--accS)}
.prog{height:2px;background:var(--chip)}
.prog i{display:block;height:100%;background:var(--acc2);transition:width .5s}
/* price ruler: ticks every 10%, targets are vertical flags, the needle is the live price */
.trk{position:relative;height:34px;margin:14px 16px 6px;direction:ltr}
.trk:before{content:"";position:absolute;left:0;right:0;top:16px;height:1px;background:var(--line2)}
.trk:after{content:"";position:absolute;left:0;right:0;top:17px;height:6px;
  background:repeating-linear-gradient(90deg,var(--line2) 0 1px,transparent 1px 10%);border-right:1px solid var(--line2)}
.tk{position:absolute;top:5px;width:2px;height:24px;margin-left:-1px;border-radius:1px;background:var(--mut)}
.tk.tp{background:var(--long)}
.tk.sl{background:var(--short)}
.tk.n{background:var(--amb)}
.tk.hit{opacity:.3}
.tk.en{top:12px;width:9px;height:9px;margin-left:-4.5px;border-radius:1px;transform:rotate(45deg);background:var(--card);
  border:2px solid var(--tx2)}
.now{position:absolute;top:1px;width:3px;height:32px;margin-left:-1.5px;border-radius:2px;background:var(--acc);
  transition:left .9s cubic-bezier(.22,1,.36,1);z-index:2}
.now:before{content:"";position:absolute;top:-3px;left:50%;width:9px;height:9px;margin-left:-4.5px;border-radius:50%;background:var(--acc);border:2px solid var(--card)}
.why{padding:0 15px;font:500 11px/1.7 var(--sans);color:var(--short);direction:ltr;text-align:left;word-break:break-all}
.why:empty{display:none}
.row{display:flex;align-items:center;gap:9px;padding:9px 15px;border-top:1px solid var(--line);font-size:13px;
  cursor:pointer;transition:background .15s;min-height:42px}
.row:hover{background:var(--chip)}
.tag{font:700 10px var(--sans);padding:2px 7px;border-radius:4px;background:var(--chip);color:var(--amb);flex:none;min-width:32px;text-align:center}
.row.tp .tag{color:var(--long);background:var(--longS)}
.row.sl .tag{color:var(--short);background:var(--shortS)}
.row.en .tag{color:var(--acc);background:var(--accS)}
.pr{font:700 13px var(--mono);direction:ltr;flex:none;font-variant-numeric:tabular-nums}
.nt{color:var(--mut);flex:1;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row.hit{opacity:.45}
.row.hit .pr{text-decoration:line-through}
.ok{color:var(--long);font-weight:700}
.card.done{opacity:.55}
.card.done .coin,.card.done .px,.card.done .pill,.card.done .pr,.card.done .nt,.card.done .tag{text-decoration:line-through}
.msg{grid-column:1/-1;text-align:center;color:var(--mut);padding:48px 14px;font-size:14px;line-height:2.1;
  border:1px dashed var(--line2);border-radius:var(--r);margin-bottom:10px}
.fab{direction:ltr;position:fixed;z-index:25;left:50%;transform:translateX(-50%);
  bottom:calc(18px + env(safe-area-inset-bottom));background:var(--acc2);color:var(--onacc);border:0;
  font:700 14.5px var(--sans);padding:14px 26px;border-radius:12px;cursor:pointer;
  box-shadow:0 10px 26px -10px color-mix(in srgb,var(--acc2) 80%,#000);transition:transform .12s,filter .15s}
.fab:hover{filter:brightness(1.08)}
.fab:active{transform:translateX(-50%) scale(.96)}
.sh{position:fixed;inset:0;background:#05091ab0;display:none;align-items:center;justify-content:center;z-index:40;padding:16px}
html[data-theme=light] .sh{background:#0e1a3340}
.sh.on{display:flex}
.pn{background:var(--sheet);border:1px solid var(--sheetline);border-radius:16px;width:100%;max-width:560px;
  max-height:min(88vh,680px);max-height:min(88dvh,680px);overflow:auto;padding:20px 18px calc(20px + env(safe-area-inset-bottom));
  box-shadow:var(--shadow);overscroll-behavior:contain}
.sh.on .pn{animation:pop .2s cubic-bezier(.2,.9,.3,1)}
@media (max-width:600px){
  .sh{align-items:flex-end;padding:0}
  .pn{max-width:none;border-radius:16px 16px 0 0;max-height:92dvh;padding-top:26px;position:relative}
  .pn::before{content:"";position:absolute;top:9px;left:50%;width:36px;height:4px;margin-left:-18px;border-radius:4px;background:var(--line2)}
  .sh.on .pn{animation:sheetup .24s cubic-bezier(.2,.9,.3,1)}
  #lg{align-items:center;padding:16px}#lg .pn{border-radius:16px;max-width:400px;padding-top:20px}#lg .pn::before{display:none}
}
@keyframes sheetup{from{transform:translateY(40px);opacity:0}}
#lg{z-index:60}
#lg .pn{max-width:400px}
.pnh{font-size:16px;font-weight:700;margin:0 0 6px;color:var(--tx);line-height:1.6}
label{display:block;font-size:12.5px;font-weight:600;color:var(--mut);margin:13px 0 6px;line-height:1.7}
input,textarea{width:100%;background:var(--card2);border:1px solid var(--line);color:var(--tx);border-radius:var(--rS);
  padding:10px 12px;font:500 15px var(--sans);outline:0;transition:border-color .15s,box-shadow .15s;min-height:44px;caret-color:var(--acc)}
input::placeholder,textarea::placeholder{color:var(--mut);opacity:.7}
input:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--ring)}
input[type=checkbox]{width:18px;height:18px;min-height:0;padding:0;accent-color:var(--acc2);flex:none}
.tp{font-family:var(--mono);font-variant-numeric:tabular-nums}
textarea{min-height:230px;border-radius:var(--rS);padding:13px;font:500 15px/2 var(--sans);resize:vertical}
.go{width:100%;margin-top:14px;min-height:48px;background:var(--acc2);color:var(--onacc);border:0;border-radius:var(--rS);
  padding:12px;font:700 15px var(--sans);cursor:pointer;transition:transform .1s,filter .15s,opacity .15s}
.go:hover{filter:brightness(1.08)}
.go:active{transform:scale(.985)}
.go:disabled{opacity:.55;cursor:default}
.lk{background:none;border:0;color:var(--acc);font:600 13.5px var(--sans);padding:8px 6px;cursor:pointer;transition:opacity .15s}
.lk:hover{opacity:.75}
.st{font-size:12px;color:var(--mut);line-height:1.85}
.st.ok{color:var(--long)}
.st.bad{color:var(--short);font-weight:700}
.ckr{display:flex;gap:8px}
.ck{display:flex;align-items:center;gap:9px;margin:0;padding:10px 12px;min-height:46px;background:var(--card2);
  border:1px solid var(--line);border-radius:var(--rS);font-size:13.5px;font-weight:600;color:var(--tx2);flex:1;
  cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.ck:hover{border-color:var(--line2)}
.ck:has(input:checked){border-color:var(--acc);background:var(--accS);color:var(--tx)}
.chipsel{display:flex;gap:7px;flex-wrap:wrap;max-height:132px;overflow-y:auto;padding:2px}
.chipsel .fc{padding:7px 12px}
.tr{display:flex;gap:7px;margin-bottom:7px}
.tr input:first-child{flex:0 0 40%;direction:ltr}
.cerr{color:var(--short);font-size:12px;text-align:center;min-height:18px;margin-bottom:6px;font-weight:600;line-height:1.7}
.crow{display:flex;align-items:center;gap:9px;padding:10px 0;border-top:1px solid var(--line)}
.crow:first-child{border-top:0}
.cdot{flex:none;width:26px;height:26px;border-radius:6px;border:0;cursor:pointer;padding:0;transition:transform .15s}
.cdot:hover{transform:scale(1.12)}
.crow input{flex:1;min-width:0;min-height:40px;font-size:14px}
.cdel{flex:none;width:38px;min-height:38px;background:none;border:1px solid var(--line);border-radius:var(--rS);
  color:var(--mut);cursor:pointer;font-size:14px;padding:0;transition:color .15s,border-color .15s}
.cdel:hover{color:var(--short);border-color:var(--short)}
.sw{display:flex;gap:9px;flex-wrap:wrap;margin:12px 0 2px}
.sw button{width:28px;height:28px;border-radius:7px;border:2px solid transparent;cursor:pointer;padding:0;transition:transform .15s}
.sw button:hover{transform:scale(1.1)}
.sw button.on{border-color:var(--tx)}
.mgradd{display:flex;gap:8px;margin-top:13px}
.mgradd input{flex:1;min-width:0}
.mgradd .go{width:auto;margin:0;min-height:44px;padding:10px 22px;font-size:13.5px}
/* position planner (calculator) */
#p-c{max-width:640px;margin-inline:auto}
.rd{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.rdh{padding:16px 16px 12px;display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line)}
.rdl{font-size:12.5px;font-weight:600;color:var(--mut);line-height:1.5}
.rdl small{display:block;font-size:11px;font-weight:500;opacity:.8}
.rdv{font:700 34px/1.1 var(--mono);direction:ltr;font-variant-numeric:tabular-nums;letter-spacing:-1px;color:var(--tx)}
.rdv.on{color:var(--acc)}
.sts{display:grid;grid-template-columns:repeat(4,1fr)}
.stt{padding:11px 10px;border-inline-start:1px solid var(--line);min-width:0}
.stt:first-child{border-inline-start:0}
.stt span{display:block;font-size:11px;color:var(--mut);font-weight:600;line-height:1.5}
.stt b{display:block;font:700 14px var(--mono);direction:ltr;text-align:start;font-variant-numeric:tabular-nums;margin-top:2px;overflow:hidden;text-overflow:ellipsis}
.stt b.good{color:var(--long)}.stt b.bad{color:var(--short)}
@media(max-width:430px){.sts{grid-template-columns:repeat(2,1fr)}.stt:nth-child(3){border-inline-start:0}.stt:nth-child(n+3){border-top:1px solid var(--line)}}
.lad{position:relative;height:74px;margin:6px 22px 4px;direction:ltr}
.lad:before{content:"";position:absolute;left:0;right:0;top:36px;height:2px;border-radius:1px;background:var(--line2)}
.lad .seg2{position:absolute;top:35px;height:4px;border-radius:2px}
.lad .mk2{position:absolute;top:0;width:0;height:74px;display:flex;flex-direction:column;align-items:center}
.lad .mk2 i{display:block;width:2px;height:20px;background:currentColor;margin-top:20px;border-radius:1px}
.lad .mk2 em{position:absolute;white-space:nowrap;font:700 10.5px var(--mono);font-style:normal;transform:translateX(-50%);left:0}
.lad .mk2 em.t{top:0}.lad .mk2 em.b{top:56px}
.lad .mk2.sl{color:var(--short)}.lad .mk2.en{color:var(--tx2)}.lad .mk2.tp{color:var(--long)}.lad .mk2.lq{color:var(--amb)}
.lad .mk2.lq i{height:12px;margin-top:26px;border-radius:0;background:repeating-linear-gradient(var(--amb) 0 3px,transparent 3px 5px)}
.ladn{padding:2px 16px 12px;font-size:12px;color:var(--mut);line-height:1.8}
.cerr{margin-top:8px}
.ds{display:flex;flex-wrap:wrap;gap:2px 18px;padding:2px 16px 14px;font-size:12px;color:var(--mut)}
.ds b{color:var(--tx);font-family:var(--mono);font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:isolate}
.fs{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:2px 14px 14px}
.fs h4{font-size:13px;font-weight:700;color:var(--tx);margin:12px 0 0}
.cg{display:grid;grid-template-columns:1fr 1fr;gap:0 10px;align-items:end}
.cg3{grid-template-columns:1fr 1fr 1fr}
.cg input{direction:ltr}
.bd{margin-top:12px;padding:11px 13px;border:1px solid var(--line);border-radius:var(--rS);font:600 11.5px/2 var(--sans);
  color:var(--mut);direction:ltr;text-align:left;background:var(--card2)}
.bd:empty{display:none}
.lgt{font:700 17px var(--sans);margin-bottom:4px;color:var(--tx)}
#aleg{margin:2px 0 6px}
[hidden]{display:none!important}
@keyframes pop{from{opacity:0;transform:translateY(10px)}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}

/* ===== app feel ===== */
html{-webkit-tap-highlight-color:transparent;overscroll-behavior-y:none;scroll-padding-top:70px}
button,.tb,.top,.fab,.seg,.ib{-webkit-user-select:none;user-select:none;touch-action:manipulation}
main>section:not([hidden]){animation:tabin .18s ease-out}
@keyframes tabin{from{opacity:0;transform:translateY(6px)}}
@media(max-width:919px){
  body{padding-bottom:calc(170px + env(safe-area-inset-bottom))}
  .tb{position:fixed;z-index:35;left:0;right:0;bottom:0;margin:0;padding:0 6px env(safe-area-inset-bottom);
    background:color-mix(in srgb,var(--card) 97%,transparent);border-top:1px solid var(--line);border-bottom:0;
    box-shadow:0 -8px 24px -16px #0007}
  .tb button{min-height:56px;border-radius:0}
  .tb button.on,html[dir=ltr] .tb button.on{box-shadow:inset 0 2px 0 var(--acc);background:none}
  .fab{bottom:calc(72px + env(safe-area-inset-bottom))}
  #selbar{bottom:calc(76px + env(safe-area-inset-bottom))}
  .sh{z-index:50}
}
@media(display-mode:standalone){.top{padding-top:calc(12px + env(safe-area-inset-top))}}
@media(min-width:920px){
  body{padding-bottom:48px}
  .w{max-width:1240px;display:grid;grid-template-columns:230px minmax(0,1fr);
    grid-template-areas:"top top" "side main";grid-template-rows:auto minmax(0,1fr);column-gap:28px;padding:0 26px}
  .top{grid-area:top;margin:0 -26px 6px;padding:calc(14px + env(safe-area-inset-top)) 26px 12px}
  .side{grid-area:side;align-self:start;position:sticky;top:88px;display:flex;flex-direction:column;gap:14px;margin-top:16px}
  .tb{flex-direction:column;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--r);background:var(--card);overflow:hidden}
  .tb button{justify-content:flex-start;min-height:44px;padding:10px 14px;font-size:13.5px;border-bottom:1px solid var(--line);flex:none}
  .tb button:last-child{border-bottom:0}
  .tb button.on{box-shadow:inset -3px 0 0 var(--acc);background:var(--accS)}
  .mk{display:block;overflow:visible;margin:0;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--r)}
  .mk h3{display:block;font-size:11.5px;font-weight:700;color:var(--mut);margin-bottom:8px}
  .mr{justify-content:space-between;width:100%;border:0;background:none;border-top:1px solid var(--line);border-radius:0;padding:9px 2px}
  #p-a,#p-s,#p-w,#p-p,#p-g,#p-k,#p-c{grid-area:main;min-width:0;margin-top:16px}
  #p-c{margin-inline:auto;max-width:600px;width:100%}
  #list,#slist,#wlist,#plist,#glist,#klist{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;align-items:start}
  #list .card,#list .msg,#slist .card,#wlist .card,#slist .msg,#wlist .msg{margin:0}
  .ph{margin:0}
  #selbar{left:auto;right:max(26px,calc(50% - 620px + 26px));transform:none;bottom:92px}
  #selbar .lk{padding:8px 12px}
  .fab{left:auto;right:max(26px,calc(50% - 620px + 26px));transform:none;bottom:26px}
  .fab:active{transform:scale(.96)}
  #fstx{min-height:260px}
}
html[dir=ltr] .dh{padding:4px 2px 4px 0}
html[dir=ltr] .mr b{padding-left:0;padding-right:12px}
html[dir=ltr] .mr b:before{left:auto;right:0}
html[dir=ltr] .tb button.on{box-shadow:inset 0 -2px 0 var(--acc)}
@media(min-width:920px){html[dir=ltr] .tb button.on{box-shadow:inset 3px 0 0 var(--acc)}}
</style></head><body>
<div class="bgfx" aria-hidden="true"></div>
<div class="w">
<header class="top">
<div class="lg"><i aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M6 16V8"/><rect x="4.5" y="10" width="3" height="4" rx=".5"/><path d="M12 14V4"/><rect x="10.5" y="6" width="3" height="6" rx=".5"/><path d="M18 18V9"/><rect x="16.5" y="11" width="3" height="5" rx=".5"/></svg></i><div class="tt"><h1>پنل آلارم</h1></div></div>
<button class="ib" id="tbtn" aria-label="تغییر تم"><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg><svg class="mon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg></button>
<button class="ib" id="lang" aria-label="Language">EN</button>
<button class="ib" id="gear" aria-label="تنظیمات"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
</header>
<div class="side">
<nav class="tb" aria-label="بخش‌ها">
<button data-t="a" class="on"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span>آلارم‌ها</span></button>
<button data-t="s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/></svg><span>سناریو</span></button>
<button data-t="p"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg><span>پوزیشن‌ها</span></button>
<button data-t="g"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/></svg><span>استراتژی</span></button>
<button data-t="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>ترید تسک</span></button>
<button data-t="w"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg><span>واچ‌ لیست</span></button>
<button data-t="c"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg><span>ماشین‌ حساب</span></button>
</nav>
<div class="mk" id="mk"></div>
</div>
<main>
<section id="p-a">
<div class="fbar">
<div class="frow"><input class="srch" id="fq" placeholder="🔍 جستجوی کوین…" autocomplete="off"><button class="fcl" id="selbtn" title="انتخاب چند آلارم">☑</button><button class="fcl" id="fclr" title="پاک کردن فیلترها">✕</button></div>
<div class="fchips" id="fchips"></div>
<div class="fsegs">
<div class="seg" id="fst"><button data-s="all" class="on">همه</button><button data-s="act">فعال</button><button data-s="done">تمام‌شده</button></div>
<div class="seg" id="fdr"><button data-d="all" class="on">همه</button><button data-d="long">Long</button><button data-d="short">Short</button><button data-d="none">بدون جهت</button></div>
</div>
</div>
<div id="list"><div class="msg">در حال بارگذاری…</div></div>
</section>
<section id="p-s" hidden>
<div class="fbar">
<div class="frow"><input class="srch" id="sq" placeholder="🔍 جستجو…" autocomplete="off"><button class="fcl" id="sclr" title="پاک کردن فیلترها">✕</button></div>
<div class="fchips" id="schips"></div>
</div>
<div id="slist"><div class="msg">در حال بارگذاری…</div></div>
</section>
<section id="p-p" hidden>
<div class="fbar">
<div class="frow"><input class="srch" id="pq" placeholder="🔍 جستجو…" autocomplete="off"><button class="fcl" id="pclr" title="پاک کردن فیلترها">✕</button></div>
<div class="fchips" id="pchips"></div>
</div>
<div id="plist"><div class="msg">در حال بارگذاری…</div></div>
</section>
<section id="p-g" hidden>
<div class="fbar">
<div class="frow"><input class="srch" id="gq" placeholder="🔍 جستجو…" autocomplete="off"><button class="fcl" id="gclr" title="پاک کردن فیلترها">✕</button></div>
<div class="fchips" id="gchips"></div>
</div>
<div id="glist"><div class="msg">در حال بارگذاری…</div></div>
</section>
<section id="p-k" hidden>
<div class="fbar">
<div class="frow"><input class="srch" id="kq" placeholder="🔍 جستجو…" autocomplete="off"><button class="fcl" id="kclr" title="پاک کردن فیلترها">✕</button></div>
<div class="fchips" id="kchips"></div>
</div>
<div id="klist"><div class="msg">در حال بارگذاری…</div></div>
</section>
<section id="p-w" hidden>
<div class="fbar">
<div class="frow"><input class="srch" id="wq" placeholder="🔍 جستجو…" autocomplete="off"><button class="fcl" id="wclr" title="پاک کردن فیلترها">✕</button></div>
<div class="fchips" id="wchips"></div>
</div>
<div id="wlist"><div class="msg">در حال بارگذاری…</div></div>
</section>
<section id="p-c" hidden>
<div class="rd">
<div class="rdh"><div class="rdl">مارجین لازم<small>سرمایه‌ای که باید وارد پوزیشن کنی</small></div><div class="rdv" id="c-val">—</div></div>
<div class="sts">
<div class="stt"><span>حجم پوزیشن</span><b id="c-not">—</b></div>
<div class="stt"><span>تعداد</span><b id="c-qty">—</b></div>
<div class="stt"><span>ریسک</span><b id="c-rsk">—</b></div>
<div class="stt"><span>نسبت سود به ضرر</span><b id="c-rr">—</b></div>
</div>
<div class="lad" id="c-lad"></div>
<div class="ds"><span>جهت: <b id="c-dir">—</b></span><span>فاصله حد ضرر: <b id="c-sl">—</b></span><span>فاصله حد سود: <b id="c-tpd">—</b></span><span>قیمت لیکویید (تقریبی): <b id="c-liq">—</b></span></div>
</div>
<div class="cerr" id="c-msg"></div>
<div class="fs"><h4>حساب</h4><div class="cg cg3">
<div><label>سرمایه حساب (USD)</label><input class="tp" id="c-cap" inputmode="decimal"></div>
<div><label>درصد ریسک (%)</label><input id="c-risk" inputmode="decimal"></div>
<div><label>لوریج (x)</label><input id="c-lev" inputmode="decimal"></div>
</div></div>
<div class="fs"><h4>معامله</h4><div class="cg cg3">
<div><label>قیمت ورود ($)</label><input class="tp" id="c-en" inputmode="decimal"></div>
<div><label>قیمت حد ضرر ($)</label><input class="tp" id="c-st" inputmode="decimal"></div>
<div><label>حد سود ($) — اختیاری</label><input class="tp" id="c-tp" inputmode="decimal"></div>
</div></div>
<div class="fs"><h4>کارمزد (اختیاری)</h4><div class="cg">
<div><label>کارمزد ورود (%)</label><input id="c-fo" inputmode="decimal"></div>
<div><label>کارمزد خروج (%)</label><input id="c-fc" inputmode="decimal"></div>
</div></div>
<div class="bd" id="c-bd"></div>
</section>
</main>
</div>
<button class="fab" id="fab">＋ آلارم جدید</button>
<div class="sh" id="sh" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh">ثبت آلارم</div>
<label style="margin-top:0">کوین</label><input id="coin" placeholder="BTC" autocapitalize="characters" autocomplete="off">
<label>جهت (اختیاری)</label><div class="seg" id="seg"><button data-d="" class="on">بدون جهت</button><button data-d="long">Long</button><button data-d="short">Short</button></div>
<label>دسته‌بندی</label><div class="chipsel" id="catsel"></div>
<label>قیمت ورود (اختیاری — خالی = نمایش داده نمی‌شود)</label><input class="tp" id="entry" inputmode="decimal" placeholder="مثلاً 0.2462">
<label>اعلان از طریق</label>
<div class="ckr"><label class="ck"><input type="checkbox" id="c-tg" checked> 📨 تلگرام</label><label class="ck"><input type="checkbox" id="c-em"> ✉️ ایمیل</label></div><div class="st" id="c-emh" style="margin:4px 0 0"></div>
<label>اهداف (TP / SL)</label><div id="trs"></div>
<button class="lk" id="addT">＋ هدف دیگر</button>
<button class="go" id="go">ثبت آلارم</button><button class="lk" id="cancel" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div class="sh" id="fsc" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh" id="fsct">سناریوی جدید</div>
<label style="margin-top:0">عنوان</label><input id="stitle" maxlength="120" placeholder="مثلاً دیدگاه هفتگی" autocomplete="off">
<label>متن</label><textarea id="stext" placeholder="متن سناریو…"></textarea>
<label>دسته‌بندی</label><div class="chipsel" id="scatsel"></div>
<button class="go" id="sgo">ذخیره</button><button class="lk" id="fscx" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div class="sh" id="fpo" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh" id="fpot">پوزیشن جدید</div>
<label style="margin-top:0">عنوان</label><input id="ptitle" maxlength="120" placeholder="مثلاً BTC لانگ از ۶۰ هزار" autocomplete="off">
<label>متن</label><textarea id="ptext" maxlength="20000" style="min-height:190px" placeholder="متن پوزیشن، دلیل ورود، حد ضرر، نکات…"></textarea>
<label>دسته‌بندی</label><div class="chipsel" id="pcatsel"></div>
<button class="go" id="pgo">ذخیره</button><button class="lk" id="fpox" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div class="sh" id="fgo" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh" id="fgot">استراتژی جدید</div>
<label style="margin-top:0">عنوان</label><input id="gtitle" maxlength="120" placeholder="مثلاً استراتژی شکست سقف" autocomplete="off">
<label>متن</label><textarea id="gtext" maxlength="20000" style="min-height:190px" placeholder="شرایط ورود، خروج، مدیریت سرمایه، قوانین…"></textarea>
<label>دسته‌بندی</label><div class="chipsel" id="gcatsel"></div>
<button class="go" id="ggo">ذخیره</button><button class="lk" id="fgox" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div class="sh" id="fko" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh" id="fkot">تسک جدید</div>
<label style="margin-top:0">عنوان</label><input id="ktitle" maxlength="120" placeholder="مثلاً بررسی اخبار قبل از ورود" autocomplete="off">
<label>متن</label><textarea id="ktext" maxlength="20000" style="min-height:190px" placeholder="کارهایی که قبل و بعد از ترید باید انجام بدی…"></textarea>
<label>دسته‌بندی</label><div class="chipsel" id="kcatsel"></div>
<button class="go" id="kgo">ذخیره</button><button class="lk" id="fkox" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div class="sh" id="fwl" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh" id="fwlt">واچلیست جدید</div>
<label style="margin-top:0">نام واچلیست</label><input id="wcoin" maxlength="60" placeholder="واچلیست هفتگی…" autocomplete="off">
<label>یادداشت</label><textarea id="wnote" maxlength="10000" style="min-height:150px" placeholder="یادداشت (اختیاری)…"></textarea>
<label>دسته‌بندی</label><div class="chipsel" id="wcatsel"></div>
<button class="go" id="wgo">ذخیره</button><button class="lk" id="fwlx" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div id="selbar" hidden><button class="lk" id="selall">همه</button><button class="lk" id="selnone">هیچ</button><b id="seln">0</b><button class="lk" id="selcatb">📂 دسته</button><button class="lk bad" id="seldel">🗑 حذف</button><button class="lk" id="selx" style="color:var(--mut)">✕</button></div>
<div class="sh" id="ss" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh">تنظیمات</div>
<div class="seg sst" id="sst"><button data-p="n" class="on">🔔 اعلان‌ها</button><button data-p="l">📋 لاگ</button><button data-p="a">👤 حساب</button></div>
<div class="sp on" data-p="n">
<div class="sg">
<div class="sgh"><b>✉️ ایمیل</b><span id="emst" class="st"></span></div>
<input id="em" type="email" inputmode="email" dir="ltr" placeholder="you@example.com">
<div class="row2"><button class="lk" id="emreq">ارسال کد تایید</button><button class="lk" id="emrm" hidden style="color:var(--mut)">حذف ایمیل</button></div>
<div id="emcode" hidden><input id="emc" inputmode="numeric" maxlength="6" dir="ltr" placeholder="کد ۶ رقمی"><button class="lk" id="emver">تایید کد</button></div>
</div>
<div class="sg">
<div class="sgh"><b>📨 تلگرام</b><span id="tgst" class="st"></span></div>
<input id="tgt" dir="ltr" autocomplete="off" placeholder="توکن ربات از BotFather">
<div class="row2"><button class="lk" id="tgset">ثبت توکن</button><button class="lk" id="tgoff" hidden style="color:var(--mut)">قطع اتصال ربات</button></div>
<div id="tgstep" hidden><div class="st" style="margin:0 0 4px">۱) لینک زیر را بزن و در تلگرام Start را بزن ۲) برگرد و «تشخیص» را بزن</div><a id="tglink" target="_blank" rel="noopener" class="lk" style="display:block;text-decoration:none">باز کردن ربات در تلگرام ↗</a><button class="lk" id="tgdet">✓ تشخیص چت (بعد از Start)</button><div id="tgpick"></div></div>
</div>
<button class="go" id="tst">🧪 تست تلگرام و ایمیل</button>
</div>
<div class="sp" data-p="l">
<div class="sg">
<div class="st" id="st" style="margin:0 0 2px">…</div>
<div id="stn" class="stn"></div>
<button class="lk" id="logr">تازه‌سازی</button>
</div>
</div>
<div class="sp" data-p="a">
<div class="sg">
<div class="sgh"><b>👤 <span id="acu" style="color:var(--acc);font-family:var(--mono)"></span></b></div>
<div class="st bad" id="aleg" hidden style="margin:2px 0 6px">حساب تو با «نام کاربری» ساخته شده؛ یک ایمیل برایش ثبت کن.</div>
<div class="st" style="margin:0 0 6px">برای تغییر ایمیل یا رمز، اول رمز فعلی را وارد کن.</div>
<input id="ac" type="password" dir="ltr" placeholder="رمز فعلی" autocomplete="current-password">
</div>
<div class="sg">
<div class="sgh"><b>ایمیل حساب</b></div>
<input id="ae" type="email" dir="ltr" placeholder="ایمیل جدید" autocapitalize="none">
<input id="akey" dir="ltr" placeholder="کلید API سرویس ایمیل (Resend)" autocomplete="off" hidden>
<input id="acode" inputmode="numeric" maxlength="6" dir="ltr" placeholder="کد ارسال‌شده به ایمیل جدید" hidden>
<button class="lk" id="aes">ارسال کد به ایمیل جدید</button>
</div>
<div class="sg">
<div class="sgh"><b>رمز عبور</b></div>
<input id="ap" type="password" dir="ltr" placeholder="رمز جدید (حداقل ۸ کاراکتر)" autocomplete="new-password">
<button class="lk" id="acs">تغییر رمز</button>
</div>
<button class="lk" id="out" style="width:100%;color:var(--short)">خروج از حساب</button>
</div>
<button class="lk" id="ssx" style="width:100%;color:var(--mut)">بستن</button>
</div></div>
<div class="sh" id="selcat" role="dialog" aria-modal="true"><div class="pn" style="max-width:420px">
<div class="pnh">انتقال به دسته</div>
<div class="chipsel" id="selcbox" style="max-height:none"></div>
<button class="lk" id="selcx" style="width:100%;color:var(--mut)">انصراف</button>
</div></div>
<div class="sh" id="sc" role="dialog" aria-modal="true"><div class="pn">
<div class="pnh" id="sct">دسته‌بندی‌ها</div>
<div class="st" style="margin:0 0 6px">با دسته‌ها هر بخش را گروه‌بندی کن؛ از نوار فیلتر بالای هر لیست، دسته‌ی موردنظر را انتخاب کن.</div>
<div id="catlist"></div>
<div class="mgradd"><input id="cnn" maxlength="40" placeholder="نام دسته جدید…"><button class="go" id="cadd">افزودن</button></div>
<div class="sw" id="csw"></div>
<button class="lk" id="scx" style="width:100%;color:var(--mut)">بستن</button>
</div></div>
<div class="sh" id="lg" role="dialog" aria-modal="true"><div class="pn">
<div class="lgt" id="lgt">ورود</div>
<div id="f-u"><label>ایمیل</label><input id="lu" type="email" inputmode="email" dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="you@example.com"></div>
<div id="f-p"><label id="lpl">رمز عبور</label><input id="pw" type="password" dir="ltr" autocomplete="current-password"></div>
<div id="f-p2"><label>تکرار رمز</label><input id="pw2" type="password" dir="ltr" autocomplete="new-password"></div>
<div id="f-k" hidden><label>کلید API سرویس ایمیل (Resend)</label><input id="lkey" dir="ltr" autocomplete="off" placeholder="re_..."><input id="lfrom" dir="ltr" autocomplete="off" placeholder="فرستنده (اختیاری) Alerts &lt;a@yourdomain.com&gt;" style="margin-top:6px"><div class="st" style="margin:4px 0 0">رایگان از resend.com بگیر. بدون دامنه‌ی تاییدشده، کد فقط به ایمیل خودِ حساب Resend فرستاده می‌شود.</div></div>
<div id="f-c"><label>کد تایید (به ایمیلت فرستاده شد)</label><input id="lc" inputmode="numeric" maxlength="6" dir="ltr"></div>
<div class="cerr" id="lge" style="margin-top:8px"></div>
<button class="go" id="lgo" style="margin-top:4px">ورود</button>
<button class="lk" id="lsw" style="width:100%;color:var(--mut)"></button>
<button class="lk" id="lgl" style="width:100%;color:var(--mut);font-family:var(--sans)">English</button>
</div></div>
<script>
let LANG='fa';try{LANG=localStorage.getItem('lang')==='en'?'en':'fa'}catch(e){}
const I18N=Object.assign(Object.create(null),{"آلارمها": "Alerts", "ارسال کد به ایمیل جدید": "Send code to the new email", "ارسال کد تایید": "Send verification code", "اعلان از طریق": "Notify via", "انصراف": "Cancel", "اهداف (TP / SL)": "Targets (TP / SL)", "ایمیل": "Email", "ایمیل جدید": "New email", "ایمیل دریافت اعلان": "Notification email", "باز کردن ربات در تلگرام ↗": "Open the bot in Telegram ↗", "بستن": "Close", "تاریک": "Dark", "تایید کد": "Verify code", "تغییر رمز": "Change password", "تم": "Theme", "تنظیمات": "Settings", "توکن ربات از BotFather": "Bot token from BotFather", "تکرار رمز": "Repeat password", "ثبت آلارم": "Create alert", "ثبت توکن": "Save token", "جهت": "Direction", "حذف ایمیل": "Remove email", "حساب تو با «نام کاربری» ساخته شده؛ یک ایمیل برایش ثبت کن.": "Your account was created with a username; add an email to it.", "حساب:": "Account:", "خروج از حساب": "Log out", "در حال بارگذاری…": "Loading…", "درصد ریسک (%)": "Risk (%)", "ذخیره سناریو": "Save scenario", "ذخیره واچلیست": "Save watchlist", "رایگان از resend.com بگیر. بدون دامنه‌ی تاییدشده، کد فقط به ایمیل خودِ حساب Resend فرستاده می‌شود.": "Get one free at resend.com. Without a verified domain, the code can only be sent to the email of the Resend account itself.", "ربات تلگرام (دریافت اعلان‌ها)": "Telegram bot (receives alerts)", "رمز جدید (حداقل ۸ کاراکتر)": "New password (min. 8 characters)", "رمز عبور": "Password", "رمز فعلی": "Current password", "روشن": "Light", "سایز پوزیشن ($)": "Position size ($)", "سرمایه حساب (USD)": "Account balance (USD)", "سناریو": "Scenario", "سناریوی روزانه…": "Daily scenario…", "سیستم": "System", "فاصله حد ضرر:": "Stop distance:", "فرستنده (اختیاری) Alerts <a@yourdomain.com>": "Sender (optional) Alerts <a@yourdomain.com>", "قطع اتصال ربات": "Disconnect bot", "قیمت حد ضرر ($)": "Stop-loss price ($)", "قیمت ورود ($)": "Entry price ($)", "قیمت ورود (اختیاری — خالی = نمایش داده نمی‌شود)": "Entry price (optional — empty = not shown)", "لوریج (x)": "Leverage (x)", "ماشین حساب": "Calculator", "مثلاً 0.2462": "e.g. 0.2462", "نوشنال:": "Notional:", "واچ لیست": "Watchlist", "واچلیست هفتگی…": "Weekly watchlist…", "ورود": "Log in", "پنل آلارم": "Alerts panel", "کارمزد خروج (%) — اختیاری": "Exit fee (%) — optional", "کارمزد ورود (%) — اختیاری": "Entry fee (%) — optional", "کد ارسال‌شده به ایمیل جدید": "Code sent to the new email", "کد تایید (به ایمیلت فرستاده شد)": "Verification code (sent to your email)", "کد ۶ رقمی": "6-digit code", "کلید API سرویس ایمیل (Resend)": "Email service API key (Resend)", "کوین": "Coin", "۱) لینک زیر را بزن و در تلگرام Start را بزن ۲) برگرد و «تشخیص» را بزن": "1) Open the link below and press Start in Telegram 2) Come back and press “Detect”", "✉️ ایمیل": "✉️ Email", "✓ تشخیص چت (بعد از Start)": "✓ Detect chat (after Start)", "＋ آلارم جدید": "＋ New alert", "＋ هدف دیگر": "＋ Add target", "📨 تلگرام": "📨 Telegram", "🧪 تست تلگرام و ایمیل": "🧪 Test Telegram & email", "آلارم فعال": "Active alerts", "ارسال نشد": "Could not send", "از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)": "Using the bot set on the worker (enter a new token to change)", "انجام نشد": "Failed", "ایمیل تایید شد ✓": "Email verified ✓", "ایمیل ثبت شد ✓": "Email saved ✓", "ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.": "Remove the email? Alerts that use email will only notify via Telegram.", "ایمیل را وارد کن": "Enter your email", "ایمیل معتبر وارد کن.": "Enter a valid email.", "ایمیل یا رمز اشتباه است.": "Wrong email or password.", "ایمیلی تایید نشده": "No verified email", "این آلارم حذف بشه؟": "Delete this alert?", "این ایمیل اجازه‌ی ثبت‌نام ندارد.": "This email is not allowed to register.", "این ایمیل مجاز نیست.": "This email is not allowed.", "این همان ایمیل فعلی است.": "This is already your current email.", "این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:": "These chats have messaged the bot. Pick your chat:", "با دکمه‌ی پایین اولین رو بساز.": "Create your first one with the button below.", "بازار زنده": "Live market", "بازگشت به ورود": "Back to login", "بازیابی رمز": "Password recovery", "تایید ایمیل": "Verify email", "تایید نشد": "Verification failed", "تایید و ادامه": "Verify & continue", "تست انجام نشد": "Test failed", "تشخیص انجام نشد": "Detection failed", "تلاش زیاد؛ کمی بعد دوباره امتحان کن.": "Too many attempts; try again in a little while.", "تلگرام": "Telegram", "توضیح (مثلاً TP1 / استاپ)": "Note (e.g. TP1 / Stop)", "توکن ربات را وارد کن": "Enter the bot token", "توکن معتبر نیست.": "The token is not valid.", "تکرار رمز یکسان نیست.": "The repeated password does not match.", "ثبت نشد": "Could not save", "ثبت‌نام — ساخت حساب": "Sign up — create account", "جابه‌جایی ذخیره نشد": "Could not save the new order", "حد ضرر نمی‌تواند برابر قیمت ورود باشد.": "The stop-loss cannot equal the entry price.", "حداقل یک روش اعلان را انتخاب کن": "Choose at least one notification method", "حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.": "Your account is still using a username. Please add an email in the “Account” section.", "خطا": "Error", "خطا در دریافت اطلاعات": "Could not load data", "درصد ریسک باید بین 0 و 100 باشد.": "Risk must be between 0 and 100.", "دریافت کد در ایمیل": "Get code by email", "ذخیره شد ✓": "Saved ✓", "ذخیره نشد": "Could not save", "ربات متصل نیست": "Bot not connected", "ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.": "Disconnect the bot? No Telegram alerts will arrive until it is connected again.", "ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)": "Bot connected ✓ (a confirmation message was sent to you)", "رمز باید حداقل ۸ کاراکتر باشد.": "The password must be at least 8 characters.", "رمز تغییر کرد ✓": "Password changed ✓", "رمز جدید باید حداقل ۸ کاراکتر باشد.": "The new password must be at least 8 characters.", "رمز را فراموش کردم": "Forgot password", "رمز فعلی اشتباه است.": "The current password is wrong.", "رمز فعلی را وارد کن.": "Enter your current password.", "سرمایه باید بزرگتر از صفر باشد.": "Balance must be greater than zero.", "قیمت": "Price", "قیمت ورود باید بزرگتر از صفر باشد.": "Entry price must be greater than zero.", "لانگ / شورت": "Long / Short", "لوریج باید بزرگتر از صفر باشد.": "Leverage must be greater than zero.", "مقادیر را وارد کنید…": "Enter the values…", "هدف": "Target", "هدف خورده": "Targets hit", "هدف در انتظار": "Pending targets", "هنوز آلارمی نداری.": "You have no alerts yet.", "ورود به پنل": "Log in to the panel", "کارمزد نمی‌تواند منفی باشد.": "Fees cannot be negative.", "کد اشتباه است.": "Wrong code.", "کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).": "A code was sent to the new email (check spam too).", "کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)": "A verification code was sent to your email (valid for 10 minutes)", "کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).": "A 6-digit code was sent to your email (check the spam folder too).", "کلید API سرویس ایمیل را وارد کن.": "Enter the email service API key.", "کوین و حداقل یک قیمت لازمه": "A coin and at least one price are required", "یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.": "An old webhook was set on this bot and has been removed. Now open the link and press Start (again) in Telegram.", "یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.": "Another program (e.g. an old bot on a server) is reading messages with the same token. Turn it off or create a new bot for the panel.", "— (ایمیل تایید نشده)": "— (email not verified)", "⚠️ سرویس ایمیل تنظیم نشده": "⚠️ Email service is not configured", "⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)": "⚠️ No automatic check has been recorded yet — check the worker Cron Trigger (Settings → Triggers → Cron Triggers)", "✓ فرستاده شد": "✓ Sent", "✓ همه‌ی اهداف خورده": "✓ All targets hit", "(اول ایمیل را در ⚙️ تنظیمات تایید کن)": "(first verify your email in ⚙️ Settings)", "✗ ربات تلگرام وصل نیست (تنظیمات ← ربات تلگرام)": "✗ Telegram bot is not connected (Settings → Telegram bot)", "دستهبندی": "Category", "بدون دسته": "Uncategorized", "همه": "All", "فعال": "Active", "تمامشده": "Done", "⚙ مدیریت دستهها": "⚙ Manage categories", "＋ دسته جدید": "＋ New category", "دستهبندیها": "Categories", "آلارمها را گروهبندی کن؛ با فیلتر بالای لیست فقط دستهی موردنظر را ببین.": "Group your alerts; with the filter above the list you see only the category you want.", "نام دسته جدید…": "New category name…", "افزودن": "Add", "هنوز دستهای نساختی.": "No categories yet.", "نام دسته را وارد کن": "Enter a category name", "دستهای با این نام هست": "A category with this name already exists", "ساخته نشد": "Could not create", "حذف": "Delete", "حذف شد ✓": "Deleted ✓", "حذف نشد": "Could not delete", "تغییر رنگ": "Change color", "تغییر تم": "Toggle theme", "این دسته حذف بشه؟ آلارمهای داخلش بدون دسته میشن.": "Delete this category? Its alerts will become uncategorized.", "با این فیلترها آلارمی پیدا نشد.": "No alerts match these filters.", "پاک کردن فیلترها": "Clear filters", "برای جابهجایی، اول فیلترها را پاک کن": "Clear the filters first, then drag to reorder", "🔍 جستجوی کوین…": "🔍 Search coin…", "بدون جهت": "No direction", "جهت (اختیاری)": "Direction (optional)", "انتخاب چند آلارم": "Select multiple alerts", "انتقال به دسته": "Move to category", "انتخابشده": "selected", "حذف موارد انتخابشده؟": "Delete the selected items?", "انجام شد ✓": "Done ✓", "هیچ": "None", "دسته": "Category", "📂 دسته": "📂 Category", "🗑 حذف": "🗑 Delete", "سناریوی جدید": "New scenario", "ویرایش سناریو": "Edit scenario", "عنوان": "Title", "مثلاً دیدگاه هفتگی": "e.g. weekly outlook", "متن": "Text", "متن سناریو…": "Scenario text…", "بدون عنوان": "Untitled", "ذخیره": "Save", "سناریویی ثبت نشده.": "No scenarios yet.", "با دکمهی پایین اولین سناریو را بساز.": "Create the first scenario with the button below.", "واچلیست خالیه.": "The watchlist is empty.", "با دکمهی پایین اولین آیتم را اضافه کن.": "Add the first item with the button below.", "با این فیلترها موردی پیدا نشد.": "Nothing matches these filters.", "آیتم واچلیست": "Watchlist item", "ویرایش آیتم": "Edit item", "یادداشت (اختیاری)…": "Note (optional)…", "اول کوین را وارد کن": "Enter a coin first", "چیزی برای ذخیره نیست": "Nothing to save", "این مورد حذف بشه؟": "Delete this item?", "🔔 اعلانها": "🔔 Notifications", "👤 حساب": "👤 Account", "دستهبندی آلارمها": "Alert categories", "دستهبندی واچلیست": "Watchlist categories", "دستهبندی سناریو": "Scenario categories", "🔍 جستجو…": "🔍 Search…", "نام واچلیست": "Watchlist name", "واچلیست جدید": "New watchlist", "ویرایش واچلیست": "Edit watchlist", "＋ واچلیست جدید": "＋ New watchlist", "با دکمهی پایین اولین واچلیست را بساز.": "Create your first watchlist with the button below.", "اول نام واچلیست را وارد کن": "Enter a watchlist name first", "یادداشت": "Note"});
Object.assign(I18N,{'پوزیشنها':'Positions','پوزیشن جدید':'New position','ویرایش پوزیشن':'Edit position','پوزیشنی ثبت نشده.':'No positions yet.','با دکمهی پایین اولین پوزیشن را بنویس.':'Use the button below to write your first position.','مثلاً BTC لانگ از ۶۰ هزار':'e.g. BTC long from 60k','متن پوزیشن، دلیل ورود، حد ضرر، نکات…':'Position text, entry reason, stop loss, notes…','دستهبندی پوزیشنها':'Position categories','＋ پوزیشن جدید':'＋ New position','استراتژی':'Strategy','استراتژی جدید':'New strategy','ویرایش استراتژی':'Edit strategy','استراتژیای ثبت نشده.':'No strategies yet.','با دکمهی پایین اولین استراتژی را بنویس.':'Use the button below to write your first strategy.','مثلاً استراتژی شکست سقف':'e.g. Breakout strategy','شرایط ورود، خروج، مدیریت سرمایه، قوانین…':'Entry and exit rules, risk management…','دستهبندی استراتژی':'Strategy categories','＋ استراتژی جدید':'＋ New strategy','ترید تسک':'Trade tasks','تسک جدید':'New task','ویرایش تسک':'Edit task','تسکی ثبت نشده.':'No tasks yet.','با دکمهی پایین اولین ترید تسک را بنویس.':'Use the button below to write your first trade task.','مثلاً بررسی اخبار قبل از ورود':'e.g. Check the news before entering','کارهایی که قبل و بعد از ترید باید انجام بدی…':'Things to do before and after a trade…','دستهبندی ترید تسک':'Trade task categories','＋ تسک جدید':'＋ New task'});
Object.assign(I18N,{'🔔 اعلان‌ها':'🔔 Alerts','👤 حساب':'👤 Account','ایمیل حساب':'Account email','برای تغییر ایمیل یا رمز، اول رمز فعلی را وارد کن.':'To change your email or password, enter your current password first.','رمز عبور':'Password','✉️ ایمیل':'✉️ Email','📋 لاگ':'📋 Log','لاگ':'Log','تازهسازی':'Refresh'});
Object.assign(I18N,{'مارجین لازم':'Margin needed','سرمایهای که باید وارد پوزیشن کنی':'Capital to put into the position','حجم پوزیشن':'Position size','تعداد':'Quantity','ریسک':'Risk','نسبت سود به ضرر':'Reward : risk','جهت:':'Direction:','فاصله حد ضرر:':'Stop distance:','فاصله حد سود:':'Take-profit distance:','قیمت لیکویید (تقریبی):':'Liquidation (approx.):','حساب':'Account','معامله':'Trade','کارمزد (اختیاری)':'Fees (optional)','حد سود ($) — اختیاری':'Take-profit ($) — optional','کارمزد ورود (%)':'Entry fee (%)','کارمزد خروج (%)':'Exit fee (%)','قیمت حد سود باید بزرگتر از صفر باشد.':'Take-profit price must be greater than zero.','حد سود باید در سمت سود باشد (بالاتر از ورود برای Long، پایینتر برای Short).':'Take-profit must be on the profit side (above entry for Long, below for Short).','حد ضرر بعد از قیمت لیکویید قرار دارد؛ لوریج را کم کن.':'The stop is beyond the liquidation price; lower the leverage.'});
const nz=s=>s.replace(/\u200c/g,'').replace(/\s+/g,' ').trim();
const PAT=[
 [/^سایز پوزیشن \((.+) \$\) بیشتر از سرمایه است\.$/,m=>'Position size ('+m[1]+' $) is larger than the account balance.'],
 [/^✅ همه چیز سالم است — (?:(\d+) آلارم فعال زیر نظر است|آلارم فعالی نیست) · آخرین چک: (چند ثانیه|\d+) ?(?:دقیقه)? پیش$/,m=>'✅ All good — '+(m[1]?m[1]+' active alerts being watched':'no active alerts')+' · last check: '+(m[2]==='چند ثانیه'?'a few seconds':m[2]+' min')+' ago'],
 [/^📨 آخرین پیام آلارم: ✓ ارسال شد \((چند ثانیه|\d+ دقیقه) پیش\)$/,m=>'📨 Last alert message: ✓ sent ('+(m[1]==='چند ثانیه'?'a few seconds':m[1].replace(' دقیقه',' min'))+' ago)'],
 [/^📨 آخرین پیام آلارم: ⚠️ ارسال نشد — (.*) \((چند ثانیه|\d+ دقیقه) پیش\) — دوباره تلاش میشود$/,m=>'📨 Last alert message: ⚠️ not delivered — '+(m[1]==='ربات تلگرام وصل نیست'?'Telegram bot is not connected':m[1]==='نامشخص'?'unknown':m[1])+' ('+(m[2]==='چند ثانیه'?'a few seconds':m[2].replace(' دقیقه',' min'))+' ago) — will retry'],
 [/^📍 (.+): قیمت گرفته نمیشود$/,m=>'📍 '+m[1]+': price unavailable'],
 [/^📍 (.+): قیمت الان (.+) · نزدیکترین هدف (.+) \((.+)٪ فاصله\)$/,m=>'📍 '+m[1]+': price now '+m[2]+' · nearest target '+m[3]+' ('+m[4]+'% away)'],
 [/^⚠️ آخرین چک خودکار (\d+) دقیقه پیش بوده — Cron Trigger را چک کن$/,m=>'⚠️ Last automatic check was '+m[1]+' min ago — check the Cron Trigger'],
 [/^(✓ چک خودکار فعال|⚠️ خطا در چک: .*?) \(آخرین ثبت: (چند ثانیه|\d+) ?(?:دقیقه)? پیش\)(?: — قیمت این کوین‌ها گرفته نمی‌شود: (.*))?$/,m=>(m[1][0]==='✓'?'✓ Automatic check active':'⚠️ Check error: '+m[1].slice(13))+' (last run: '+(m[2]==='چند ثانیه'?'a few seconds':m[2]+' min')+' ago)'+(m[3]?' — prices unavailable for: '+m[3]:'')],
 [/^ربات @(\S+) ثبت شد — منتظر اتصال چت$/,m=>'Bot @'+m[1]+' registered — waiting for the chat to connect'],
 [/^✓ متصل: @(\S+)$/,m=>'✓ Connected: @'+m[1]],
 [/^هنوز پیامی در ربات ندیدم\. در تلگرام به ربات @(\S*) یک پیام بفرست \(مثلاً \/start\) و دوباره «تشخیص» را بزن\.$/,m=>'I have not seen any message in the bot yet. In Telegram, send a message (e.g. /start) to @'+m[1]+' and press “Detect” again.'],
 [/^✓ ایمیل تایید شده: (.+)$/,m=>'✓ Verified email: '+m[1]],
 [/^([+-]?[\d.,]+)٪ تا هدف$/,m=>m[1]+'% to target'],
 [/^ریسک = (.*)$/,m=>'Risk = '+m[1]],
 [/^سایز = (.*)$/,m=>'Size = '+m[1]]
];
function tr1(k){if(k in I18N)return I18N[k];for(const[re,f]of PAT){const m=k.match(re);if(m)return f(m)}
 let m=k.match(/^(.+?) \((.*)\)$/);if(m&&m[1] in I18N)return I18N[m[1]]+' ('+m[2]+')';
 m=k.match(/^(.+?): (.+)$/);if(m&&m[1] in I18N)return I18N[m[1]]+': '+tr1(m[2]);
 return k}
function T(s){if(LANG!=='en'||typeof s!=='string'||!/[\u0600-\u06FF]/.test(s))return s;
 if(s.includes('\n'))return s.split('\n').map(T).join('\n');
 const k=nz(s);if(!k)return s;const r=tr1(k);return r===k?s:s.match(/^\s*/)[0]+r+s.match(/\s*$/)[0]}
function trNode(n){if(n.nodeType===3){const v=T(n.nodeValue);if(v!==n.nodeValue)n.nodeValue=v;return}
 if(n.nodeType!==1||n.tagName==='SCRIPT'||n.tagName==='STYLE')return;
 for(const a of ['placeholder','aria-label','title']){if(n.hasAttribute(a)){const o=n.getAttribute(a),v=T(o);if(v!==o)n.setAttribute(a,v)}}
 n.childNodes.forEach(trNode)}
if(LANG==='en'){document.documentElement.lang='en';document.documentElement.dir='ltr';document.title=T(document.title);trNode(document.body);
 new MutationObserver(ms=>{for(const m of ms){if(m.type==='characterData')trNode(m.target);else m.addedNodes.forEach(trNode)}}).observe(document.body,{childList:true,subtree:true,characterData:true})}
function syncLang(){fetch('/api/lang',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({lang:LANG})}).catch(()=>{})}
function setLang(l){try{localStorage.setItem('lang',l)}catch(e){}fetch('/api/lang',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({lang:l})}).catch(()=>{}).finally(()=>location.reload())}
const $=s=>document.querySelector(s);
function applyTheme(){let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}if(m!=='light'&&m!=='dark')m='system';const t=m==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):m;const h=document.documentElement;h.setAttribute('data-theme',t);h.setAttribute('data-tmode',m);try{document.querySelectorAll('meta[name="theme-color"]').forEach(x=>x.remove());const mm=document.createElement('meta');mm.setAttribute('name','theme-color');mm.setAttribute('content',t==='light'?'#f1f2fa':'#0a0c12');document.head.appendChild(mm)}catch(e){}}
applyTheme();
try{matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}if(m==='system')applyTheme()})}catch(e){}
let _tmT=0;function themeFx(){const h=document.documentElement;h.classList.add('theming');clearTimeout(_tmT);_tmT=setTimeout(()=>h.classList.remove('theming'),420)}
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=v=>v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function api(m,p,b){const r=await fetch(p,{method:m,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
 if(r.status===401&&p!=='/api/login'){try{localStorage.removeItem('acache')}catch(e){}showLogin();throw new Error('401 unauthorized')}
 if(!r.ok){let t='';try{t=(await r.json()).error||''}catch(e){}throw new Error(r.status+(t?' '+t:''))}return r.json()}
function fld(n,k){for(const x of String(n||'').split('\n')){const i=x.indexOf(':');if(i>0&&x.slice(0,i).trim()===k)return x.slice(i+1).trim()}return ''}
function kind(a,t){const d=fld(t.note,'جهت').toLowerCase(),e=a.entry_price!=null?a.entry_price:a.ref_price;if(e==null)return 'n';if(t.price===e)return 'en';if(d==='long')return t.price>=e?'tp':'sl';if(d==='short')return t.price>e?'sl':'tp';return 'n'}
let alerts=[],prices={};
let cats=[],newCat=0,newCol='#8B5CF6';
const PALETTE=['#8B5CF6','#2EE6A6','#4DA3FF','#F471B5','#FFB020','#FF4D6D','#FF8A3D','#22D3EE'];
let flt={q:'',cat:'',st:'all',dir:'all'};
let witems=[],wcats=[],wFlt={q:'',cat:''},wNewCat=0,wEid=null;
let sitems=[],scats=[],sFlt={q:'',cat:''},sNewCat=0,sEid=null;
let pitems=[],pcats=[],pFlt={q:'',cat:''},pNewCat=0,pEid=null;
let gitems=[],gcats=[],gFlt={q:'',cat:''},gNewCat=0,gEid=null;
let kitems=[],kcats=[],kFlt={q:'',cat:''},kNewCat=0,kEid=null;

let selOn=false,sel=new Set(),visIds=[],mgrKind='a',_lastIds='';
let _aAt=0,_wAt=0,_sAt=0,_pAt=0,_gAt=0,_kAt=0,_setAt=0;
try{const f=JSON.parse(localStorage.getItem('flt')||'null');if(f&&typeof f==='object')flt={q:String(f.q||''),cat:(f.cat===''||f.cat==null)?'':(f.cat===0?0:(+f.cat||'')),st:['all','act','done'].indexOf(f.st)>=0?f.st:'all',dir:['all','long','short','none'].indexOf(f.dir)>=0?f.dir:'all'}}catch(e){}
const saveFlt=()=>{try{localStorage.setItem('flt',JSON.stringify(flt))}catch(e){}};
const saveWFlt=()=>{try{localStorage.setItem('wflt',JSON.stringify(wFlt))}catch(e){}},saveSFlt=()=>{try{localStorage.setItem('sflt',JSON.stringify(sFlt))}catch(e){}},savePFlt=()=>{try{localStorage.setItem('pflt',JSON.stringify(pFlt))}catch(e){}},saveGFlt=()=>{try{localStorage.setItem('gflt',JSON.stringify(gFlt))}catch(e){}},saveKFlt=()=>{try{localStorage.setItem('kflt',JSON.stringify(kFlt))}catch(e){}};
try{const f=JSON.parse(localStorage.getItem('wflt')||'null');if(f&&typeof f==='object')wFlt={q:String(f.q||''),cat:(f.cat===''||f.cat==null)?'':(+f.cat||'')}}catch(e){}
try{const f=JSON.parse(localStorage.getItem('sflt')||'null');if(f&&typeof f==='object')sFlt={q:String(f.q||''),cat:(f.cat===''||f.cat==null)?'':(+f.cat||'')}}catch(e){}
try{const f=JSON.parse(localStorage.getItem('pflt')||'null');if(f&&typeof f==='object'){pFlt={q:String(f.q||''),cat:(f.cat===''||f.cat==null)?'':(+f.cat||'')}}}catch(e){}
try{const f=JSON.parse(localStorage.getItem('gflt')||'null');if(f&&typeof f==='object'){gFlt={q:String(f.q||''),cat:(f.cat===''||f.cat==null)?'':(+f.cat||'')}}}catch(e){}
try{const f=JSON.parse(localStorage.getItem('kflt')||'null');if(f&&typeof f==='object'){kFlt={q:String(f.q||''),cat:(f.cat===''||f.cat==null)?'':(+f.cat||'')}}}catch(e){}

const catById=id=>cats.find(c=>c.id===id)||null;
const doneA=a=>a.targets.length>0&&(a.triggered||[]).length>=a.targets.length;
const dirA=a=>fld((a.targets[0]||{}).note||'','جهت').toLowerCase();
function matchF(a){if(flt.cat!==''&&(a.cat||0)!==flt.cat)return false;if(flt.st==='act'&&doneA(a))return false;if(flt.st==='done'&&!doneA(a))return false;if(flt.dir!=='all'){const dd=dirA(a);if(flt.dir==='none'?dd!=='':dd!==flt.dir)return false}if(flt.q&&!(a.coin||'').toUpperCase().includes(flt.q.toUpperCase()))return false;return true}
const fltOn=()=>!(flt.q===''&&flt.cat===''&&flt.st==='all'&&flt.dir==='all');
function clearFlt(){flt={q:'',cat:'',st:'all',dir:'all'};saveFlt();$('#fq').value='';markF();paintChips();render()}
function markF(){document.querySelectorAll('#fst button').forEach(b=>b.classList.toggle('on',b.dataset.s===flt.st));document.querySelectorAll('#fdr button').forEach(b=>b.classList.toggle('on',b.dataset.d===flt.dir))}
const chipsHTML=(arr,cur,cnt)=>'<button class="fc'+(cur===''?' on':'')+'" data-c="">همه <b>'+cnt('all')+'</b></button><button class="fc'+(cur===0?' on':'')+'" data-c="0">بدون دسته <b>'+cnt(0)+'</b></button>'+arr.map(c=>'<button class="fc'+(cur===c.id?' on':'')+'" data-c="'+c.id+'"><span class="dot" style="background:'+c.color+';color:'+c.color+'"></span>'+esc(c.name)+' <b>'+cnt(c.id)+'</b></button>').join('')+'<button class="fc mgrb">⚙ مدیریت دسته‌ها</button>';
function paintChips(){const box=$('#fchips');if(!box)return;const cnt=id=>id==='all'?alerts.length:alerts.filter(a=>(a.cat||0)===id).length;box.innerHTML=chipsHTML(cats,flt.cat,cnt)}
function paintWChips(){const box=$('#wchips');if(!box)return;const cnt=id=>id==='all'?witems.length:witems.filter(i=>(i.cat||0)===id).length;box.innerHTML=chipsHTML(wcats,wFlt.cat,cnt)}
function paintPChips(){const box=$('#pchips');if(!box)return;const cnt=id=>id==='all'?pitems.length:pitems.filter(i=>(i.cat||0)===id).length;box.innerHTML=chipsHTML(pcats,pFlt.cat,cnt)}
function paintGChips(){const box=$('#gchips');if(!box)return;const cnt=id=>id==='all'?gitems.length:gitems.filter(i=>(i.cat||0)===id).length;box.innerHTML=chipsHTML(gcats,gFlt.cat,cnt)}
function paintKChips(){const box=$('#kchips');if(!box)return;const cnt=id=>id==='all'?kitems.length:kitems.filter(i=>(i.cat||0)===id).length;box.innerHTML=chipsHTML(kcats,kFlt.cat,cnt)}
function paintSChips(){const box=$('#schips');if(!box)return;const cnt=id=>id==='all'?sitems.length:sitems.filter(i=>(i.cat||0)===id).length;box.innerHTML=chipsHTML(scats,sFlt.cat,cnt)}
const catSelHTML=(arr,cur)=>'<button class="fc'+(cur===0?' on':'')+'" data-c="0">بدون دسته</button>'+arr.map(c=>'<button class="fc'+(cur===c.id?' on':'')+'" data-c="'+c.id+'"><span class="dot" style="background:'+c.color+';color:'+c.color+'"></span>'+esc(c.name)+'</button>').join('');
function paintCatSel(){const box=$('#catsel');if(box)box.innerHTML=catSelHTML(cats,newCat)+'<button class="fc" id="cnew">＋ دسته جدید</button>'}
function paintWCatSel(){const box=$('#wcatsel');if(box)box.innerHTML=catSelHTML(wcats,wNewCat)+'<button class="fc" id="wnew">＋ دسته جدید</button>'}
function paintPCatSel(){const box=$('#pcatsel');if(box)box.innerHTML=catSelHTML(pcats,pNewCat)+'<button class="fc" id="pnew">＋ دسته جدید</button>'}
function paintGCatSel(){const box=$('#gcatsel');if(box)box.innerHTML=catSelHTML(gcats,gNewCat)+'<button class="fc" id="gnew">＋ دسته جدید</button>'}
function paintKCatSel(){const box=$('#kcatsel');if(box)box.innerHTML=catSelHTML(kcats,kNewCat)+'<button class="fc" id="knew">＋ دسته جدید</button>'}
function paintSCatSel(){const box=$('#scatsel');if(box)box.innerHTML=catSelHTML(scats,sNewCat)+'<button class="fc" id="snew">＋ دسته جدید</button>'}
const catByIdW=id=>wcats.find(c=>c.id===id)||null,catByIdS=id=>scats.find(c=>c.id===id)||null,catByIdP=id=>pcats.find(c=>c.id===id)||null,catByIdG=id=>gcats.find(c=>c.id===id)||null,catByIdK=id=>kcats.find(c=>c.id===id)||null;
function paintSw(){const box=$('#csw');if(!box)return;box.innerHTML=PALETTE.map(c=>'<button data-col="'+c+'" class="'+(c===newCol?'on':'')+'" style="background:'+c+';color:'+c+'"></button>').join('')}
const mgrCats=()=>mgrKind==='a'?cats:mgrKind==='w'?wcats:mgrKind==='p'?pcats:mgrKind==='g'?gcats:mgrKind==='k'?kcats:scats,mgrApi=()=>mgrKind==='a'?'/api/cats':mgrKind==='w'?'/api/wcats':mgrKind==='p'?'/api/pcats':mgrKind==='g'?'/api/gcats':mgrKind==='k'?'/api/kcats':'/api/scats';
function paintMgr(){const box=$('#catlist');if(!box)return;const arr=mgrCats();
 $('#sct').textContent=mgrKind==='a'?'دسته‌بندی آلارم‌ها':mgrKind==='w'?'دسته‌بندی واچ‌لیست':mgrKind==='p'?'دسته‌بندی پوزیشن‌ها':mgrKind==='g'?'دسته‌بندی استراتژی':mgrKind==='k'?'دسته‌بندی ترید تسک':'دسته‌بندی سناریو';
 box.innerHTML=arr.length?arr.map(c=>'<div class="crow" data-id="'+c.id+'"><button class="cdot" title="تغییر رنگ" style="background:'+c.color+'"></button><input value="'+esc(c.name)+'" maxlength="40"><button class="cdel" title="حذف">🗑</button></div>').join(''):'<div class="st" style="margin:2px 0 4px">هنوز دسته‌ای نساختی.</div>'}
function openMgr(k){if(k)mgrKind=k;paintMgr();paintSw();$('#sc').classList.add('on')}
const sc=a=>{const v=a.targets.map(t=>t.price);if(a.entry_price!=null)v.push(a.entry_price);const lo=Math.min(...v),hi=Math.max(...v),p=((hi-lo)||hi*0.02||1)*0.15;return[lo-p,hi+p]};
const at=(a,x)=>{const[L,R]=sc(a);return Math.max(0,Math.min(100,(x-L)/(R-L)*100)).toFixed(1)};
function dist(a,px){if(px==null)return '';const t=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).sort((p,q)=>Math.abs(p.price-px)-Math.abs(q.price-px))[0];if(!t)return '✓ همه‌ی اهداف خورده';const p=(t.price-px)/px*100;return (p>0?'+':'')+p.toFixed(2)+'٪ تا هدف'}
function card(a){
 const d=fld(a.targets[0].note,'جهت').toLowerCase(),c=d==='long'?'long':d==='short'?'short':'neu',px=a.entry_price!=null?prices[a.coin]:null,cn=catById(a.cat);
 const pos=x=>at(a,x);
 const hit=t=>(a.triggered||[]).includes(t.id);
 let tk=a.targets.map(t=>'<i class="tk '+kind(a,t)+(hit(t)?' hit':'')+'" style="left:'+pos(t.price)+'%"></i>').join('');
 if(a.entry_price!=null)tk+='<i class="tk en" style="left:'+pos(a.entry_price)+'%"></i>';
 tk+='<b class="now" id="n'+a.id+'" style="'+(px!=null?'left:'+pos(px)+'%':'display:none')+'"></b>';
 const rows=a.targets.map(t=>{const k=kind(a,t);return '<div class="row '+k+(hit(t)?' hit':'')+'" data-a="'+a.id+'" data-t="'+t.id+'"><span class="tag">'+({tp:'TP',sl:'SL',en:'EN',n:'هدف'}[k])+'</span><span class="pr">'+fmt(t.price)+'</span><span class="nt">'+esc(fld(t.note,'توضیحات'))+'</span>'+(hit(t)?'<span class="ok">✓</span>':'')+'</div>'}).join('');
 return '<div class="card '+c+(a.targets.length===1&&hit(a.targets[0])?' done':'')+(sel.has(a.id)?' sel':'')+'" data-id="'+a.id+'"><div class="hd">'+(selOn?'<span class="sbox">✓</span>':'')+'<span class="dh">⠿</span><span class="av">'+esc(a.coin.slice(0,3))+'</span><div class="idn"><span class="coin">'+esc(a.coin)+'</span><span class="pill">'+(d==='long'?'LONG':d==='short'?'SHORT':'WATCH')+'</span>'+(cn?'<span class="catpill" style="color:'+cn.color+';border-color:'+cn.color+'66">'+esc(cn.name)+'</span>':'')+'</div><div class="pxw"><span class="px" id="x'+a.id+'">'+(px!=null?fmt(px):(a.entry_price!=null?'…':''))+'</span><span class="dist" id="d'+a.id+'">'+dist(a,px)+'</span></div><button class="x ed" data-id="'+a.id+'">✎</button><button class="x" data-id="'+a.id+'">🗑</button></div><div class="prog"><i style="width:'+(a.targets.filter(hit).length/a.targets.length*100)+'%"></i></div><div class="trk">'+tk+'</div><div class="why" id="w'+a.id+'"></div>'+rows+'</div>';
}
function mkt(){const cs=[...new Set(alerts.filter(a=>a.entry_price!=null).map(a=>a.coin))];$('#mk').innerHTML=cs.length?'<h3>بازار زنده</h3>'+cs.map(c=>'<div class="mr"><b>'+esc(c)+'</b><span>'+(prices[c]!=null?fmt(prices[c]):'—')+'</span></div>').join(''):''}
function render(){try{mkt()}catch(e){}try{paintChips()}catch(e){}
 if(!alerts.length){$('#list').innerHTML='<div class="msg">هنوز آلارمی نداری.<br>با دکمه‌ی پایین اولین رو بساز.</div>';return}
 const vis=alerts.filter(matchF);visIds=vis.map(a=>a.id);
 const idsKey=visIds.join(','),still=idsKey===_lastIds;_lastIds=idsKey;
 $('#list').classList.toggle('still',still&&!!idsKey);
 $('#list').innerHTML=vis.length?vis.map(a=>{try{return card(a)}catch(e){return ''}}).join(''):'<div class="msg">با این فیلترها آلارمی پیدا نشد.<br><button class="lk" id="fclr2" style="margin-top:10px">پاک کردن فیلترها</button></div>';
 const b2=$('#fclr2');if(b2)b2.onclick=clearFlt}
const lastPx={},hitTried={};let _chk=0;
function localHit(){for(const a of alerts){if(doneA(a))continue;const px=prices[a.coin];if(px==null)continue;const lp=lastPx[a.coin]!=null?lastPx[a.coin]:a.prev_price,en=a.entry_price!=null?a.entry_price:a.ref_price;
 for(const t of a.targets){if((a.triggered||[]).includes(t.id))continue;const g=t.price,key=a.id+'_'+t.id+'_'+g;if(hitTried[key])continue;
  const m=/جهت\s*[:：]\s*(\S+)/.exec(t.note||''),dr=m?m[1].toLowerCase():'',cross=lp!=null&&((lp<g&&px>=g)||(lp>g&&px<=g));let h=px===g;
  if((dr==='long'||dr==='short'||dr==='لانگ'||dr==='شورت')&&en!=null&&g!==en){const lg=dr==='long'||dr==='لانگ';h=h||((lg?g>=en:g>en)?px>=g:px<=g)}else h=h||cross;
  if(h){hitTried[key]=1;return true}}}return false}
async function checkNow(){if(Date.now()-_chk<8000)return;_chk=Date.now();try{await api('POST','/api/check-now');await refresh()}catch(e){}}
function liveTick(){const cs=[...new Set(alerts.filter(a=>!doneA(a)).map(a=>a.coin))];if(!cs.length)return Promise.resolve();return loadPrices(cs).then(()=>{if(localHit())checkNow();cs.forEach(c=>{if(prices[c]!=null)lastPx[c]=prices[c]})})}
async function loadPrices(cs0){const cs=cs0||[...new Set(alerts.filter(a=>a.entry_price!=null).map(a=>a.coin))];if(!cs.length)return;try{prices=await api('GET','/api/prices?coins='+cs.join(','));const chg=[];alerts.forEach(a=>{const px=prices[a.coin],n=$('#n'+a.id),x=$('#x'+a.id);if(!n||!x||a.entry_price==null)return;const nv=px!=null?fmt(px):'—';if(x.textContent!==nv){x.textContent=nv;chg.push(x)}const dd=$('#d'+a.id);if(dd)dd.textContent=dist(a,px);const w=$('#w'+a.id);if(w)w.textContent=px==null?(prices['_why_'+a.coin]||''):'';if(px!=null){n.style.display='';n.style.left=at(a,px)+'%'}});if(chg.length){chg.forEach(x=>x.classList.remove('pchg'));void document.body.offsetWidth;chg.forEach(x=>x.classList.add('pchg'))}mkt()}catch(e){alerts.forEach(a=>{const x=$('#x'+a.id);if(x&&x.textContent==='…')x.textContent='—'})}}
function cacheA(){try{localStorage.setItem('acache',JSON.stringify({alerts,cats}))}catch(e){}}
async function load(){try{const d=await api('GET','/api/alerts?x=2');alerts=(d.alerts||[]).filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();render();paintChips();cacheA();loadPrices();if(d.status)loadStatus(d.status);else loadStatus();if(d.settings)loadSettings(d.settings);else loadSettings()}catch(e){if(!String(e.message).startsWith('401')&&!alerts.length)$('#list').innerHTML='<div class="msg">خطا در دریافت اطلاعات ('+esc(e.message)+')</div>'}}
let dir='',eid=null,tab='a';
const say=m=>alert(T(m));
const ask=(m,f)=>{if(confirm(T(m)))f()};
function closeSh(s){const el=$(s);if(!el)return;el.classList.add('bye');setTimeout(()=>el.classList.remove('on','bye'),160)}
const setDir=d=>{dir=d;document.querySelectorAll('#seg button').forEach(x=>x.classList.toggle('on',x.dataset.d===d))};
function grp(el){const c=el.selectionStart;let s=el.value.replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d));const n=s.slice(0,c).replace(/[^0-9.]/g,'').length;let v=s.replace(/[^0-9.]/g,'');const p=v.split('.');v=p[0].replace(/\B(?=(\d{3})+(?!\d))/g,',')+(p.length>1?'.'+p.slice(1).join(''):'');if(el.value===v)return;el.value=v;let k=0,i=0;for(;i<v.length&&k<n;i++)if(v[i]!==',')k++;try{el.setSelectionRange(i,i)}catch(e){}}
const growW=()=>{const t=$('#wnote');if(!t)return;t.style.height='auto';t.style.height=Math.max(150,Math.min(t.scrollHeight,430))+'px'};
document.addEventListener('input',e=>{if(e.target.classList.contains('tp'))grp(e.target);if(e.target.id==='wnote')growW()});

const tr=(p,n)=>{const d=document.createElement('div');d.className='tr';d.innerHTML='<input class="tp" inputmode="decimal" placeholder="قیمت"><input class="tn" placeholder="توضیح (مثلاً TP1 / استاپ)">';if(p!=null)d.children[0].value=fmt(p);if(n)d.children[1].value=n;$('#trs').appendChild(d)};
$('#list').onclick=e=>{if(selOn){const c=e.target.closest('.card');if(c&&c.dataset.id)togSel(+c.dataset.id);return}const r=e.target.closest('.row');if(r&&!e.target.closest('.x')){api('POST','/api/alerts/'+r.dataset.a+'/tick',{tid:+r.dataset.t}).then(load).catch(()=>say('انجام نشد'));return}const b=e.target.closest('.x');if(!b)return;const id=+b.dataset.id;
 if(b.classList.contains('ed')){const a=alerts.find(x=>x.id===id);if(!a)return;eid=id;$('#coin').value=a.coin;$('#entry').value=a.entry_price!=null?fmt(a.entry_price):'';$('#c-tg').checked=(a.ch||['tg']).includes('tg');$('#c-em').checked=!!st.verified&&(a.ch||[]).includes('email');$('#coin').disabled=true;const od=fld(a.targets[0].note,'جهت').toLowerCase();setDir(od==='short'?'short':od==='long'?'long':'');$('#trs').innerHTML='';a.targets.forEach(t=>tr(t.price,fld(t.note,'توضیحات')));newCat=a.cat||0;paintCatSel();$('#sh').classList.add('on');return}
 ask('این آلارم حذف بشه؟',async()=>{await api('DELETE','/api/alerts/'+id);load()})};
function togSel(id){if(sel.has(id))sel.delete(id);else sel.add(id);const c=document.querySelector('#list .card[data-id="'+id+'"]');if(c)c.classList.toggle('sel',sel.has(id));$('#seln').textContent=sel.size}
function paintSelBar(){const bar=$('#selbar');if(!bar)return;bar.hidden=!selOn;$('#seln').textContent=sel.size;$('#selbtn').classList.toggle('on',selOn);if(selOn)$('#fab').style.display='none';else if(tab!=='c')$('#fab').style.display=''}
function enterSel(){if(selOn)return;selOn=true;sel.clear();document.body.classList.add('selmode');render();paintSelBar()}
function exitSel(){if(!selOn)return;selOn=false;sel.clear();document.body.classList.remove('selmode');render();paintSelBar()}
$('#selbtn').onclick=()=>selOn?exitSel():enterSel();
$('#selall').onclick=()=>{visIds.forEach(id=>sel.add(id));document.querySelectorAll('#list .card').forEach(c=>c.classList.toggle('sel',sel.has(+c.dataset.id)));paintSelBar()};
$('#selnone').onclick=()=>{sel.clear();document.querySelectorAll('#list .card').forEach(c=>c.classList.remove('sel'));paintSelBar()};
$('#selx').onclick=exitSel;
$('#seldel').onclick=()=>{if(!sel.size)return;ask('حذف موارد انتخابشده؟',async()=>{try{await api('POST','/api/alerts/bulk',{act:'del',ids:[...sel]});exitSel();await load();say('حذف شد ✓')}catch(e){say('حذف نشد ('+e.message+')')}})};
$('#selcatb').onclick=()=>{if(!sel.size)return;$('#selcbox').innerHTML=catSelHTML(cats,-1);$('#selcat').classList.add('on')};
$('#selcx').onclick=()=>closeSh('#selcat');
$('#selcbox').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{await api('POST','/api/alerts/bulk',{act:'cat',cat:+b.dataset.c||0,ids:[...sel]});closeSh('#selcat');exitSel();await load();say('انجام شد ✓')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#seg').onclick=e=>{const b=e.target.closest('button');if(b)setDir(b.dataset.d)};
$('#fab').onclick=()=>{if(tab==='p'){pEid=null;$('#fpot').textContent='پوزیشن جدید';$('#ptitle').value='';$('#ptext').value='';pNewCat=0;paintPCatSel();$('#fpo').classList.add('on');return}
 if(tab==='g'){gEid=null;$('#fgot').textContent='استراتژی جدید';$('#gtitle').value='';$('#gtext').value='';gNewCat=0;paintGCatSel();$('#fgo').classList.add('on');return}
 if(tab==='k'){kEid=null;$('#fkot').textContent='تسک جدید';$('#ktitle').value='';$('#ktext').value='';kNewCat=0;paintKCatSel();$('#fko').classList.add('on');return}
 if(tab==='s'){sEid=null;$('#fsct').textContent='سناریوی جدید';$('#stitle').value='';$('#stext').value='';sNewCat=0;paintSCatSel();$('#fsc').classList.add('on');return}
 if(tab==='w'){wEid=null;$('#fwlt').textContent='واچلیست جدید';$('#wcoin').value='';$('#wnote').value='';wNewCat=0;paintWCatSel();$('#fwl').classList.add('on');growW();return}
 eid=null;$('#coin').value='';$('#entry').value='';$('#c-tg').checked=true;$('#c-em').checked=!!st.verified;$('#coin').disabled=false;setDir('');$('#trs').innerHTML='';newCat=0;paintCatSel();tr();$('#sh').classList.add('on')};
$('#addT').onclick=()=>tr();$('#cancel').onclick=()=>closeSh('#sh');
$('#fchips').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mgrb')){openMgr('a');return}flt.cat=b.dataset.c===''?'':+b.dataset.c;saveFlt();paintChips();render()};
$('#fst').onclick=e=>{const b=e.target.closest('button');if(!b)return;flt.st=b.dataset.s;saveFlt();markF();render()};
$('#fdr').onclick=e=>{const b=e.target.closest('button');if(!b)return;flt.dir=b.dataset.d;saveFlt();markF();render()};
$('#fclr').onclick=clearFlt;
let _qT={};document.addEventListener('input',e=>{const id=e.target.id;if(id!=='fq'&&id!=='wq'&&id!=='sq'&&id!=='pq'&&id!=='gq'&&id!=='kq')return;clearTimeout(_qT[id]);const v=e.target.value.trim();if((id==='fq'&&flt.q===v)||(id==='wq'&&wFlt.q===v)||(id==='sq'&&sFlt.q===v)||(id==='pq'&&pFlt.q===v)||(id==='gq'&&gFlt.q===v)||(id==='kq'&&kFlt.q===v))return;_qT[id]=setTimeout(()=>{if(id==='fq'){flt.q=v;saveFlt();render()}else if(id==='wq'){wFlt.q=v;saveWFlt();renderW()}else if(id==='pq'){pFlt.q=v;savePFlt();renderP()}else if(id==='gq'){gFlt.q=v;saveGFlt();renderG()}else if(id==='kq'){kFlt.q=v;saveKFlt();renderK()}else{sFlt.q=v;saveSFlt();renderS()}},150)});
$('#catsel').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='cnew'){openMgr('a');return}newCat=+b.dataset.c;paintCatSel()};
$('#wcatsel').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='wnew'){openMgr('w');return}wNewCat=+b.dataset.c;paintWCatSel()};
$('#scatsel').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='snew'){openMgr('s');return}sNewCat=+b.dataset.c;paintSCatSel()};
$('#scx').onclick=()=>closeSh('#sc');
$('#wchips').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mgrb')){openMgr('w');return}wFlt.cat=b.dataset.c===''?'':+b.dataset.c;saveWFlt();paintWChips();renderW()};
$('#schips').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mgrb')){openMgr('s');return}sFlt.cat=b.dataset.c===''?'':+b.dataset.c;saveSFlt();paintSChips();renderS()};
$('#wclr').onclick=()=>{wFlt={q:'',cat:''};saveWFlt();$('#wq').value='';paintWChips();renderW()};
$('#sclr').onclick=()=>{sFlt={q:'',cat:''};saveSFlt();$('#sq').value='';paintSChips();renderS()};
$('#pcatsel').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='pnew'){openMgr('p');return}pNewCat=+b.dataset.c;paintPCatSel()};
$('#pchips').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mgrb')){openMgr('p');return}pFlt.cat=b.dataset.c===''?'':+b.dataset.c;savePFlt();paintPChips();renderP()};
$('#pclr').onclick=()=>{pFlt={q:'',cat:''};savePFlt();$('#pq').value='';paintPChips();renderP()};
function pCard(i){const c=catByIdP(i.cat);return '<div class="card sc" data-id="'+i.id+'"><div class="hd"><span class="av" style="font-size:15px">📈</span><div class="idn"><span class="sTitle">'+esc(i.title||'بدون عنوان')+'</span>'+(c?'<span class="catpill" style="color:'+c.color+';border-color:'+c.color+'66">'+esc(c.name)+'</span>':'')+'</div><button class="x ed" data-id="'+i.id+'">✎</button><button class="x" data-id="'+i.id+'">🗑</button></div>'+(i.text?'<div class="stext">'+esc(i.text)+'</div>':'')+'</div>'}
function renderP(){const box=$('#plist');if(!box)return;if(!pitems.length){box.innerHTML='<div class="msg">پوزیشنی ثبت نشده.<br>با دکمه‌ی پایین اولین پوزیشن را بنویس.</div>';return}const q=pFlt.q.toUpperCase();const vis=pitems.filter(i=>(pFlt.cat===''||(i.cat||0)===pFlt.cat)&&(!q||String(i.title||'').toUpperCase().includes(q)||String(i.text||'').toUpperCase().includes(q)));box.innerHTML=vis.length?vis.slice().reverse().map(pCard).join(''):'<div class="msg">با این فیلترها موردی پیدا نشد.</div>'}
async function loadP(){try{const d=await api('GET','/api/positions');pitems=Array.isArray(d.items)?d.items:[];if(Array.isArray(d.cats))pcats=d.cats;paintPChips();renderP();_pAt=Date.now()}catch(e){if(!String(e.message).startsWith('401'))$('#plist').innerHTML='<div class="msg">خطا در دریافت اطلاعات</div>'}}
$('#plist').onclick=async e=>{const b=e.target.closest('.x');if(!b)return;const id=+b.dataset.id,i=pitems.find(x=>x.id===id);if(!i)return;
 if(b.classList.contains('ed')){pEid=id;$('#fpot').textContent='ویرایش پوزیشن';$('#ptitle').value=i.title||'';$('#ptext').value=i.text||'';pNewCat=i.cat||0;paintPCatSel();$('#fpo').classList.add('on');return}
 ask('این مورد حذف بشه؟',async()=>{try{await api('DELETE','/api/positions/'+id);await loadP()}catch(x){say('حذف نشد ('+x.message+')')}})};
$('#pgo').onclick=async()=>{const title=$('#ptitle').value.trim(),text=$('#ptext').value.trim();if(!title&&!text){say('چیزی برای ذخیره نیست');return}$('#pgo').disabled=true;try{await api(pEid?'PUT':'POST',pEid?'/api/positions/'+pEid:'/api/positions',{title,text,cat:pNewCat});closeSh('#fpo');await loadP();say('ذخیره شد ✓')}catch(e){say('ثبت نشد ('+e.message+')')}$('#pgo').disabled=false};
$('#fpox').onclick=()=>closeSh('#fpo');
$('#gcatsel').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='gnew'){openMgr('g');return}gNewCat=+b.dataset.c;paintGCatSel()};
$('#gchips').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mgrb')){openMgr('g');return}gFlt.cat=b.dataset.c===''?'':+b.dataset.c;saveGFlt();paintGChips();renderG()};
$('#gclr').onclick=()=>{gFlt={q:'',cat:''};saveGFlt();$('#gq').value='';paintGChips();renderG()};
function gCard(i){const c=catByIdG(i.cat);return '<div class="card sc" data-id="'+i.id+'"><div class="hd"><span class="av" style="font-size:15px">🧭</span><div class="idn"><span class="sTitle">'+esc(i.title||'بدون عنوان')+'</span>'+(c?'<span class="catpill" style="color:'+c.color+';border-color:'+c.color+'66">'+esc(c.name)+'</span>':'')+'</div><button class="x ed" data-id="'+i.id+'">✎</button><button class="x" data-id="'+i.id+'">🗑</button></div>'+(i.text?'<div class="stext">'+esc(i.text)+'</div>':'')+'</div>'}
function renderG(){const box=$('#glist');if(!box)return;if(!gitems.length){box.innerHTML='<div class="msg">استراتژی‌ای ثبت نشده.<br>با دکمه‌ی پایین اولین استراتژی را بنویس.</div>';return}const q=gFlt.q.toUpperCase();const vis=gitems.filter(i=>(gFlt.cat===''||(i.cat||0)===gFlt.cat)&&(!q||String(i.title||'').toUpperCase().includes(q)||String(i.text||'').toUpperCase().includes(q)));box.innerHTML=vis.length?vis.slice().reverse().map(gCard).join(''):'<div class="msg">با این فیلترها موردی پیدا نشد.</div>'}
async function loadG(){try{const d=await api('GET','/api/strategies');gitems=Array.isArray(d.items)?d.items:[];if(Array.isArray(d.cats))gcats=d.cats;paintGChips();renderG();_gAt=Date.now()}catch(e){if(!String(e.message).startsWith('401'))$('#glist').innerHTML='<div class="msg">خطا در دریافت اطلاعات</div>'}}
$('#glist').onclick=async e=>{const b=e.target.closest('.x');if(!b)return;const id=+b.dataset.id,i=gitems.find(x=>x.id===id);if(!i)return;
 if(b.classList.contains('ed')){gEid=id;$('#fgot').textContent='ویرایش استراتژی';$('#gtitle').value=i.title||'';$('#gtext').value=i.text||'';gNewCat=i.cat||0;paintGCatSel();$('#fgo').classList.add('on');return}
 ask('این مورد حذف بشه؟',async()=>{try{await api('DELETE','/api/strategies/'+id);await loadG()}catch(x){say('حذف نشد ('+x.message+')')}})};
$('#ggo').onclick=async()=>{const title=$('#gtitle').value.trim(),text=$('#gtext').value.trim();if(!title&&!text){say('چیزی برای ذخیره نیست');return}$('#ggo').disabled=true;try{await api(gEid?'PUT':'POST',gEid?'/api/strategies/'+gEid:'/api/strategies',{title,text,cat:gNewCat});closeSh('#fgo');await loadG();say('ذخیره شد ✓')}catch(e){say('ثبت نشد ('+e.message+')')}$('#ggo').disabled=false};
$('#fgox').onclick=()=>closeSh('#fgo');
$('#kcatsel').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='knew'){openMgr('k');return}kNewCat=+b.dataset.c;paintKCatSel()};
$('#kchips').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mgrb')){openMgr('k');return}kFlt.cat=b.dataset.c===''?'':+b.dataset.c;saveKFlt();paintKChips();renderK()};
$('#kclr').onclick=()=>{kFlt={q:'',cat:''};saveKFlt();$('#kq').value='';paintKChips();renderK()};
function kCard(i){const c=catByIdK(i.cat);return '<div class="card sc" data-id="'+i.id+'"><div class="hd"><span class="av" style="font-size:15px">✅</span><div class="idn"><span class="sTitle">'+esc(i.title||'بدون عنوان')+'</span>'+(c?'<span class="catpill" style="color:'+c.color+';border-color:'+c.color+'66">'+esc(c.name)+'</span>':'')+'</div><button class="x ed" data-id="'+i.id+'">✎</button><button class="x" data-id="'+i.id+'">🗑</button></div>'+(i.text?'<div class="stext">'+esc(i.text)+'</div>':'')+'</div>'}
function renderK(){const box=$('#klist');if(!box)return;if(!kitems.length){box.innerHTML='<div class="msg">تسکی ثبت نشده.<br>با دکمه‌ی پایین اولین ترید تسک را بنویس.</div>';return}const q=kFlt.q.toUpperCase();const vis=kitems.filter(i=>(kFlt.cat===''||(i.cat||0)===kFlt.cat)&&(!q||String(i.title||'').toUpperCase().includes(q)||String(i.text||'').toUpperCase().includes(q)));box.innerHTML=vis.length?vis.slice().reverse().map(kCard).join(''):'<div class="msg">با این فیلترها موردی پیدا نشد.</div>'}
async function loadK(){try{const d=await api('GET','/api/tasks');kitems=Array.isArray(d.items)?d.items:[];if(Array.isArray(d.cats))kcats=d.cats;paintKChips();renderK();_kAt=Date.now()}catch(e){if(!String(e.message).startsWith('401'))$('#klist').innerHTML='<div class="msg">خطا در دریافت اطلاعات</div>'}}
$('#klist').onclick=async e=>{const b=e.target.closest('.x');if(!b)return;const id=+b.dataset.id,i=kitems.find(x=>x.id===id);if(!i)return;
 if(b.classList.contains('ed')){kEid=id;$('#fkot').textContent='ویرایش تسک';$('#ktitle').value=i.title||'';$('#ktext').value=i.text||'';kNewCat=i.cat||0;paintKCatSel();$('#fko').classList.add('on');return}
 ask('این مورد حذف بشه؟',async()=>{try{await api('DELETE','/api/tasks/'+id);await loadK()}catch(x){say('حذف نشد ('+x.message+')')}})};
$('#kgo').onclick=async()=>{const title=$('#ktitle').value.trim(),text=$('#ktext').value.trim();if(!title&&!text){say('چیزی برای ذخیره نیست');return}$('#kgo').disabled=true;try{await api(kEid?'PUT':'POST',kEid?'/api/tasks/'+kEid:'/api/tasks',{title,text,cat:kNewCat});closeSh('#fko');await loadK();say('ذخیره شد ✓')}catch(e){say('ثبت نشد ('+e.message+')')}$('#kgo').disabled=false};
$('#fkox').onclick=()=>closeSh('#fko');
function wCard(i){const c=catByIdW(i.cat);return '<div class="card wl" data-id="'+i.id+'"><div class="hd"><span class="av">'+esc((i.coin||'?').slice(0,3))+'</span><div class="idn"><span class="coin">'+esc(i.coin||'')+'</span>'+(c?'<span class="catpill" style="color:'+c.color+';border-color:'+c.color+'66">'+esc(c.name)+'</span>':'')+'</div><button class="x ed" data-id="'+i.id+'">✎</button><button class="x" data-id="'+i.id+'">🗑</button></div>'+(i.note?'<div class="wnote">'+esc(i.note)+'</div>':'')+'</div>'}
function sCard(i){const c=catByIdS(i.cat);return '<div class="card sc" data-id="'+i.id+'"><div class="hd"><span class="av" style="font-size:15px">📜</span><div class="idn"><span class="sTitle">'+esc(i.title||'بدون عنوان')+'</span>'+(c?'<span class="catpill" style="color:'+c.color+';border-color:'+c.color+'66">'+esc(c.name)+'</span>':'')+'</div><button class="x ed" data-id="'+i.id+'">✎</button><button class="x" data-id="'+i.id+'">🗑</button></div>'+(i.text?'<div class="stext">'+esc(i.text)+'</div>':'')+'</div>'}
function renderW(){const box=$('#wlist');if(!box)return;if(!witems.length){box.innerHTML='<div class="msg">واچ‌لیست خالیه.<br>با دکمه‌ی پایین اولین واچلیست را بساز.</div>';return}const q=wFlt.q.toUpperCase();const vis=witems.filter(i=>(wFlt.cat===''||(i.cat||0)===wFlt.cat)&&(!q||(i.coin||'').toUpperCase().includes(q)||String(i.note||'').toUpperCase().includes(q)));box.innerHTML=vis.length?vis.map(wCard).join(''):'<div class="msg">با این فیلترها موردی پیدا نشد.</div>'}
function renderS(){const box=$('#slist');if(!box)return;if(!sitems.length){box.innerHTML='<div class="msg">سناریویی ثبت نشده.<br>با دکمه‌ی پایین اولین سناریو را بساز.</div>';return}const q=sFlt.q.toUpperCase();const vis=sitems.filter(i=>(sFlt.cat===''||(i.cat||0)===sFlt.cat)&&(!q||String(i.title||'').toUpperCase().includes(q)||String(i.text||'').toUpperCase().includes(q)));box.innerHTML=vis.length?vis.map(sCard).join(''):'<div class="msg">با این فیلترها موردی پیدا نشد.</div>'}
async function loadW(){try{const d=await api('GET','/api/watchlist');witems=Array.isArray(d.items)?d.items:[];if(Array.isArray(d.cats))wcats=d.cats;paintWChips();renderW();_wAt=Date.now()}catch(e){if(!String(e.message).startsWith('401'))$('#wlist').innerHTML='<div class="msg">خطا در دریافت اطلاعات</div>'}}
async function loadS(){try{const d=await api('GET','/api/scenario');sitems=Array.isArray(d.items)?d.items:[];if(Array.isArray(d.cats))scats=d.cats;paintSChips();renderS();_sAt=Date.now()}catch(e){if(!String(e.message).startsWith('401'))$('#slist').innerHTML='<div class="msg">خطا در دریافت اطلاعات</div>'}}
$('#wlist').onclick=async e=>{const b=e.target.closest('.x');if(!b)return;const id=+b.dataset.id,i=witems.find(x=>x.id===id);if(!i)return;
 if(b.classList.contains('ed')){wEid=id;$('#fwlt').textContent='ویرایش واچلیست';$('#wcoin').value=i.coin;$('#wnote').value=i.note||'';wNewCat=i.cat||0;paintWCatSel();$('#fwl').classList.add('on');growW();return}
 ask('این مورد حذف بشه؟',async()=>{try{await api('DELETE','/api/watchlist/'+id);await loadW()}catch(x){say('حذف نشد ('+x.message+')')}})};
$('#slist').onclick=async e=>{const b=e.target.closest('.x');if(!b)return;const id=+b.dataset.id,i=sitems.find(x=>x.id===id);if(!i)return;
 if(b.classList.contains('ed')){sEid=id;$('#fsct').textContent='ویرایش سناریو';$('#stitle').value=i.title||'';$('#stext').value=i.text||'';sNewCat=i.cat||0;paintSCatSel();$('#fsc').classList.add('on');return}
 ask('این مورد حذف بشه؟',async()=>{try{await api('DELETE','/api/scenario/'+id);await loadS()}catch(x){say('حذف نشد ('+x.message+')')}})};
$('#wgo').onclick=async()=>{const name=$('#wcoin').value.trim();if(!name){say('اول نام واچلیست را وارد کن');return}$('#wgo').disabled=true;try{await api(wEid?'PUT':'POST',wEid?'/api/watchlist/'+wEid:'/api/watchlist',{coin:name,note:$('#wnote').value.trim(),cat:wNewCat});closeSh('#fwl');await loadW()}catch(e){say('ثبت نشد ('+e.message+')')}$('#wgo').disabled=false};
$('#sgo').onclick=async()=>{const title=$('#stitle').value.trim(),text=$('#stext').value.trim();if(!title&&!text){say('چیزی برای ذخیره نیست');return}$('#sgo').disabled=true;try{await api(sEid?'PUT':'POST',sEid?'/api/scenario/'+sEid:'/api/scenario',{title,text,cat:sNewCat});closeSh('#fsc');await loadS();say('ذخیره شد ✓')}catch(e){say('ثبت نشد ('+e.message+')')}$('#sgo').disabled=false};
$('#fwlx').onclick=()=>closeSh('#fwl');$('#fscx').onclick=()=>closeSh('#fsc');
$('#csw').onclick=e=>{const b=e.target.closest('button');if(!b)return;newCol=b.dataset.col;paintSw()};
$('#cadd').onclick=async()=>{const name=$('#cnn').value.trim();if(!name){say('نام دسته را وارد کن');return}$('#cadd').disabled=true;try{const r=await api('POST',mgrApi(),{name,color:newCol});mgrCats().push(r.cat);$('#cnn').value='';afterCatChange()}catch(x){say(/duplicate/.test(x.message)?'دسته‌ای با این نام هست':'ساخته نشد ('+x.message+')')}$('#cadd').disabled=false};
function afterCatChange(){paintMgr();paintSw();paintChips();paintCatSel();paintWChips();paintWCatSel();paintSChips();paintSCatSel();paintPChips();paintPCatSel();paintGChips();paintGCatSel();paintKChips();paintKCatSel();render();renderW();renderS();renderP();renderG();renderK();}
$('#catlist').onclick=async e=>{const row=e.target.closest('.crow');if(!row)return;const id=+row.dataset.id,c=mgrCats().find(x=>x.id===id);if(!c)return;
 if(e.target.classList.contains('cdot')){const i=PALETTE.indexOf(String(c.color).toUpperCase());const nc=PALETTE[(i+1)%PALETTE.length]||PALETTE[0];try{const r=await api('PUT',mgrApi()+'/'+id,{name:c.name,color:nc});if(r.cat)Object.assign(c,r.cat);afterCatChange()}catch(x){say('ذخیره نشد ('+x.message+')')}return}
 if(e.target.classList.contains('cdel'))ask(mgrKind==='a'?'این دسته حذف بشه؟ آلارم‌های داخلش بدون دسته می‌شن.':'این دسته حذف بشه؟ آیتم‌های داخلش بدون دسته می‌شن.',async()=>{try{await api('DELETE',mgrApi()+'/'+id);const arr=mgrCats();arr.splice(arr.findIndex(x=>x.id===id),1);if(mgrKind==='a')alerts.forEach(a=>{if((a.cat||0)===id)a.cat=0});else if(mgrKind==='w')witems.forEach(a=>{if((a.cat||0)===id)a.cat=0});else if(mgrKind==='p')pitems.forEach(a=>{if((a.cat||0)===id)a.cat=0});else if(mgrKind==='g')gitems.forEach(a=>{if((a.cat||0)===id)a.cat=0});else if(mgrKind==='k')kitems.forEach(a=>{if((a.cat||0)===id)a.cat=0});else sitems.forEach(a=>{if((a.cat||0)===id)a.cat=0});if(flt.cat===id){flt.cat='';saveFlt()}if(wFlt.cat===id){wFlt.cat='';saveWFlt()}if(sFlt.cat===id){sFlt.cat='';saveSFlt()}if(pFlt.cat===id){pFlt.cat='';savePFlt()}if(gFlt.cat===id){gFlt.cat='';saveGFlt()}if(kFlt.cat===id){kFlt.cat='';saveKFlt()}afterCatChange();say('حذف شد ✓')}catch(x){say('حذف نشد ('+x.message+')')}})};
$('#catlist').onchange=async e=>{const row=e.target.closest('.crow');if(!row||e.target.tagName!=='INPUT')return;const id=+row.dataset.id,c=mgrCats().find(x=>x.id===id);if(!c)return;const name=e.target.value.trim();if(!name||name===c.name){e.target.value=c.name;return}try{const r=await api('PUT',mgrApi()+'/'+id,{name,color:c.color});if(r.cat)Object.assign(c,r.cat);paintChips();paintWChips();paintSChips();paintPChips();paintGChips();paintKChips();render();renderW();renderS();renderP();renderG();renderK();}catch(x){say('ذخیره نشد ('+x.message+')');e.target.value=c.name}};
$('#go').onclick=async()=>{
 const targets=[...document.querySelectorAll('.tr')].map(r=>({price:parseFloat(r.querySelector('.tp').value.replace(/,/g,'')),note:r.querySelector('.tn').value})).filter(t=>t.price>0);
 fixCoin();const coin=$('#coin').value.trim();if(!coin||!targets.length){say('کوین و حداقل یک قیمت لازمه');return}
 const ch=[$('#c-tg').checked&&'tg',$('#c-em').checked&&'email'].filter(Boolean);if(!ch.length){say('حداقل یک روش اعلان را انتخاب کن');return}
 $('#go').disabled=true;
 try{await api(eid?'PUT':'POST',eid?'/api/alerts/'+eid:'/api/alerts',{coin,direction:dir,entry:parseFloat($('#entry').value.replace(/,/g,'')),targets,ch,cat:newCat});closeSh('#sh');await load()}catch(e){say('ثبت نشد ('+e.message+')')}
 $('#go').disabled=false};
function show(t){tab=t;['a','s','p','g','k','w','c'].forEach(x=>$('#p-'+x).hidden=x!==t);document.querySelectorAll('.tb button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
 if(t!=='a'&&selOn)exitSel();
 $('#fab').style.display=t==='c'?'none':'';$('#fab').textContent=t==='a'?'＋ آلارم جدید':t==='s'?'＋ سناریو جدید':t==='p'?'＋ پوزیشن جدید':t==='g'?'＋ استراتژی جدید':t==='k'?'＋ تسک جدید':'＋ واچلیست جدید';
 if(t==='s'){if(Date.now()-_sAt>30000)loadS()}else if(t==='p'){if(Date.now()-_pAt>30000)loadP()}else if(t==='g'){if(Date.now()-_gAt>30000)loadG()}else if(t==='k'){if(Date.now()-_kAt>30000)loadK()}else  if(t==='w'){if(Date.now()-_wAt>30000)loadW()}else if(t==='a'&&Date.now()-_aAt>20000)refresh()}
const TABS='aspgkwc';
const STK=new Set(${JSON.stringify([...STOCK_TICKERS])});
function fixCoin(){const i=$('#coin');let v=i.value.toUpperCase().replace(/[\s\/_-]/g,'');const m=/^([A-Z0-9]{1,12}?)(?:USDT)?(\.P)?$/.exec(v);if(m)v=m[1]+((m[2]||STK.has(m[1]))?'USDT.P':'');i.value=v}
$('#coin').addEventListener('change',fixCoin);$('#coin').addEventListener('blur',fixCoin);
document.querySelectorAll('.tb button').forEach(b=>b.onclick=()=>{show(b.dataset.t);try{history.pushState(null,'','#'+b.dataset.t)}catch(e){}try{localStorage.setItem('tab',b.dataset.t)}catch(e){}scrollTo(0,0)});
addEventListener('popstate',()=>{const t=location.hash.slice(1);show(t.length===1&&TABS.includes(t)?t:'a')});
if('serviceWorker' in navigator)addEventListener('load',()=>{try{navigator.serviceWorker.register('/sw.js').catch(()=>{})}catch(e){}});
const cv=id=>{const v=$(id).value.replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/,/g,'').trim();if(v==='')return null;const n=parseFloat(v);return isNaN(n)?null:n};
const cf=(n,d)=>isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:d||2}):'—';
const pf=n=>!isFinite(n)?'—':n.toLocaleString('en-US',{maximumFractionDigits:n>=1000?2:n>=1?4:8});
function calc(){
 const cap=cv('#c-cap'),rk=cv('#c-risk'),lv=cv('#c-lev'),en=cv('#c-en'),sp=cv('#c-st'),tp=cv('#c-tp'),fo=cv('#c-fo')||0,fc=cv('#c-fc')||0;let err='',sl=null,dir='';
 const set=(id,v)=>{$(id).textContent=v};
 const clear=(bd)=>{set('#c-val','—');$('#c-val').classList.remove('on');['#c-not','#c-qty','#c-rsk','#c-rr','#c-tpd','#c-liq'].forEach(i=>set(i,'—'));set('#c-dir','—');set('#c-sl',sl!=null?cf(sl,4)+'%':'—');$('#c-rr').className='';$('#c-lad').innerHTML='';$('#c-bd').innerHTML=bd};
 if(cap!==null&&cap<=0)err='سرمایه باید بزرگ‌تر از صفر باشد.';
 else if(rk!==null&&(rk<=0||rk>100))err='درصد ریسک باید بین 0 و 100 باشد.';
 else if(lv!==null&&lv<=0)err='لوریج باید بزرگ‌تر از صفر باشد.';
 else if(en!==null&&en<=0)err='قیمت ورود باید بزرگ‌تر از صفر باشد.';
 else if(tp!==null&&tp<=0)err='قیمت حد سود باید بزرگ‌تر از صفر باشد.';
 else if(fo<0||fc<0)err='کارمزد نمی‌تواند منفی باشد.';
 else if(en!==null&&sp!==null){if(sp===en)err='حد ضرر نمی‌تواند برابر قیمت ورود باشد.';else{sl=Math.abs(en-sp)/en*100;dir=sp<en?'long':'short';if(tp!==null&&((dir==='long'&&tp<=en)||(dir==='short'&&tp>=en)))err='حد سود باید در سمت سود باشد (بالاتر از ورود برای Long، پایین‌تر برای Short).'}}
 $('#c-msg').textContent=err;
 if(err||[cap,rk,lv,sl].some(v=>v===null)){clear(err?'':'مقادیر را وارد کنید…');return}
 const risk$=cap*rk/100,totalFeePct=(fo+fc)/100,size=risk$/(lv*(sl/100+totalFeePct)),not=size*lv,qty=not/en;
 const tpd=tp!==null?Math.abs(tp-en)/en*100:null,fees=not*(fo+fc)/100,reward=tpd!==null?not*tpd/100-fees:null,rr=reward!==null&&reward>0?reward/risk$:null;
 const liq=lv>1||dir==='short'?(dir==='long'?en*(1-1/lv):en*(1+1/lv)):null;
 set('#c-val',cf(size));$('#c-val').classList.add('on');set('#c-not','$'+cf(not));set('#c-qty',pf(qty));set('#c-rsk','-$'+cf(risk$));
 set('#c-rr',rr!==null?'1 : '+cf(rr,2):'—');$('#c-rr').className=rr===null?'':(rr>=2?'good':rr<1?'bad':'');
 set('#c-dir',dir==='long'?'Long':'Short');set('#c-sl',cf(sl,4)+'%');set('#c-tpd',tpd!==null?cf(tpd,4)+'%':'—');set('#c-liq',liq!==null?'$'+pf(liq):'—');
 const pts=[['sl',sp],['en',en]];if(tp!==null)pts.push(['tp',tp]);if(liq!==null)pts.push(['lq',liq]);
 const lo=Math.min(...pts.map(p=>p[1])),hi=Math.max(...pts.map(p=>p[1])),pos=v=>hi===lo?50:6+(v-lo)/(hi-lo)*88;
 let h='';const pe=pos(en),ps=pos(sp);h+='<i class="seg2" style="background:var(--short);left:'+Math.min(pe,ps)+'%;width:'+Math.abs(pe-ps)+'%"></i>';
 if(tp!==null){const pt=pos(tp);h+='<i class="seg2" style="background:var(--long);left:'+Math.min(pe,pt)+'%;width:'+Math.abs(pe-pt)+'%"></i>'}
 const lab={sl:'SL',en:'Entry',tp:'TP',lq:'Liq'};
 pts.forEach(([k,v])=>{let side=k==='en'||k==='lq'?'b':'t';if(k==='lq'&&Math.abs(pos(v)-pe)<20)side=Math.abs(pos(v)-ps)<20?'':'t';if(side)h+='<div class="mk2 '+k+'" style="left:'+pos(v)+'%"><i></i><em class="'+side+'">'+lab[k]+' '+pf(v)+'</em></div>';else h+='<div class="mk2 '+k+'" style="left:'+pos(v)+'%"><i></i></div>'});
 $('#c-lad').innerHTML=h;
 let m=size>cap?'سایز پوزیشن ('+cf(size)+' $) بیشتر از سرمایه است.':'';
 if(!m&&liq!==null&&((dir==='long'&&sp<=liq)||(dir==='short'&&sp>=liq)))m='حد ضرر بعد از قیمت لیکویید قرار دارد؛ لوریج را کم کن.';
 $('#c-msg').textContent=m;
 $('#c-bd').innerHTML='Risk = '+cf(cap)+' × '+rk+'% = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(risk$)+'<br>Margin = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(risk$)+' ÷ ('+lv+' × ('+cf(sl,4)+'% + '+cf(totalFeePct*100,4)+'% fees)) = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(size)+'<br>Notional = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(size)+' × '+lv+' = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(not)+'<br>Qty = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(not)+' ÷ '+pf(en)+' = '+pf(qty)+(reward!==null?'<br>Reward = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(not)+' × '+cf(tpd,4)+'%'+(fees?' − fees 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(fees):'')+' = 
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};+cf(reward):'');
}
document.addEventListener('input',e=>{if(e.target.closest('#p-c'))calc()});
(function(){
 let d=null,ly=0,raf=0;
 const L=$('#list');
 let lx=0;const place=y=>{const cs=[...L.querySelectorAll('.card:not(.drag)')];if(!cs.length)return;const R=cs.map(o=>o.getBoundingClientRect()),multi=new Set(R.map(r=>Math.round(r.left))).size>1;let bi=0,bd=1e18;R.forEach((r,i)=>{const dx=lx-(r.left+r.width/2),dy=y-(r.top+r.height/2),dd=dx*dx+dy*dy;if(dd<bd){bd=dd;bi=i}});const r=R[bi],before=multi?(lx>r.left+r.width/2):(y<r.top+r.height/2);before?L.insertBefore(d.ph,cs[bi]):cs[bi].after(d.ph)};
 const loop=()=>{if(!d)return;if(ly<90)scrollBy(0,-14);else if(ly>innerHeight-90)scrollBy(0,14);place(ly);raf=requestAnimationFrame(loop)};
 L.addEventListener('pointerdown',e=>{const h=e.target.closest('.dh');if(!h)return;const c=h.closest('.card');if(L.querySelectorAll('.card').length<2)return;e.preventDefault();
  const r=c.getBoundingClientRect();d={c,off:e.clientY-r.top,ox:e.clientX-r.left,ph:document.createElement('div')};
  d.ph.className='ph';d.ph.style.height=r.height+'px';c.after(d.ph);
  c.classList.add('drag');c.style.cssText='position:fixed;z-index:30;width:'+r.width+'px;left:'+r.left+'px;top:'+r.top+'px';
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  document.body.style.userSelect='none';ly=e.clientY;lx=e.clientX;raf=requestAnimationFrame(loop)});
 document.addEventListener('pointermove',e=>{if(!d)return;ly=e.clientY;lx=e.clientX;d.c.style.top=(e.clientY-d.off)+'px';d.c.style.left=(e.clientX-d.ox)+'px';place(ly)});
 const end=ok=>{if(!d)return;cancelAnimationFrame(raf);const c=d.c;d.ph.replaceWith(c);c.classList.remove('drag');c.style.cssText='';d=null;document.body.style.userSelect='';
  if(!ok){render();return}
  if(fltOn()){say('برای جابه‌جایی، اول فیلترها را پاک کن');render();return}
  const ids=[...L.querySelectorAll('.card')].map(x=>+x.dataset.id),m=new Map(alerts.map(a=>[a.id,a]));alerts=ids.map(i=>m.get(i)).filter(Boolean);
  api('POST','/api/alerts/reorder',{ids}).catch(()=>{say('جابه‌جایی ذخیره نشد');load()})};
 document.addEventListener('pointerup',()=>end(true));document.addEventListener('pointercancel',()=>end(false));
})();
let st={email:'',verified:false,provider:false};
function paintSettings(){const c=$('#c-em');c.disabled=!st.verified;if(!st.verified)c.checked=false;$('#c-emh').textContent=st.verified?'':'(اول ایمیل را در ⚙️ تنظیمات تایید کن)';
 const e=$('#emst');e.className='st '+(st.verified?'ok':'bad');e.textContent=st.verified?'✓ ایمیل تایید شده: '+st.email:(st.provider?'ایمیلی تایید نشده':'⚠️ سرویس ایمیل تنظیم نشده');$('#emrm').hidden=!st.verified}
async function loadSettings(s0){try{st=s0||await api('GET','/api/settings')}catch(e){}paintSettings()}
$('#gear').onclick=()=>{setSP('n');if(Date.now()-_setAt>45000){_setAt=Date.now();loadSettings();loadUser();loadTg()}$('#ss').classList.add('on')};
$('#ssx').onclick=()=>closeSh('#ss');
$('#tbtn').onclick=()=>{let m='system';try{m=localStorage.getItem('theme')||'system'}catch(e){}const nx=m==='system'?'light':m==='light'?'dark':'system';try{localStorage.setItem('theme',nx)}catch(e){}themeFx();applyTheme()};
$('#emreq').onclick=async()=>{const em=$('#em').value.trim();if(!em){say('ایمیل را وارد کن');return}$('#emreq').disabled=true;try{await api('POST','/api/email/request',{email:em});$('#emcode').hidden=false;say('کد تایید به ایمیل فرستاده شد (۱۰ دقیقه اعتبار دارد)')}catch(e){say('ارسال نشد ('+e.message+')')}$('#emreq').disabled=false};
$('#emver').onclick=async()=>{try{await api('POST','/api/email/verify',{code:$('#emc').value.trim()});$('#emcode').hidden=true;$('#emc').value='';await loadSettings();say('ایمیل تایید شد ✓')}catch(e){say('تایید نشد ('+e.message+')')}};
$('#emrm').onclick=()=>ask('ایمیل حذف بشه؟ آلارم‌هایی که ایمیل دارن فقط از تلگرام اعلان می‌گیرن.',async()=>{await api('POST','/api/email/remove');await loadSettings()});
$('#tst').onclick=async()=>{const b=$('#tst');b.disabled=true;try{const r=await api('POST','/api/test-notify');const f=(n,x)=>n+': '+(x.skipped?'— (ایمیل تایید نشده)':x.ok?'✓ فرستاده شد':'✗ '+x.error);say(f('تلگرام',r.tg)+'\n'+f('ایمیل',r.email))}catch(e){say('تست انجام نشد ('+e.message+')')}b.disabled=false};
$('#out').onclick=async()=>{try{await api('POST','/api/logout')}catch(e){}try{localStorage.removeItem('acache')}catch(e){}location.reload()};
let am='login',codeSent=false,lgOn=false,mailOk=true;
const EM=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setMode(m){am=m;codeSent=false;const L=m==='login',R=m==='register',F=m==='reset';
 $('#lgt').textContent=L?'ورود به پنل':R?'ثبت‌نام — ساخت حساب':'بازیابی رمز';
 $('#f-u').hidden=F;$('#f-p2').hidden=L;$('#f-c').hidden=true;$('#f-k').hidden=!(R&&!mailOk);
 $('#lpl').textContent=L?'رمز عبور':'رمز جدید (حداقل ۸ کاراکتر)';
 $('#pw').autocomplete=L?'current-password':'new-password';
 $('#lgo').textContent=L?'ورود':'دریافت کد در ایمیل';
 $('#lsw').textContent=L?'رمز را فراموش کردم':'بازگشت به ورود';$('#lsw').hidden=R;
 $('#lge').textContent='';$('#lge').style.color=''}
async function showLogin(){if(lgOn)return;lgOn=true;let r={registered:true,mail:true};try{r=await(await fetch('/api/auth/state',{credentials:'same-origin'})).json()}catch(e){}
 mailOk=r.mail!==false;setMode(r.registered?'login':'register');$('#lg').classList.add('on');setTimeout(()=>$('#lu').focus(),50)}
function done(){['#pw','#pw2','#lc','#lkey'].forEach(i=>$(i).value='');lgOn=false;closeSh('#lg');$('#lgo').disabled=false;load();checkLegacy()}
async function doAuth(){const b=$('#lgo'),u=$('#lu').value.trim(),pw=$('#pw').value,e=$('#lge');e.textContent='';e.style.color='';
 const bad=m=>{e.textContent=m;b.disabled=false};b.disabled=true;
 try{
  if(am==='login'){await api('POST','/api/login',{email:u,password:pw});return done()}
  if(!codeSent){
   if(pw.length<8)return bad('رمز باید حداقل ۸ کاراکتر باشد.');
   if(pw!==$('#pw2').value)return bad('تکرار رمز یکسان نیست.');
   if(am==='register'&&!EM.test(u))return bad('ایمیل معتبر وارد کن.');
   if(am==='register'&&!mailOk&&!$('#lkey').value.trim())return bad('کلید API سرویس ایمیل را وارد کن.');
   await api('POST','/api/auth/code',{purpose:am,email:u,password:pw,lang:LANG,resendKey:$('#lkey').value.trim(),from:$('#lfrom').value.trim()});
   codeSent=true;$('#f-c').hidden=false;b.textContent='تایید و ادامه';e.textContent='کد ۶ رقمی به ایمیلت فرستاده شد (پوشه‌ی اسپم را هم ببین).';e.style.color='var(--long)';$('#lc').focus();b.disabled=false;return}
  await api('POST','/api/auth/confirm',{code:$('#lc').value.trim()});done()
 }catch(x){const m=String(x.message);bad(m.includes('wrong password')?'ایمیل یا رمز اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('not allowed')?'این ایمیل اجازه‌ی ثبت‌نام ندارد.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('429')?'تلاش زیاد؛ کمی بعد دوباره امتحان کن.':'خطا ('+m+')')}}
$('#lang').textContent=LANG==='en'?'فا':'EN';$('#lgl').textContent=LANG==='en'?'فارسی':'English';$('#lang').onclick=$('#lgl').onclick=()=>setLang(LANG==='en'?'fa':'en');
$('#lgo').onclick=doAuth;$('#lsw').onclick=()=>setMode(am==='login'?'reset':'login');
['lu','pw','pw2','lc'].forEach(id=>$('#'+id).addEventListener('keydown',e=>{if(e.key==='Enter')doAuth()}));
async function loadUser(){try{const r=await api('GET','/api/auth/state');$('#acu').textContent=r.user;$('#aleg').hidden=!r.legacy;$('#akey').hidden=r.mail!==false}catch(e){}}
let aemSent=false;
$('#aes').onclick=async()=>{const b=$('#aes'),em=$('#ae').value.trim();b.disabled=true;
 try{
  if(!aemSent){
   if(!EM.test(em)){say('ایمیل معتبر وارد کن.');return}
   if(!$('#ac').value){say('رمز فعلی را وارد کن.');return}
   await api('POST','/api/auth/code',{purpose:'email',email:em,current:$('#ac').value,lang:LANG,resendKey:$('#akey').value.trim(),from:''});
   aemSent=true;$('#acode').hidden=false;b.textContent='تایید ایمیل';say('کد به ایمیل جدید فرستاده شد (اسپم را هم ببین).')
  }else{
   await api('POST','/api/auth/confirm',{code:$('#acode').value.trim()});
   aemSent=false;$('#acode').hidden=true;$('#acode').value='';$('#ae').value='';$('#ac').value='';b.textContent='ارسال کد به ایمیل جدید';say('ایمیل ثبت شد ✓');loadUser()
  }
 }catch(e){const m=String(e.message);say(m.includes('wrong password')?'رمز فعلی اشتباه است.':m.includes('wrong code')?'کد اشتباه است.':m.includes('key required')?'کلید API سرویس ایمیل را وارد کن.':m.includes('not allowed')?'این ایمیل مجاز نیست.':m.includes('same email')?'این همان ایمیل فعلی است.':'انجام نشد ('+m+')')}
 finally{b.disabled=false}};
function setSP(p){document.querySelectorAll('#sst button').forEach(b=>b.classList.toggle('on',b.dataset.p===p));document.querySelectorAll('#ss .sp').forEach(x=>x.classList.toggle('on',x.dataset.p===p))}
document.querySelectorAll('#sst button').forEach(b=>b.onclick=()=>setSP(b.dataset.p));
async function checkLegacy(){try{const r=await api('GET','/api/auth/state');if(r.loggedIn)syncLang();if(r.loggedIn&&r.legacy){setSP('a');$('#ss').classList.add('on');loadUser();loadTg();loadSettings();say('حساب تو هنوز با نام کاربری ساخته شده. لطفاً در بخش «حساب» یک ایمیل ثبت کن.')}}catch(e){}}
$('#acs').onclick=async()=>{if($('#ap').value.length<8){say('رمز جدید باید حداقل ۸ کاراکتر باشد.');return}try{await api('POST','/api/auth/change',{current:$('#ac').value,password:$('#ap').value});['#ac','#ap'].forEach(i=>$(i).value='');say('رمز تغییر کرد ✓');}catch(e){say(String(e.message).includes('wrong')?'رمز فعلی اشتباه است.':'ذخیره نشد ('+e.message+')')}};
let tgs={};
function paintTg(){const e=$('#tgst');e.className='st '+(tgs.connected?'ok':'bad');
 e.textContent=tgs.connected?'✓ متصل: @'+tgs.bot:(tgs.hasToken?'ربات @'+tgs.bot+' ثبت شد — منتظر اتصال چت':(tgs.viaEnv?'از تنظیمات ورکر استفاده می‌شود (برای تغییر، توکن جدید بده)':'ربات متصل نیست'));
 $('#tgstep').hidden=!(tgs.hasToken&&!tgs.connected);if(tgs.connected)$('#tgpick').innerHTML='';$('#tglink').href=tgs.link||'#';$('#tgoff').hidden=!tgs.hasToken}
async function loadTg(){try{tgs=await api('GET','/api/tg')}catch(e){}paintTg()}
$('#tgset').onclick=async()=>{const v=$('#tgt').value.trim();if(!v){say('توکن ربات را وارد کن');return}try{tgs=await api('POST','/api/tg/token',{token:v});$('#tgt').value='';paintTg();if(tgs.wh)say('یک Webhook قدیمی روی این ربات بود و حذف شد. حالا لینک را بزن و در تلگرام Start را (دوباره) بزن.')}catch(e){say(/invalid|rejected/.test(e.message)?'توکن معتبر نیست.':'ثبت نشد ('+e.message+')')}};
$('#tgdet').onclick=async()=>{try{const r=await api('POST','/api/tg/detect');tgs=r;paintTg();
 if(r.pick&&r.pick.length){$('#tgpick').innerHTML='<div class="st" style="margin:6px 0">این چت‌ها به ربات پیام داده‌اند. چت خودت را انتخاب کن:</div>'+r.pick.map(c=>'<button class="lk" style="display:block" data-c="'+esc(c.id)+'">'+esc(c.name)+(c.username?' (@'+esc(c.username)+')':'')+'</button>').join('');return}
 say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}
 catch(e){const m=String(e.message);say(m.includes('404')?'هنوز پیامی در ربات ندیدم. در تلگرام به ربات @'+tgs.bot+' یک پیام بفرست (مثلاً /start) و دوباره «تشخیص» را بزن.':/other getUpdates|Conflict/i.test(m)?'یک برنامه‌ی دیگر (مثلاً ربات قدیمی روی سرور) هم‌زمان با همین توکن پیام می‌گیرد. آن را خاموش کن یا برای پنل یک ربات جدید بساز.':'تشخیص انجام نشد ('+m+')')}};
$('#tgpick').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{tgs=await api('POST','/api/tg/choose',{chat:b.dataset.c});paintTg();say('ربات وصل شد ✓ (یک پیام تایید برایت فرستاده شد)')}catch(x){say('انجام نشد ('+x.message+')')}};
$('#tgoff').onclick=()=>ask('ربات قطع بشه؟ تا وصل مجدد، اعلان تلگرامی نمی‌آید.',async()=>{tgs=await api('POST','/api/tg/disconnect');paintTg()});
async function loadStatus(r0){try{const r=r0||await api('GET','/api/status'),el=$('#st');
 if(!r.t){el.className='st bad';el.textContent='⚠️ هنوز هیچ چک خودکاری ثبت نشده — Cron Trigger ورکر را چک کن (Settings → Triggers → Cron Triggers)';return}
 const m=Math.round((r.now-r.t)/60000);
 if(m>12){el.className='st bad';el.textContent='⚠️ آخرین چک خودکار '+m+' دقیقه پیش بوده — Cron Trigger را چک کن'}
 else if(!r.e&&!r.m){el.className='st ok';el.textContent='✅ همه چیز سالم است — '+(r.p?r.p+' آلارم فعال زیر نظر است':'آلارم فعالی نیست')+' · آخرین چک: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش';if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}
 else{el.className=(r.e||r.m)?'st bad':'st ok';el.textContent=(r.e?'⚠️ خطا در چک: '+r.e:'✓ چک خودکار فعال')+' (آخرین ثبت: '+(m<1?'چند ثانیه':m+' دقیقه')+' پیش)'+(r.m?' — قیمت این کوین‌ها گرفته نمی‌شود: '+r.m:'');if(r.s){const b=document.createElement('b');b.textContent=' · '+r.s;el.appendChild(b)}}paintDiag(r)}catch(e){}finally{const g=$('#gear'),e2=$('#st');if(g&&e2)g.classList.toggle('warn',e2.classList.contains('bad'))}}
const pfd=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:v>=1000?2:v>=1?4:6});
async function paintDiag(r){const box=$('#stn');if(!box)return;box.textContent='';const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;box.appendChild(d)};
 if(r&&r.n){const m=Math.max(0,Math.round((r.now-r.n.t)/60000)),w=m<1?'چند ثانیه':m+' دقیقه';add(r.n.ok?'📨 آخرین پیام آلارم: ✓ ارسال شد ('+w+' پیش)':'📨 آخرین پیام آلارم: ⚠️ ارسال نشد — '+(r.n.e||'نامشخص')+' ('+w+' پیش) — دوباره تلاش می‌شود',r.n.ok?'ok':'bad')}
 const act=alerts.filter(a=>!doneA(a));if(!act.length)return;const cs=[...new Set(act.map(a=>a.coin))];
 try{prices=await api('GET','/api/prices?coins='+cs.join(','))}catch(e){}
 act.slice(0,12).forEach(a=>{const px=prices[a.coin];if(px==null){add('📍 '+a.coin+': قیمت گرفته نمی‌شود','bad');return}
  const ts=a.targets.filter(t=>!(a.triggered||[]).includes(t.id)).map(t=>t.price);if(!ts.length)return;const g=ts.reduce((x,y)=>Math.abs(y-px)<Math.abs(x-px)?y:x),dp=Math.abs((g-px)/px*100);
  add('📍 '+a.coin+': قیمت الان '+pfd(px)+' · نزدیک‌ترین هدف '+pfd(g)+' ('+dp.toFixed(2)+'٪ فاصله)')})}
$('#logr').onclick=()=>{$('#st').textContent='…';loadStatus()};
async function refresh(){let d0=null;try{const d=await api('GET','/api/alerts?x=1'),a=(d.alerts||[]).filter(x=>x&&Array.isArray(x.targets)&&x.targets.length);d0=d;if(Array.isArray(d.cats))cats=d.cats;_aAt=Date.now();if(JSON.stringify(a)!==JSON.stringify(alerts)){alerts=a;render();cacheA()}}catch(e){}loadPrices();loadStatus(d0&&d0.status)}
markF();paintSw();paintCatSel();paintWCatSel();paintSCatSel();$('#fq').value=flt.q;$('#wq').value=wFlt.q;$('#sq').value=sFlt.q;document.body.classList.add('boot');
try{const c=JSON.parse(localStorage.getItem('acache')||'null');if(c&&Array.isArray(c.alerts)){alerts=c.alerts.filter(a=>a&&Array.isArray(a.targets)&&a.targets.length);if(Array.isArray(c.cats))cats=c.cats;render();paintChips()}}catch(e){}
load();setTimeout(checkLegacy,1200);setTimeout(()=>{if(tab==='a'&&!witems.length&&!sitems.length)loadW()},4000);setTimeout(()=>document.body.classList.remove('boot'),450);
setInterval(()=>{if(!document.hidden&&tab==='a')refresh()},60000);
setInterval(()=>{if(!document.hidden&&tab==='a')liveTick()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&tab==='a'&&Date.now()-_aAt>15000)refresh()});
(()=>{let t=location.hash.slice(1);if(!(t.length===1&&TABS.includes(t))){try{t=localStorage.getItem('tab')||''}catch(e){t=''}}if(t.length===1&&TABS.includes(t)&&t!=='a')show(t)})();
</script></body></html>`;


// The page has no per-user data, so the browser may keep it and only revalidate (304 = a few bytes instead of ~170 KB).
let _h = 2166136261;
for (let i = 0; i < APP_HTML.length; i += 7) _h = Math.imul(_h ^ APP_HTML.charCodeAt(i), 16777619);
const HTML_ETAG = '"' + (_h >>> 0).toString(36) + "-" + APP_HTML.length.toString(36) + '"';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        const m = String((e && e.message) || e);
        console.log("[api error]", m);
        return new Response(JSON.stringify({ error: /limit exceeded/i.test(m) ? "kv limit: daily write quota is used up, try again after 00:00 UTC" : m.slice(0, 200) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/manifest.webmanifest") return staticRes(MANIFEST, "application/manifest+json");
    if (url.pathname === "/icon.svg") return staticRes(ICON_SVG, "image/svg+xml");
    if (url.pathname === "/icon-192.png") return staticRes(b64(ICON_192), "image/png");
    if (url.pathname === "/icon-512.png") return staticRes(b64(ICON_512), "image/png");
    if (url.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" } });
    if (url.pathname === "/" || url.pathname === "/app") {
      if (request.headers.get("if-none-match") === HTML_ETAG) return new Response(null, { status: 304, headers: { etag: HTML_ETAG, "cache-control": "no-cache" } });
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          etag: HTML_ETAG,
          "x-robots-tag": "noindex, nofollow",
          "x-frame-options": "DENY",
          ...SEC_HEADERS,
        },
      });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};