import { db, api, EndpointError, fetch } from 'sdk';
import { eq, and } from 'sdk/db';
import { miniUsers, userState } from '../schema.js';

const reject = (message) => { throw new EndpointError(message, { code: 'FORBIDDEN' }); };
async function read(userId, key, fallback) {
  const row = await db.select().from(userState).where(and(eq(userState.userId,userId),eq(userState.key,key))).get();
  if (!row) return structuredClone(fallback);
  try { return JSON.parse(row.value); } catch { return structuredClone(fallback); }
}
async function write(userId,key,value) {
  await db.insert(userState).values({userId,key,value:JSON.stringify(value)})
    .onConflictDoUpdate({target:[userState.userId,userState.key],set:{value:JSON.stringify(value)}}).run();
}
async function priceFor(symbol) {
  const c=String(symbol||'').toUpperCase().replace(/USDT\\.P$|USDT$/,'');
  const perp=String(symbol||'').endsWith('.P');
  const sources=perp?[
    ['https://api.bybit.com/v5/market/tickers?category=linear&symbol='+c+'USDT',d=>d?.result?.list?.[0]?.lastPrice],
    ['https://www.okx.com/api/v5/market/ticker?instId='+c+'-USDT-SWAP',d=>d?.data?.[0]?.last],
    ['https://fapi.binance.com/fapi/v1/ticker/price?symbol='+c+'USDT',d=>d?.price],
  ]:[
    ['https://www.okx.com/api/v5/market/ticker?instId='+c+'-USDT',d=>d?.data?.[0]?.last],
    ['https://api.bybit.com/v5/market/tickers?category=spot&symbol='+c+'USDT',d=>d?.result?.list?.[0]?.lastPrice],
    ['https://api.binance.com/api/v3/ticker/price?symbol='+c+'USDT',d=>d?.price],
  ];
  for(const [url,pick] of sources){try{const r=await fetch(url);if(!r.ok)continue;const n=Number(pick(await r.json()));if(Number.isFinite(n)&&n>0)return n;}catch{}}
  return null;
}
function directionOf(note){for(const line of String(note||'').split('\\n')){const i=line.indexOf(':');if(i>=0&&line.slice(0,i).trim()==='جهت')return line.slice(i+1).trim().toLowerCase();}return '';}

export default async function (_input,ctx) {
  if(ctx.initData?.start_param!=='worker-cron')reject('Forbidden');
  const users=await db.select().from(miniUsers).all();
  let checked=0,triggered=0,failed=0;
  for(const user of users){
    const data=await read(user.userId,'alerts',{alerts:[],last_id:0});
    const alerts=Array.isArray(data.alerts)?data.alerts:[];
    const pending=alerts.filter(a=>(a.targets||[]).some(t=>!(a.triggered||[]).includes(t.id)));
    if(!pending.length)continue;
    const symbols=[...new Set(pending.map(a=>a.coin))];
    const prices=new Map();
    await Promise.all(symbols.map(async s=>prices.set(s,await priceFor(s))));
    let changed=false;
    for(const alert of pending){
      const price=prices.get(alert.coin);if(price==null)continue;checked++;
      const entry=alert.entry_price??alert.ref_price??null;
      for(const target of alert.targets||[]){
        const tid=target.id||0;if((alert.triggered||[]).includes(tid))continue;
        const dir=directionOf(target.note),level=Number(target.price);
        let hit=false,kind='🔔';
        if(dir==='long'){
          if(entry!=null&&level>=entry){hit=price>=level;kind='✅ TP';}
          else if(entry!=null){hit=price<=level;kind='🛑 SL';}
          else hit=price>=level;
        }else if(dir==='short'){
          if(entry!=null&&level>entry){hit=price>=level;kind='🛑 SL';}
          else if(entry!=null){hit=price<=level;kind='✅ TP';}
          else hit=price<=level;
        }else{
          const prev=Number(alert.prev_price);
          hit=price===level||(Number.isFinite(prev)&&((prev<level&&price>=level)||(prev>level&&price<=level)));
        }
        if(!hit)continue;
        const lang=(await read(user.userId,'settings',{})).lang||'fa';
        const message=lang==='en'
          ? kind+' Price alert: '+alert.coin+'\\nCurrent: '+price+'\\nTarget: '+level
          : kind+' هشدار قیمت '+alert.coin+'\\nقیمت فعلی: '+price+'\\nقیمت هدف: '+level;
        try{
          await api.sendMessage({chat_id:user.userId,text:message,disable_web_page_preview:true});
          alert.triggered=alert.triggered||[];alert.triggered.push(tid);changed=true;triggered++;
        }catch(e){failed++;console.warn('Alert delivery failed',user.userId,alert.id,e?.description||e?.message||String(e));}
      }
      alert.prev_price=price;alert.last_price=price;alert.last_checked=new Date().toISOString();
    }
    if(changed||pending.length)await write(user.userId,'alerts',data);
  }
  return {ok:true,users:users.length,checked,triggered,failed};
}
