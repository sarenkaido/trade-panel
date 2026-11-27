import { db, api, EndpointError, fetch } from 'sdk';
import { eq, and } from 'sdk/db';
import { userState, miniUsers } from '../schema.js';
import runCron from './cron.js';

const fail = (message, status = 400) => { throw new EndpointError(message, { status }); };
async function read(userId, key, fallback) {
  const row = await db.select().from(userState).where(and(eq(userState.userId, userId), eq(userState.key, key))).get();
  if (!row) return structuredClone(fallback);
  try { return JSON.parse(row.value); } catch { return structuredClone(fallback); }
}
async function write(userId, key, value) {
  await db.insert(userState).values({ userId, key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [userState.userId, userState.key], set: { value: JSON.stringify(value) } }).run();
  return value;
}
const parseNote = (note) => Object.fromEntries(String(note || '').split('\n').map(line => {
  const i = line.indexOf(':'); return i < 0 ? ['', ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
}).filter(([k]) => k));
function normalizeCoin(raw) {
  const c = String(raw || '').toUpperCase().replace(/[\s\/_-]/g, '');
  const m = /^([A-Z0-9]{1,12}?)(?:USDT)?(\.P)?$/.exec(c);
  if (!m) return '';
  const stocks = new Set(['AAPL','TSLA','NVDA','GOOGL','GOOG','MSFT','AMZN','AMD','META','NFLX','SPX','SPXL','BRK','JPM','V','DIS','PYPL','COIN','SQ','PLTR','SOFI','NIO','XPEV','LI','MSTR','BABA','INTC','UBER','ORCL','CRM','ADBE','QCOM','AVGO','MU','TSM','ASML','BA','KO','PEP','WMT','NKE','MCD','XOM','CVX','PFE','JNJ','UNH','HOOD','RBLX','SHOP','SNAP','ABNB','MARA','RIOT','CRCL','GME','AMC','SPY','QQQ','IWM']);
  return m[1] + (m[2] || stocks.has(m[1]) ? 'USDT.P' : '');
}
async function priceFor(symbol) {
  const c = symbol.replace(/USDT\.P$|USDT$/,'');
  const perp = symbol.endsWith('.P');
  const sources = perp ? [
    ['https://api.bybit.com/v5/market/tickers?category=linear&symbol='+c+'USDT',d=>d?.result?.list?.[0]?.lastPrice],
    ['https://www.okx.com/api/v5/market/ticker?instId='+c+'-USDT-SWAP',d=>d?.data?.[0]?.last],
    ['https://fapi.binance.com/fapi/v1/ticker/price?symbol='+c+'USDT',d=>d?.price],
  ] : [
    ['https://www.okx.com/api/v5/market/ticker?instId='+c+'-USDT',d=>d?.data?.[0]?.last],
    ['https://api.bybit.com/v5/market/tickers?category=spot&symbol='+c+'USDT',d=>d?.result?.list?.[0]?.lastPrice],
    ['https://api.binance.com/api/v3/ticker/price?symbol='+c+'USDT',d=>d?.price],
  ];
  for (const [url,pick] of sources) {
    try { const r=await fetch(url); if(!r.ok) continue; const v=Number(pick(await r.json())); if(Number.isFinite(v)&&v>0)return v; } catch {}
  }
  return null;
}
function targetsFrom(body) {
  const direction = ['long','short'].includes(body.direction) ? body.direction : '';
  return (Array.isArray(body.targets)?body.targets:[]).slice(0,10)
    .map(t=>({price:Number(t.price),note:String(t.note||'').replace(/\s+/g,' ').trim().slice(0,200)}))
    .filter(t=>Number.isFinite(t.price)&&t.price>0)
    .map((t,i)=>({id:i+1,price:t.price,note:[...(direction?['جهت : '+direction,'وضعیت : فعال']:['وضعیت : فعال']),...(t.note?['توضیحات : '+t.note]:[])].join('\n')}));
}
async function listApi(uid, path, method, body) {
  const specs = [
    ['watchlist','watchlist','wcats','wcats','w'],['scenario','scenario','scats','scats','s'],
    ['positions','positions','pcats','pcats','p'],['strategies','strategies','gcats','gcats','g'],
    ['tasks','tasks','kcats','kcats','k'],
  ];
  for (const [base,key,cbase,ckey,kind] of specs) {
    if (!(path==='/api/'+base || path.startsWith('/api/'+base+'/') || path==='/api/'+cbase || path.startsWith('/api/'+cbase+'/'))) continue;
    const cm=path.match(new RegExp('^/api/'+cbase+'/(\\d+)$'));
    const im=path.match(new RegExp('^/api/'+base+'/(\\d+)$'));
    const cats=async()=>{const v=await read(uid,ckey,[]);return Array.isArray(v)?v:[]};
    const items=async()=>{const d=await read(uid,key,{items:[],last_id:0});return Array.isArray(d.items)?d:{items:[],last_id:0}};
    const valid=async id=>!id||(await cats()).some(c=>c.id===id);
    if(path==='/api/'+cbase||cm){
      if(method==='GET')return {cats:await cats()};
      if(method==='POST'){
        const name=String(body.name||'').trim().slice(0,40);if(!name)fail('نام دسته لازم است');
        const cs=await cats();if(cs.some(c=>c.name===name))fail('duplicate');
        const cat={id:cs.reduce((m,c)=>Math.max(m,c.id||0),0)+1,name,color:/^#[0-9a-fA-F]{6}$/.test(body.color||'')?body.color.toUpperCase():'#8B5CF6'};
        cs.push(cat);await write(uid,ckey,cs);return {ok:true,cat};
      }
      if(cm){
        const cs=await cats(),id=Number(cm[1]),cat=cs.find(c=>c.id===id);if(!cat)fail('not found',404);
        if(method==='PUT'){const name=String(body.name||'').trim().slice(0,40);if(!name)fail('invalid');if(cs.some(c=>c.id!==id&&c.name===name))fail('duplicate');cat.name=name;if(/^#[0-9a-fA-F]{6}$/.test(body.color||''))cat.color=body.color.toUpperCase();await write(uid,ckey,cs);return {ok:true,cat};}
        if(method==='DELETE'){await write(uid,ckey,cs.filter(c=>c.id!==id));const d=await items();d.items.forEach(x=>{if(x.cat===id)x.cat=0});await write(uid,key,d);return {ok:true};}
      }
    }
    if(path==='/api/'+base||im){
      if(method==='GET')return {items:(await items()).items,cats:await cats()};
      if(method==='POST'){
        const d=await items();let it;
        if(kind==='w'){const name=String(body.name!=null?body.name:body.coin||'').trim().slice(0,60);if(!name)fail('invalid');it={coin:name,note:String(body.note||'').trim().slice(0,10000)};}
        else{const title=String(body.title||'').trim().slice(0,120),text=String(body.text||'').slice(0,20000);if(!title&&!text.trim())fail('invalid');it={title:title||text.trim().slice(0,40)||'سناریو',text};}
        let cat=Number(body.cat)||0;if(!(await valid(cat)))cat=0;it.cat=cat;it.id=(d.last_id||0)+1;d.items.push(it);d.last_id=it.id;if(d.items.length>400)d.items=d.items.slice(-400);await write(uid,key,d);return {ok:true,id:it.id};
      }
      if(im){const d=await items(),id=Number(im[1]),it=d.items.find(x=>x.id===id);if(!it)fail('not found',404);
        if(method==='PUT'){
          if(kind==='w'){const name=String(body.name!=null?body.name:body.coin||'').trim().slice(0,60);if(!name)fail('invalid');it.coin=name;it.note=String(body.note||'').trim().slice(0,10000);}
          else{const title=String(body.title||'').trim().slice(0,120),text=String(body.text||'').slice(0,20000);if(!title&&!text.trim())fail('invalid');it.title=title||text.trim().slice(0,40)||'سناریو';it.text=text;}
          let cat=Number(body.cat)||0;if(!(await valid(cat)))cat=0;it.cat=cat;await write(uid,key,d);return {ok:true};
        }
        if(method==='DELETE'){d.items=d.items.filter(x=>x.id!==id);await write(uid,key,d);return {ok:true};}
      }
    }
    return {error:'not found'};
  }
  return null;
}

export default async function (input, ctx) {
  const user=ctx.initData?.user;
  if(!user?.id) fail('Telegram user context is missing',401);
  const uid=Number(user.id);
  await db.insert(miniUsers).values({userId:uid,firstName:user.first_name||'',username:user.username||'',createdAt:Math.floor(Date.now()/1000)})
    .onConflictDoUpdate({target:miniUsers.userId,set:{firstName:user.first_name||'',username:user.username||''}}).run();
  const method=String(input.method||'GET').toUpperCase();
  const path=(String(input.path||'/').replace(/\\/+$/,'')||'/');
  const body=input.body&&typeof input.body==='object'?input.body:{};
  const query=input.query&&typeof input.query==='object'?input.query:{};
  const settings=()=>read(uid,'settings',{});
  const catPrefix='/api/cats/';
  if(path==='/api/cats'||path.startsWith(catPrefix)){
    const idText=path.startsWith(catPrefix)?path.slice(catPrefix.length):'';
    const m=idText&&Number.isInteger(Number(idText))?[null,idText]:null,cats=async()=>{const v=await read(uid,'cats',[]);return Array.isArray(v)?v:[];};
    if(method==='GET')return {cats:await cats()};
    if(method==='POST'){const name=String(body.name||'').trim().slice(0,40);if(!name)fail('invalid');const cs=await cats();if(cs.some(x=>x.name===name))fail('duplicate');const cat={id:cs.reduce((n,x)=>Math.max(n,x.id||0),0)+1,name,color:/^#[0-9a-fA-F]{6}$/.test(body.color||'')?body.color.toUpperCase():'#8B5CF6'};cs.push(cat);await write(uid,'cats',cs);return {ok:true,cat};}
    if(m){const id=Number(m[1]),cs=await cats(),cat=cs.find(x=>x.id===id);if(!cat)fail('not found',404);if(method==='PUT'){const name=String(body.name||'').trim().slice(0,40);if(!name)fail('invalid');if(cs.some(x=>x.id!==id&&x.name===name))fail('duplicate');cat.name=name;if(/^#[0-9a-fA-F]{6}$/.test(body.color||''))cat.color=body.color.toUpperCase();await write(uid,'cats',cs);return {ok:true,cat};}if(method==='DELETE'){await write(uid,'cats',cs.filter(x=>x.id!==id));const d=await read(uid,'alerts',{alerts:[]});for(const a of d.alerts||[])if(a.cat===id)a.cat=0;await write(uid,'alerts',d);return {ok:true};}}
  }
  if(path==='/api/auth/state'&&method==='GET')return {registered:true,loggedIn:true,user:user.username||String(uid),mail:false,legacy:false};
  if(['/api/logout','/api/login','/api/auth/confirm'].includes(path)&&method==='POST')return {ok:true};
  if(path==='/api/auth/code'||path==='/api/auth/change')fail('ورود و رمز عبور با حساب تلگرام مدیریت می‌شود');
  if(path==='/api/lang'&&method==='POST'){const st=await settings();st.lang=body.lang==='en'?'en':'fa';await write(uid,'settings',st);return {ok:true};}
  if(path==='/api/settings'&&method==='GET'){const st=await settings();return {email:st.email||'',verified:!!st.verified,provider:false,lang:st.lang||'fa'};}
  if(path==='/api/settings'&&method==='POST'){const st=await settings();Object.assign(st,body);await write(uid,'settings',st);return {ok:true};}
  if(path==='/api/test-notify'&&method==='POST'){
    try{await api.sendMessage({chat_id:uid,text:(await settings()).lang==='en'?'🔔 Test notification — Telegram Mini App is connected.':'🔔 تست اعلان — مینی‌اپ تلگرام متصل است.'});return {tg:{ok:true,error:''},email:{ok:false,skipped:true,error:''}};}
    catch(e){return {tg:{ok:false,error:e.description||e.message||'ارسال ناموفق'},email:{ok:false,skipped:true,error:''}};}
  }
  if(path.startsWith('/api/email/'))fail('ارسال ایمیل در این نسخه فعال نیست');
  if(path==='/api/tg'&&method==='GET'){let bot='';try{bot=(await api.getMe()).username||'';}catch{}return {connected:true,hasToken:true,bot,viaEnv:true};}
  if(path.startsWith('/api/tg/')&&method==='POST'){let bot='';try{bot=(await api.getMe()).username||'';}catch{}return {connected:true,hasToken:true,bot,viaEnv:true};}
  if(path==='/api/status'&&method==='GET'){const st=await read(uid,'last_cron',{t:0,p:0,m:'',e:'',n:null});return {...st,now:Date.now(),s:'Telegram Serverless'};}
  if(path==='/api/check-now'&&method==='POST')return {ok:true,...await runCron({}, {initData:{start_param:'worker-cron'}})};
  if(path==='/api/prices'&&method==='GET'){
    const coins=[...new Set(String(query.coins||'').toUpperCase().split(',').filter(Boolean))].slice(0,40),out={};
    await Promise.all(coins.map(async c=>{out[c]=await priceFor(c);}));
    return out;
  }
  if(path==='/api/alerts'&&method==='GET'){
    const d=await read(uid,'alerts',{alerts:[],last_id:0}),cs=await read(uid,'cats',[]),st=await settings();
    const out={alerts:d.alerts||[],cats:Array.isArray(cs)?cs:[]};
    if(query.x){const status=await read(uid,'last_cron',{t:0,p:0,m:'',e:'',n:null});out.status={...status,now:Date.now(),s:'Telegram Serverless'};if(query.x==='2')out.settings={email:st.email||'',verified:!!st.verified,provider:false};}
    return out;
  }
  if(path==='/api/alerts'&&method==='POST'){
    const coin=normalizeCoin(body.coin),built=targetsFrom(body);if(!coin||!built.length)fail('invalid');
    const d=await read(uid,'alerts',{alerts:[],last_id:0});const id=(d.last_id||0)+1;
    const entry=Number(body.entry),hasEntry=Number.isFinite(entry)&&entry>0,cat=Number(body.cat)||0;
    const ch=Array.isArray(body.ch)?body.ch.filter(x=>x==='tg'||x==='email'):['tg'];
    if(ch.includes('email')&&!(await settings()).verified)fail('email not verified');
    d.alerts.push({id,coin,targets:built,triggered:[],created_at:new Date().toISOString(),prev_price:null,entry_price:hasEntry?entry:null,ref_price:hasEntry?null:await priceFor(coin),ch:ch.length?ch:['tg'],cat});
    d.last_id=id;await write(uid,'alerts',d);return {ok:true,id};
  }
  if(path==='/api/alerts'&&method==='DELETE'){await write(uid,'alerts',{alerts:[],last_id:0});await write(uid,'reported_ids',[]);return {ok:true};}
  if(path==='/api/alerts/reorder'&&method==='POST'){
    const ids=(Array.isArray(body.ids)?body.ids:[]).map(Number),d=await read(uid,'alerts',{alerts:[]}),map=new Map((d.alerts||[]).map(x=>[x.id,x])),out=[];
    for(const id of ids)if(map.has(id)){out.push(map.get(id));map.delete(id);}for(const x of map.values())out.push(x);d.alerts=out;await write(uid,'alerts',d);return {ok:true};
  }
  if(path==='/api/alerts/bulk'&&method==='POST'){
    const ids=(Array.isArray(body.ids)?body.ids:[]).map(Number),d=await read(uid,'alerts',{alerts:[]});
    if(body.act==='del')d.alerts=(d.alerts||[]).filter(a=>!ids.includes(a.id));
    else if(body.act==='cat'){const cat=Number(body.cat)||0,cs=await read(uid,'cats',[]);if(cat&&!cs.some(c=>c.id===cat))fail('invalid');for(const a of d.alerts||[])if(ids.includes(a.id))a.cat=cat;}
    else fail('invalid');await write(uid,'alerts',d);return {ok:true};
  }
  const tick=path.match(/^\/api\/alerts\/(\d+)\/tick$/);
  if(tick&&method==='POST'){const d=await read(uid,'alerts',{alerts:[]}),a=(d.alerts||[]).find(x=>x.id===Number(tick[1])),tid=Number(body.tid);if(!a||!(a.targets||[]).some(t=>t.id===tid))fail('not found',404);a.triggered=a.triggered||[];const i=a.triggered.indexOf(tid);if(i>=0){a.triggered.splice(i,1);a.prev_price=null;if(a.last_triggered)delete a.last_triggered[String(tid)];}else a.triggered.push(tid);await write(uid,'alerts',d);return {ok:true,on:i<0};}
  const am=path.match(/^\/api\/alerts\/(\d+)$/);
  if(am){const d=await read(uid,'alerts',{alerts:[]}),id=Number(am[1]),a=(d.alerts||[]).find(x=>x.id===id);if(!a)fail('not found',404);
    if(method==='DELETE'){d.alerts=d.alerts.filter(x=>x.id!==id);await write(uid,'alerts',d);return {ok:true};}
    if(method==='PUT'){
      const built=targetsFrom(body);if(!built.length)fail('invalid');const old=a.targets||[],oldDir=(parseNote(old[0]?.note||'')['جهت']||'').toLowerCase().trim(),triggered=[];
      let changed=false;built.forEach((t,i)=>{const o=old[i];if(o&&o.price===t.price&&oldDir===(body.direction||'')&&(a.triggered||[]).includes(o.id))triggered.push(t.id);else changed=true;});
      a.targets=built;a.triggered=triggered;a.last_triggered={};const entry=Number(body.entry);if(Number.isFinite(entry)&&entry>0)a.entry_price=entry;else if(a.entry_price!=null){a.ref_price=a.entry_price;a.entry_price=null;}if(changed)a.prev_price=null;
      a.ch=Array.isArray(body.ch)?body.ch:['tg'];a.cat=Number(body.cat)||0;await write(uid,'alerts',d);return {ok:true};
    }
  }
  const list=await listApi(uid,path,method,body);if(list!==null)return list;
  if(path==='/api/tabs'&&method==='GET')return {tabs:(await read(uid,'tabs',{tabs:[]})).tabs||[]};
  if(path==='/api/tabs'&&method==='POST'){
    const d=await read(uid,'tabs',{tabs:[]}),title=String(body.title||'').trim().slice(0,24);if(!title)fail('نام تب لازم است');if(d.tabs.length>=10)fail('حداکثر ۱۰ تب دلخواه می‌شود ساخت');
    const tab={id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),title,icon:String(body.icon||'📝').slice(0,8),notes:[]};d.tabs.push(tab);await write(uid,'tabs',d);return {tab};
  }
  const tm=path.match(/^\/api\/tabs\/([a-z0-9]+)$/i);
  if(tm){const d=await read(uid,'tabs',{tabs:[]}),t=d.tabs.find(x=>x.id===tm[1]);if(!t)fail('not found',404);
    if(method==='PUT'){if(body.title!==undefined)t.title=String(body.title).slice(0,24);if(body.icon!==undefined)t.icon=String(body.icon).slice(0,8);if(Array.isArray(body.notes))t.notes=body.notes.slice(0,30).map(n=>typeof n==='string'?{id:Math.random().toString(36).slice(2,8),title:'',text:n}:{id:String(n.id||Math.random().toString(36).slice(2,8)),title:String(n.title||'').slice(0,60),text:String(n.text||'').slice(0,20000)});await write(uid,'tabs',d);return {tab:t};}
    if(method==='DELETE'){d.tabs=d.tabs.filter(x=>x.id!==tm[1]);await write(uid,'tabs',d);return {ok:true};}
  }
  return {error:'not found'};
}
