const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const API_BASE = (import.meta?.env?.VITE_WORKER_API_URL || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const form = $('alert-form');
let alerts = [];
let toastTimer;

function notify(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function api(path, options = {}) {
  if (!API_BASE) throw new Error('آدرس Worker تنظیم نشده است. متغیر VITE_WORKER_API_URL را تنظیم کن.');
  const initData = tg?.initData || '';
  if (!initData) throw new Error('این برنامه باید از داخل تلگرام باز شود.');
  return fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'tma ' + initData,
      ...(options.headers || {})
    }
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا در ارتباط با سرور');
    return data;
  });
}

function render() {
  $('total').textContent = alerts.length;
  $('active').textContent = alerts.filter(a => a.active && !a.triggeredAt).length;
  $('alerts').replaceChildren();
  if (!alerts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'هنوز آلارمی نساخته‌ای.';
    $('alerts').append(empty);
    return;
  }
  for (const alert of alerts) {
    const card = document.createElement('article');
    card.className = 'alert-card';
    const row = document.createElement('div'); row.className = 'alert-row';
    const info = document.createElement('div');
    const symbol = document.createElement('div'); symbol.className = 'symbol'; symbol.textContent = alert.symbol;
    const target = document.createElement('div'); target.className = 'target'; target.textContent = (alert.direction === 'above' ? '≥ ' : '≤ ') + Number(alert.target).toLocaleString('en-US');
    info.append(symbol, target);
    const tag = document.createElement('span'); tag.className = 'tag ' + (alert.direction === 'below' ? 'below' : '');
    tag.textContent = alert.triggeredAt ? 'فعال‌شده' : alert.active ? 'فعال' : 'متوقف';
    row.append(info, tag);
    const actions = document.createElement('div'); actions.className = 'actions';
    const toggle = document.createElement('button'); toggle.className = 'small'; toggle.textContent = alert.active ? 'توقف' : 'فعال‌سازی';
    toggle.addEventListener('click', () => changeAlert(alert.id, {active: !alert.active}));
    const remove = document.createElement('button'); remove.className = 'small danger'; remove.textContent = 'حذف';
    remove.addEventListener('click', () => deleteAlert(alert.id));
    actions.append(toggle, remove); card.append(row, actions); $('alerts').append(card);
  }
}

async function load() {
  $('status').textContent = 'در حال دریافت…';
  try {
    const data = await api('/api/alerts');
    alerts = data.alerts || [];
    render();
    $('status').textContent = 'متصل';
  } catch (error) {
    $('status').textContent = 'خطا در اتصال';
    notify(error.message);
  }
}

async function changeAlert(id, patch) {
  try { await api('/api/alerts/' + encodeURIComponent(id), {method:'PATCH', body:JSON.stringify(patch)}); await load(); }
  catch (error) { notify(error.message); }
}
async function deleteAlert(id) {
  try { await api('/api/alerts/' + encodeURIComponent(id), {method:'DELETE'}); await load(); notify('آلارم حذف شد'); }
  catch (error) { notify(error.message); }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const symbol = String(data.get('symbol') || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
  const target = Number(data.get('target'));
  if (!symbol || !Number.isFinite(target) || target <= 0) return notify('نماد و قیمت معتبر وارد کن');
  const button = form.querySelector('button[type=submit]');
  button.disabled = true; button.textContent = 'در حال ثبت…';
  try {
    await api('/api/alerts', {method:'POST', body:JSON.stringify({symbol, direction:data.get('direction'), target})});
    form.reset(); await load(); notify('آلارم ساخته شد');
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; button.textContent = '＋ ساخت آلارم'; }
});

$('refresh').addEventListener('click', load);
const user = tg?.initDataUnsafe?.user;
if (user?.first_name) $('welcome').textContent = 'سلام ' + user.first_name + '، آلارم‌هایت را مدیریت کن';
load();
