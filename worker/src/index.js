async function signedInitData(botToken) {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'worker_cron_' + Date.now());
  params.set('start_param', 'worker-cron');
  params.set('user', JSON.stringify({ id: 1, first_name: 'Scheduler', username: 'miniapp_scheduler' }));
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\\n');
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
  const dataKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', dataKey, encoder.encode(check)));
  params.set('hash', [...signature].map(b => b.toString(16).padStart(2, '0')).join(''));
  return btoa(params.toString());
}

async function runTelegramServerlessCron(env) {
  if (!env.TGCLOUD_APP_URL || !env.TELEGRAM_BOT_TOKEN) throw new Error('Missing Telegram Serverless scheduler configuration');
  const authorization = 'tma ' + await signedInitData(env.TELEGRAM_BOT_TOKEN);
  const response = await fetch(env.TGCLOUD_APP_URL + '/api/cron', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const result = await response.text();
  if (!response.ok) throw new Error('Telegram Serverless cron HTTP ' + response.status + ': ' + result.slice(0, 300));
  console.log('Telegram Serverless alert check:', result.slice(0, 500));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'telegram-mini-alert-scheduler' });
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTelegramServerlessCron(env).catch(error => console.error('Scheduled alert check failed:', String(error))));
  },
};
