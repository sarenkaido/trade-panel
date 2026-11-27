import { db, api, EndpointError, fetch } from 'sdk';
import { eq, and } from 'sdk/db';
import { miniUsers, userState } from '../schema.js';

const NL = String.fromCharCode(10);
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

const STOCKS = new Set(['AAPL','TSLA','NVDA','GOOGL','GOOG','MSFT','AMZN','AMD','META','NFLX','SPX','SPXL','BRK','JPM','V','DIS','PYPL','COIN','SQ','PLTR','SOFI','NIO','XPEV','LI','MSTR','BABA','INTC','UBER','ORCL','CRM','ADBE','QCOM','AVGO','MU','TSM','ASML','BA','KO','PEP','WMT','NKE','MCD','XOM','CVX','PFE','JNJ','UNH','HOOD','RBLX','SHOP','SNAP','ABNB','MARA','RIOT','CRCL','GME','AMC','SPY','QQQ','IWM']);
function splitCoin(raw) {
  const c=String(raw||'').toUpperCase().replace(/[\s\/_-]/g,'');
  const m=/^([A-Z0-9]{1,12}?)(?:USDT)?(\.P)?$/.exec(c);
  return m?{base:m[1],perp:!!m[2]||STOCKS.has(m[1])}:null;
}
async function tryPrice(url,pick) {
  try {
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(3500)});
    if(!r.ok)return null;
    const v=Number(pick(await r.json()));
    return Number.isFinite(v)&&v>0?v:null;
  } catch { return null; }
}
async function priceFor(symbol) {
  const x=splitCoin(symbol)||{base:String(symbol||'').toUpperCase(),perp:false},c=x.base;
  const sources=x.perp?[
    ['https://api.bybit.com/v5/market/tickers?category=linear&symbol='+c+'USDT',d=>d?.result?.list?.[0]?.lastPrice],
    ['https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol='+c+'USDT',d=>d?.data?.[0]?.lastPr],
    ['https://www.okx.com/api/v5/market/ticker?instId='+c+'-USDT-SWAP',d=>d?.data?.[0]?.last],
    ['https://api.gateio.ws/api/v4/futures/usdt/tickers?contract='+c+'_USDT',d=>d?.[0]?.last],
    ['https://contract.mexc.com/api/v1/contract/ticker?symbol='+c+'_USDT',d=>d?.data?.lastPrice],
    ['https://fapi.binance.com/fapi/v1/ticker/price?symbol='+c+'USDT',d=>d?.price],
    ['https://api-futures.kucoin.com/api/v1/ticker?symbol='+c+'USDTM',d=>d?.data?.price],
  ]:[
    ['https://www.okx.com/api/v5/market/ticker?instId='+c+'-USDT',d=>d?.data?.[0]?.last],
    ['https://api.bybit.com/v5/market/tickers?category=spot&symbol='+c+'USDT',d=>d?.result?.list?.[0]?.lastPrice],
    ['https://api.gateio.ws/api/v4/spot/tickers?currency_pair='+c+'_USDT',d=>d?.[0]?.last],
    ['https://api.mexc.com/api/v3/ticker/price?symbol='+c+'USDT',d=>d?.price],
    ['https://api.kucoin.com/api/v1/market/orderbook/level1?symbol='+c+'-USDT',d=>d?.data?.price],
    ['https://api.bitget.com/api/v2/spot/market/tickers?symbol='+c+'USDT',d=>d?.data?.[0]?.lastPr],
    ['https://api.binance.com/api/v3/ticker/price?symbol='+c+'USDT',d=>d?.price],
  ];
  const values=await Promise.all(sources.map(([url,pick])=>tryPrice(url,pick)));
  return values.find(value=>value!==null)??null;
}
async function getCandles(coin) {
  const c=(splitCoin(coin)||{base:String(coin||'').toUpperCase()}).base;
  const sources=[
    ['https://api.bybit.com/v5/market/kline?category=linear&symbol='+c+'USDT&interval=1&limit=3',d=>d?.result?.list],
    ['https://api.bybit.com/v5/market/kline?category=spot&symbol='+c+'USDT&interval=1&limit=3',d=>d?.result?.list],
    ['https://www.okx.com/api/v5/market/candles?instId='+c+'-USDT&bar=1m&limit=3',d=>d?.data],
  ];
  for(const [url,pick] of sources){try{const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(2500)});if(!r.ok)continue;const rows=pick(await r.json());if(Array.isArray(rows)&&rows.length)return rows;}catch{}}
  return null;
}
function candleRange(rows,createdAt) {
  if(!Array.isArray(rows))return null;
  const parsed=Date.parse(createdAt||''),since=Number.isFinite(parsed)?parsed:0;
  const fresh=rows.filter(r=>Number(r[0])>=since);
  if(!fresh.length)return null;
  const hi=Math.max(...fresh.map(r=>Number(r[2]))),lo=Math.min(...fresh.map(r=>Number(r[3])));
  return Number.isFinite(hi)&&Number.isFinite(lo)&&hi>0?{hi,lo}:null;
}
function directionOf(note) {
  for(const line of String(note||'').split(NL)){const i=line.indexOf(':');if(i>=0&&line.slice(0,i).trim()==='جهت')return line.slice(i+1).trim().toLowerCase();}
  return '';
}
function numberText(value) {
  return Number(value).toLocaleString('en-US',{maximumFractionDigits:value>=1000?2:value>=1?4:6});
}

export default async function (_input,ctx) {
  if(ctx.initData?.start_param!=='worker-cron')reject('Forbidden');
  const users=await db.select().from(miniUsers).all();
  let checked=0,triggered=0,failed=0;
  for(const user of users){
    const data=await read(user.userId,'alerts',{alerts:[],last_id:0});
    const alerts=Array.isArray(data.alerts)?data.alerts:[];
    const pending=alerts.filter(a=>(a.triggered||[]).length<(a.targets||[]).length);
    if(!pending.length){await write(user.userId,'last_cron',{t:Date.now(),p:0,m:'',e:'',n:null});continue;}
    const age=coin=>Math.min(...pending.filter(a=>a.coin===coin).map(a=>{const t=Date.parse(a.last_checked||'');return Number.isFinite(t)?t:0;}));
    const coins=[...new Set(pending.map(a=>a.coin))].sort((a,b)=>age(a)-age(b)).slice(0,3);
    const prices=new Map(),ranges=new Map();
    await Promise.all(coins.map(async coin=>prices.set(coin,await priceFor(coin))));
    if(coins.length<=4)await Promise.all(coins.map(async coin=>ranges.set(coin,await getCandles(coin))));
    let changed=false,missing=[];
    for(const alert of pending){
      if(!prices.has(alert.coin))continue;
      const price=prices.get(alert.coin);
      if(price==null){if(!missing.includes(alert.coin))missing.push(alert.coin);alert.last_checked=new Date().toISOString();changed=true;continue;}
      checked++;
      const prev=alert.prev_price;
      const rg=candleRange(ranges.get(alert.coin),alert.created_at);
      const hi=rg?Math.max(rg.hi,price):price,lo=rg?Math.min(rg.lo,price):price;
      let entry=alert.entry_price!=null?alert.entry_price:alert.ref_price,entryHealed=false,needsPrev=false;
      if(entry==null){const levels=(alert.targets||[]).map(t=>Number(t.price));entry=levels.length>=2?(Math.min(...levels)+Math.max(...levels))/2:price;entryHealed=true;}
      for(const target of alert.targets||[]){
        const tid=target.id||0;if((alert.triggered||[]).includes(tid))continue;
        const level=Number(target.price),direction=directionOf(target.note);
        let hit=false;
        if((direction==='long'||direction==='short')&&level===entry){
          if(prev==null)needsPrev=true;
          else if((prev<level&&price>=level)||(prev>level&&price<=level))hit=true;
          if(rg&&lo<=level&&level<=hi)hit=true;
        }else if(direction==='long'){
          if(level>=entry){if(hi>=level)hit=true;}else if(lo<=level)hit=true;
        }else if(direction==='short'){
          if(level>entry){if(hi>=level)hit=true;}else if(lo<=level)hit=true;
        }else{
          needsPrev=true;
          if(price===level||(rg&&lo<=level&&level<=hi))hit=true;
          else if(prev!=null&&prev!==level&&((prev<level&&price>=level)||(prev>level&&price<=level)))hit=true;
        }
        if(price===level)hit=true;
        if(!hit)continue;
        const last=alert.last_triggered?.[String(tid)]||0,now=Date.now()/1000;
        if(last&&now-last<120)continue;
        const kind=(direction==='long'||direction==='short')?(level===entry?'en':direction==='long'?(level>entry?'tp':'sl'):(level>entry?'sl':'tp')):'n';
        const lang=(await read(user.userId,'settings',{})).lang||'fa';
        const heading=kind==='tp'?(lang==='en'?'✅ TP hit':'✅ تارگت رسید'):kind==='sl'?(lang==='en'?'🛑 Stop-loss hit':'🛑 استاپ خورد'):kind==='en'?(lang==='en'?'🚪 Entry reached':'🚪 به نقطه ورود رسید'):(lang==='en'?'🔔 Price target reached':'🔔 قیمت به هدف رسید');
        const dir=direction?(direction==='long'?'🟢 Long':'🔴 Short'):'';
        const message=[heading,alert.coin+(dir?' '+dir:''),(lang==='en'?'Target: ':'🎯 تارگت: ')+numberText(level),(lang==='en'?'Current: ':'💹 قیمت فعلی: ')+numberText(price),entry!=null?(lang==='en'?'Entry: ':'ورود: ')+numberText(entry):''].filter(Boolean).join(NL);
        try{
          await api.sendMessage({chat_id:user.userId,text:message,disable_web_page_preview:true});
          alert.triggered=alert.triggered||[];alert.triggered.push(tid);
          alert.last_triggered=alert.last_triggered||{};alert.last_triggered[String(tid)]=now;
          changed=true;triggered++;
        }catch(e){failed++;console.warn('Alert delivery failed',user.userId,alert.id,e?.description||e?.message||String(e));}
      }
      if(needsPrev)alert.prev_price=price;
      alert.last_price=price;alert.last_checked=new Date().toISOString();
      if(entryHealed&&alert.entry_price==null&&alert.ref_price==null)alert.ref_price=entry;
      changed=true;
    }
    if(changed)await write(user.userId,'alerts',data);
    await write(user.userId,'last_cron',{t:Date.now(),p:pending.length,m:missing.join(','),e:failed?'Telegram notification errors':'',n:null});
  }
  return {ok:true,users:users.length,checked,triggered,failed};
}
