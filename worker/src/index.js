const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.floor(Date.now() / 1000) - authDate > 86400 || authDate > Math.floor(Date.now() / 1000) + 60) return null;
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
  const key = await crypto.subtle.importKey('raw', secret, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(dataCheck)));
  const expected = [...signature].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!safeEqual(expected, hash.toLowerCase())) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch { return null; }
}

async function priceFor(symbol) {
  const clean = symbol.replace(/[^A-Z0-9]/g, '');
  const urls = [
    ['https://api.bybit.com/v5/market/tickers?category=spot&symbol=' + clean + 'USDT', d => d?.result?.list?.[0]?.lastPrice],
    ['https://api.binance.com/api/v3/ticker/price?symbol=' + clean + 'USDT', d => d?.price],
    ['https://www.okx.com/api/v5/market/ticker?instId=' + clean + '-USDT', d => d?.data?.[0]?.last],
  ];
  for (const [url, pick] of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
      if (!res.ok) continue;
      const value = Number(pick(await res.json()));
      if (Number.isFinite(value) && value > 0) return value;
    } catch (error) { console.log('price source failed', new URL(url).hostname, String(error)); }
  }
  return null;
}

async function sendTelegram(env, chatId, text) {
  const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({chat_id: chatId, text, disable_web_page_preview: true})
  });
  if (!res.ok) throw new Error('Telegram sendMessage HTTP ' + res.status);
  const result = await res.json();
  if (!result.ok) throw new Error(result.description || 'Telegram API error');
}

async function apiHandler(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, {headers:{
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers':'Authorization,Content-Type',
    'access-control-max-age':'86400'
  }});
  const cors = {'access-control-allow-origin':'*','vary':'Origin'};
  if (url.pathname === '/api/health' && request.method === 'GET') return new Response(JSON.stringify({ok:true,service:'telegram-mini-alerts'}), {headers:{...JSON_HEADERS,...cors}});
  if (!url.pathname.startsWith('/api/')) return new Response('Not found', {status:404});
  const auth = request.headers.get('authorization') || '';
  const user = auth.startsWith('tma ') ? await verifyInitData(auth.slice(4), env.TELEGRAM_BOT_TOKEN) : null;
  if (!user) return new Response(JSON.stringify({error:'اعتبار تلگرام نامعتبر است؛ برنامه را از داخل ربات باز کن.'}), {status:401,headers:{...JSON_HEADERS,...cors}});
  const userId = String(user.id);
  if (url.pathname === '/api/alerts' && request.method === 'GET') {
    const {results=[]} = await env.DB.prepare('SELECT id,symbol,direction,target,active,triggered_at AS triggeredAt,created_at AS createdAt FROM alerts WHERE user_id=? ORDER BY created_at DESC').bind(userId).all();
    return new Response(JSON.stringify({alerts:results}), {headers:{...JSON_HEADERS,...cors}});
  }
  if (url.pathname === '/api/alerts' && request.method === 'POST') {
    const body = await request.json();
    const symbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20);
    const direction = body.direction === 'below' ? 'below' : 'above';
    const target = Number(body.target);
    if (!symbol || !Number.isFinite(target) || target <= 0) return new Response(JSON.stringify({error:'نماد یا قیمت هدف نامعتبر است.'}), {status:400,headers:{...JSON_HEADERS,...cors}});
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO alerts (id,user_id,symbol,direction,target,active,created_at) VALUES (?,?,?,?,?,1,?)').bind(id,userId,symbol,direction,target,now).run();
    return new Response(JSON.stringify({ok:true,id}), {status:201,headers:{...JSON_HEADERS,...cors}});
  }
  const match = url.pathname.match(/^\/api\/alerts\/([a-f0-9-]{36})$/i);
  if (match && request.method === 'PATCH') {
    const body = await request.json();
    if (typeof body.active !== 'boolean') return new Response(JSON.stringify({error:'مقدار active نامعتبر است.'}), {status:400,headers:{...JSON_HEADERS,...cors}});
    const result = await env.DB.prepare('UPDATE alerts SET active=?, triggered_at=CASE WHEN ?=1 THEN NULL ELSE triggered_at END WHERE id=? AND user_id=?').bind(body.active ? 1 : 0,body.active ? 1 : 0,match[1],userId).run();
    return new Response(JSON.stringify({ok:true,changes:result.meta?.changes || 0}), {headers:{...JSON_HEADERS,...cors}});
  }
  if (match && request.method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM alerts WHERE id=? AND user_id=?').bind(match[1],userId).run();
    return new Response(JSON.stringify({ok:true,changes:result.meta?.changes || 0}), {headers:{...JSON_HEADERS,...cors}});
  }
  return new Response(JSON.stringify({error:'مسیر پیدا نشد.'}), {status:404,headers:{...JSON_HEADERS,...cors}});
}

async function runAlerts(env) {
  const {results=[]} = await env.DB.prepare('SELECT * FROM alerts WHERE active=1 AND triggered_at IS NULL ORDER BY created_at ASC LIMIT 40').all();
  const bySymbol = [...new Set(results.map(a => a.symbol))];
  const prices = new Map();
  await Promise.all(bySymbol.map(async symbol => prices.set(symbol, await priceFor(symbol))));
  for (const alert of results) {
    const price = prices.get(alert.symbol);
    if (price == null) continue;
    const hit = alert.direction === 'above' ? price >= alert.target : price <= alert.target;
    if (!hit) continue;
    try {
      await sendTelegram(env, alert.user_id, '🔔 هشدار قیمت ' + alert.symbol + '\nقیمت فعلی: ' + price + '\nقیمت هدف: ' + alert.target + '\nجهت: ' + (alert.direction === 'above' ? 'بالاتر' : 'پایین‌تر'));
      await env.DB.prepare('UPDATE alerts SET triggered_at=?, last_price=? WHERE id=? AND triggered_at IS NULL').bind(new Date().toISOString(),price,alert.id).run();
    } catch (error) {
      console.log('notification failed', alert.id, String(error));
    }
  }
}

async function callTelegramServerlessCron(env) {
  if (!env.TGCLOUD_APP_URL || !env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram Serverless cron configuration is missing');
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'worker_cron_' + Date.now());
  params.set('start_param', 'worker-cron');
  params.set('user', JSON.stringify({id: 1, first_name: 'Scheduler', username: 'miniapp_scheduler'}));
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k + '=' + v).join('\\n');
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(env.TELEGRAM_BOT_TOKEN));
  const dataKey = await crypto.subtle.importKey('raw', secret, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', dataKey, encoder.encode(check)));
  const hash = [...signature].map(b => b.toString(16).padStart(2,'0')).join('');
  params.set('hash', hash);
  const response = await fetch(env.TGCLOUD_APP_URL + '/api/cron', {
    method: 'POST',
    headers: {'Authorization': 'tma ' + btoa(params.toString()), 'Content-Type': 'application/json'},
    body: '{}'
  });
  const result = await response.text();
  if (!response.ok) throw new Error('Telegram Serverless cron HTTP ' + response.status + ': ' + result.slice(0,240));
  console.log('Telegram Serverless cron:', result.slice(0,500));
}

export default {
  async fetch(request, env) {
    try { return await apiHandler(request, env); }
    catch (error) { console.log('request failed', String(error)); return json({error:'خطای داخلی سرور'},500); }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(callTelegramServerlessCron(env).catch(error => console.log('cron failed', String(error))));
  }
};
