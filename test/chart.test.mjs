import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createCandles, parseCandles } from '../cloudflare/candles.mjs'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'
const base = Math.floor(Date.now()/900000)*900-900*2100
const candle = (i, side='mid') => ({ time: new Date((base+i*900)*1000).toISOString(), complete:true, [side]:{o:'1.3',h:'1.32',l:'1.29',c:'1.31'} })
const params = (tf='M15', extra='') => new URLSearchParams('symbol=GBPUSD&timeframe='+tf+extra)
function fixture() {
  const data=new Map(), requests=[];let time=Date.now(), broken=false
  const store=async([op,k,v])=>op==='GET'?data.get(k)||null:(data.set(k,v),'OK')
  const env={OANDA_TOKEN:'artificial',OANDA_SIDE:'mid',OANDA_ENV:'practice',FETCH:async input=>{
    const u=new URL(input);requests.push(u)
    if(broken) return Response.json({}, {status:503})
    const side={M:'mid',B:'bid',A:'ask'}[u.searchParams.get('price')]
    return Response.json({instrument:u.pathname.split('/')[3],granularity:u.searchParams.get('granularity'),candles:Array.from({length:Number(u.searchParams.get('count'))},(_,i)=>candle(i,side))})
  }}
  return {env,store,data,requests,now:()=>time,advance:()=>{time+=61000},break:()=>{broken=true}}
}
test('bounded history, pagination, shared cache, refresh and failure backoff',async()=>{
 const f=fixture(),source=createCandles(f.env,f.store,f.now)
 const first=await source.get(params());assert.equal(first.candles.length,300);assert.equal(first.hasMore,true);assert.equal(first.stale,false)
 assert.equal(f.requests[0].searchParams.get('count'),'2000');assert.equal(f.requests[0].searchParams.get('price'),'M')
 const older=await source.get(params('M15','&before='+first.candles[0].time));assert.ok(older.candles.at(-1).time<first.candles[0].time);assert.equal(f.requests.length,1)
 f.advance();await source.get(params());assert.equal(f.requests[1].searchParams.get('count'),'10')
 f.advance();f.break();assert.equal((await source.get(params())).stale,true);assert.equal((await source.get(params())).stale,true);assert.equal(f.requests.length,3)
})
test('side mapping, fixed frames and no arbitrary instrument/provider access',async()=>{
 for(const [side,component]of [['bid','B'],['ask','A'],['mid','M']]) {
  const f=fixture(),source=createCandles({...f.env,OANDA_SIDE:side},f.store,f.now)
  const r=await source.get(params('D1'));assert.equal(r.side,side);assert.equal(f.requests[0].searchParams.get('price'),component);assert.equal(f.requests[0].searchParams.get('granularity'),'D')
 }
 const f=fixture(),source=createCandles(f.env,f.store)
 await assert.rejects(source.get(new URLSearchParams('symbol=UNKNOWN')),/unsupported_chart/)
 await assert.rejects(source.get(params('M1')),/unsupported_chart/)
 await assert.rejects(source.get(params('M15','&before=abc')),/invalid_cursor/);assert.equal(f.requests.length,0)
})
test('single-flight deduplicates cold concurrent requests; restore respects source identity',async()=>{
 const f=fixture();let release;const gate=new Promise(r=>release=r),original=f.env.FETCH
 const s=createCandles({...f.env,FETCH:async u=>{await gate;return original(u)}},f.store)
 const calls=Array.from({length:8},()=>s.get(params()));release();assert.ok((await Promise.all(calls)).every(x=>x.candles.length===300));assert.equal(f.requests.length,1)
 f.break();const restored=await createCandles(f.env,f.store).get(params());assert.equal(restored.stale,true)
 await assert.rejects(createCandles({...f.env,OANDA_SIDE:'ask'},f.store).get(params()),/candles_unavailable/)
})
test('EUR and GBP have isolated shared caches and provider instruments',async()=>{
 const f=fixture(),source=createCandles(f.env,f.store,f.now)
 const eur=new URLSearchParams('symbol=EURUSD&timeframe=M15')
 await Promise.all([source.get(params()),source.get(eur),source.get(eur)])
 assert.equal(f.requests.length,2)
 assert.deepEqual(new Set(f.requests.map(u=>u.pathname)),new Set(['/v3/instruments/GBP_USD/candles','/v3/instruments/EUR_USD/candles']))
 assert.equal(f.data.size,2)
 f.break();assert.equal((await createCandles(f.env,f.store).get(eur)).stale,true)
})
test('invalid broker OHLC never accepted',()=>{
 assert.throws(()=>parseCandles([{...candle(1),mid:{o:'1.3',h:'1.2',l:'1.1',c:'1.3'}}],'mid'),/invalid_candles/)
 assert.throws(()=>parseCandles([],'mid'),/candles_unavailable/)
})
test('authenticated chart and existing owned alert CRUD survive engine restart without any chart triggering',async()=>{
 const db=new DatabaseSync(':memory:'),store=createLocalStore({sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>fn()});store.initialize({main:{...emptyMain(),owned:{'123':['DXY']}}})
 const secret='artificial-signing-key',payload=Buffer.from(JSON.stringify({project:'alerts',sub:'123',exp:Date.now()+600000})).toString('base64url'),token=payload+'.'+createHmac('sha256',secret).update(payload).digest('hex')
 const f=fixture(),env={...f.env,LOCAL_STORE:store,ACCESS_SIGNING_SECRET:secret,REQUIRE_ACCESS:'true',PRICE_SOURCE:'oanda',MONITOR_ALERTS:'false'}
 const request=(core,path,method='GET',body,auth=token)=>core.http(new Request('https://local/api/'+path,{method,headers:{'x-access-token':auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}))
 try {
  let core=await createEngine(env)
  assert.equal((await request(core,'chart/candles', 'GET',null,'bad')).status,401);assert.equal(f.requests.length,0)
  assert.equal((await request(core,'chart/candles?timeframe=H4')).status,200)
  const created=await(await request(core,'alerts','POST',{symbol:'GBPUSD',dir:'above',level:1.4})).json();assert.equal(created.status,'active')
  core=await createEngine(env);const list=await(await request(core,'alerts')).json();assert.equal(list[0].level,1.4);assert.equal(list[0].status,'active')
  const other=payload.replace(/.$/,'x');assert.equal((await request(core,'alerts','GET',null,other)).status,401)
  assert.equal((await request(core,'alerts/'+created.id,'DELETE')).status,200);assert.deepEqual(await(await request(core,'alerts')).json(),[])
  assert.deepEqual(JSON.parse(await store.command(['GET','tg-alerts-db'])).owned,{'123':['DXY']})
 } finally {db.close()}
})
