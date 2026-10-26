import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createQuoteFeed} from '../cloudflare/quotes.mjs'
import {createEngine} from '../cloudflare/core.mjs'
import {emptyMain} from '../cloudflare/storage.mjs'
import {createHmac} from 'node:crypto'

const pairs=['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF']
const env={OANDA_TOKEN:'artificial',OANDA_ACCOUNT:'fixture',OANDA_SIDE:'mid',PRICE_SOURCE:'oanda'}
function setup(){
 let calls=0,fail=false,closed=false,old=false
 const FETCH=async url=>{
  if(url.endsWith('/instruments'))return Response.json({instruments:[]})
  if(url.includes('/pricing?')){
   calls++;if(fail)throw new Error('artificial outage')
   return Response.json({prices:pairs.map((instrument,i)=>({instrument,time:new Date(Date.now()-(old?120000:0)).toISOString(),tradeable:!closed,bids:[{price:String(i?1.3:1.1)}],asks:[{price:String(i?1.3002:1.1002)}]}))})
  }
  throw new Error('Unexpected network: '+url)
 }
 const feed=createQuoteFeed({...env,FETCH})
 return {feed,FETCH,get calls(){return calls},set fail(v){fail=v},set closed(v){closed=v},set old(v){old=v}}
}
test('cold REST seed includes all six DXY constituents; reconciliation is bounded and recovers outages',async()=>{
 const clock=Date.now;let now=clock();Date.now=()=>now
 try{
  const f=setup(),ticks=[];await f.feed.refresh((...t)=>ticks.push(t))
  assert.ok(f.feed.prices.EURUSD);assert.ok(f.feed.prices.GBPUSD);assert.ok(f.feed.prices.DXY);assert.ok(f.feed.fresh('DXY'))
  await f.feed.refresh();assert.equal(f.calls,1)
  now+=21000;await f.feed.refresh();assert.equal(f.calls,2)
  now+=31000;f.fail=true;await f.feed.refresh();assert.equal(f.feed.fresh('DXY'),false);assert.ok(f.feed.prices.DXY)
  now+=21000;f.fail=false;await f.feed.refresh();assert.ok(f.feed.fresh('DXY'));assert.equal(f.calls,4)
 }finally{Date.now=clock}
})
test('heartbeat-only stream stays connected while REST reconciliation refreshes the full basket',async()=>{
 const clock=Date.now;let now=clock();Date.now=()=>now
 const f=setup(),ac=new AbortController();let controller
 const FETCH=async(url,init)=>url.includes('/pricing/stream?')?new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('{"type":"HEARTBEAT"}\n'))},cancel(){}})):f.FETCH(url,init)
 const feed=createQuoteFeed({...env,FETCH})
 const running=feed.stream(null,ac.signal)
 try{
  for(let i=0;i<50&&!feed.status().connected;i++)await new Promise(r=>setImmediate(r))
  assert.equal(feed.status().connected,true);assert.ok(feed.prices.DXY)
  const previous=feed.prices.DXY.observedAt;now+=31000
  controller.enqueue(new TextEncoder().encode('{"type":"HEARTBEAT"}\n'))
  assert.equal(feed.fresh('DXY'),false)
  await feed.refresh();assert.ok(feed.fresh('DXY'));assert.ok(feed.prices.DXY.observedAt>previous);assert.equal(feed.status().source,'stream')
 }finally{ac.abort();await running;Date.now=clock}
})
test('cache survives recreation without refreshing timestamps or firing alerts; changed config invalidates it',async()=>{
 const f=setup();await f.feed.refresh();const cache=new Map();let writes=0
 const store=async([op,k,v])=>{if(op==='SET'){writes++;cache.set(k,v)}return cache.get(k)??null}
 await f.feed.checkpoint(store);await f.feed.checkpoint(store);assert.equal(writes,1)
 const raw=cache.get('tg-alerts:quotes:v1'),restored=createQuoteFeed(env);restored.restore(raw)
 assert.deepEqual(restored.prices.DXY,f.feed.prices.DXY);assert.equal(restored.fresh('DXY'),false);assert.equal(restored.tradeable('DXY'),false)
 const changed=createQuoteFeed({...env,OANDA_SIDE:'bid'});changed.restore(raw);assert.deepEqual(changed.prices,{})
 restored.restore('{bad');assert.ok(restored.prices.DXY)
})
test('old or closed REST prices remain available for display but never dispatch alert ticks',async()=>{
 for(const mode of ['closed','old']){const f=setup();f[mode]=true;const ticks=[];await f.feed.refresh((...t)=>ticks.push(t));assert.equal(ticks.length,0);assert.ok(f.feed.prices.DXY);assert.equal(f.feed.fresh('DXY'),false)}
})
test('cache storage errors propagate and checkpoint stays dirty for retry',async()=>{
 const f=setup();await f.feed.refresh();await assert.rejects(f.feed.checkpoint(async()=>{throw new Error('disk')}),/disk/)
 let saved=false;await f.feed.checkpoint(async()=>{saved=true});assert.equal(saved,true)
})
test('API returns expired cached prices as stale, keeps purchased assets, and enforces ownership',async()=>{
 const f=setup();await f.feed.refresh();let raw;await f.feed.checkpoint(async c=>{raw=c[2]})
 const main={...emptyMain(),owned:{'1':['DXY','XAGUSD']}}
 const command=async([op,key])=>op==='GET'?(key==='tg-alerts-db'?JSON.stringify(main):key==='tg-alerts:quotes:v1'?raw:null):'OK'
 const secret='artificial-signing-key'
 const core=await createEngine({...env,ACCESS_SIGNING_SECRET:secret,LOCAL_STORE:{command},FETCH:f.FETCH})
 const token=uid=>{const b=Buffer.from(JSON.stringify({sub:uid,project:'alerts',iat:Date.now(),exp:Date.now()+600000})).toString('base64url');return b+'.'+createHmac('sha256',secret).update(b).digest('hex')}
 const call=async(path,uid='1')=>(await core.http(new Request('https://fixture/api/'+path,{headers:{'x-access-token':token(uid)}}))).json()
 const config=await call('config');assert.ok(config.symbols.DXY);assert.ok(config.symbols.XAGUSD)
 const prices=await call('prices');assert.ok(prices.DXY);assert.equal(prices.DXY.stale,true);assert.equal(prices.DXY.observedAt,f.feed.prices.DXY.observedAt)
 assert.equal((await call('prices','2')).DXY,undefined)
})
