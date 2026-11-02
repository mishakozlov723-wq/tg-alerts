// Fixtures follow the current /markets?searchTerm= response with authoritative updateTimeUTC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCandles } from '../cloudflare/candles.mjs'
import { createQuoteFeed } from '../cloudflare/quotes.mjs'
function fixture() {
 const requests=[],data=new Map();let broken=false
 const env={CAPITAL_API_KEY:'test',CAPITAL_IDENTIFIER:'test',CAPITAL_PASSWORD:'test',FETCH:async input=>{
  const u=new URL(input);requests.push(u)
  if(broken)return new Response('',{status:503})
  if(u.pathname.endsWith('/session'))return Response.json({}, {headers:{cst:'test','x-security-token':'test'}})
  if(u.searchParams.has('searchTerm'))return Response.json({markets:[{epic:'TEST_DXY',instrumentName:'US Dollar Index',bid:100,offer:102,marketStatus:'TRADEABLE',updateTimeUTC:new Date().toISOString()}]})
  if(u.pathname.includes('/prices/')) {
   const step={MINUTE_15:900,HOUR:3600,HOUR_4:14400,DAY:86400}[u.searchParams.get('resolution')]
   const end=u.searchParams.has('to')?Date.parse(u.searchParams.get('to')+'Z')/1000:Date.now()/1000
   const last=Math.floor(end/step)*step,count=Number(u.searchParams.get('max'))
   return Response.json({prices:Array.from({length:count},(_,i)=>({snapshotTimeUTC:new Date((last-(count-1-i)*step)*1000).toISOString(),openPrice:{bid:99,ask:101},highPrice:{bid:101,ask:103},lowPrice:{bid:98,ask:100},closePrice:{bid:100,ask:102}}))})
  }
  return Response.json({marketDetails:[{instrument:{epic:'TEST_DXY'},snapshot:{bid:100,offer:102,marketStatus:'TRADEABLE',updateTimeUTC:new Date().toISOString()}}]})
 }}
 return {env,requests,store:async([op,k,v])=>op==='GET'?data.get(k)||null:(data.set(k,v),'OK'),break(){broken=true}}
}
test('DXY Capital history: four frames, two-page cap, shared session, side and persisted cache',async()=>{
 const f=fixture(),source=createCandles(f.env,f.store)
 for(const [tf,count] of [['M15',2000],['H1',2000],['H4',1500],['D1',1000]]) {
  const p=new URLSearchParams({symbol:'DXY',timeframe:tf}),r=await source.get(p)
  assert.equal(r.source,'Capital');assert.equal(r.candles.length,300);assert.equal(r.limit,count);assert.equal(r.candles[0].open,100)
  assert.equal(r.stale,false)
  const older=await source.get(new URLSearchParams({symbol:'DXY',timeframe:tf,before:String(r.candles[0].time)}));assert.ok(older.candles.at(-1).time<r.candles[0].time)
 }
 assert.equal(f.requests.filter(u=>u.pathname.endsWith('/session')).length,1)
 assert.equal(f.requests.filter(u=>u.searchParams.has('searchTerm')).length,1)
 assert.equal(f.requests.filter(u=>u.pathname.includes('/prices/')).length,7)
 f.break();const restored=await createCandles(f.env,f.store).get(new URLSearchParams('symbol=DXY'));assert.equal(restored.stale,true)
})
test('Capital DXY ticks use same discovered instrument and price side as chart',async()=>{
 const f=fixture(),feed=createQuoteFeed(f.env),ticks=[]
 await feed.capital((s,p)=>ticks.push([s,p]))
 assert.equal(feed.prices.DXY.price,101);assert.deepEqual(ticks,[['DXY',101]])
 assert.ok(f.requests.some(u=>u.pathname.endsWith('/markets')&&u.searchParams.get('searchTerm')==='Dollar Index'))
})
test('metals and GER40 isolate four-frame caches and share quote epic, side and offset',async()=>{
 const f=fixture(),original=f.env.FETCH
 Object.assign(f.env,{CAPITAL_EPIC_GER40:'CUSTOM_DE',CAPITAL_SIDE:'ask',OFFSET_XAUUSD:'5'})
 const epics={GER40:'CUSTOM_DE',XAUUSD:'GOLD',XAGUSD:'SILVER'}
 f.env.FETCH=async input=>{
  const u=new URL(input)
  if(u.searchParams.has('searchTerm')&&u.searchParams.get('searchTerm')!=='Dollar Index')return Response.json({markets:Object.values(epics).map(epic=>({epic,bid:100,offer:102,marketStatus:'TRADEABLE',updateTimeUTC:new Date().toISOString()}))})
  return original(input)
 }
 const source=createCandles(f.env,f.store),feed=createQuoteFeed(f.env)
 await feed.capital(()=>{})
 for(const [symbol,epic] of Object.entries(epics)) {
  for(const timeframe of ['M15','H1','H4','D1']) {
   const r=await source.get(new URLSearchParams({symbol,timeframe}))
   assert.equal(r.symbol,symbol);assert.equal(r.source,'Capital');assert.equal(r.side,'ask')
   assert.equal(r.candles.at(-1).close,feed.prices[symbol].price)
   assert.ok(f.requests.some(u=>u.pathname.endsWith('/prices/'+epic)))
   const before=f.requests.length
   await source.get(new URLSearchParams({symbol,timeframe}))
   assert.equal(f.requests.length,before)
  }
 }
 assert.equal(f.requests.filter(u=>u.pathname.endsWith('/session')).length,1)
 f.break()
 const restored=createCandles(f.env,f.store)
 for(const symbol of Object.keys(epics)) {
  const r=await restored.get(new URLSearchParams({symbol}));assert.equal(r.symbol,symbol);assert.equal(r.stale,true)
 }
})
test('DXY refuses ambiguous instrument search instead of guessing',async()=>{
 const f=fixture(),original=f.env.FETCH
 f.env.FETCH=async u=>new URL(u).searchParams.has('searchTerm')?Response.json({markets:[{epic:'a',instrumentName:'Dollar Index'},{epic:'b',instrumentName:'US Dollar Index'}]}):original(u)
 await assert.rejects(createCandles(f.env,f.store).get(new URLSearchParams('symbol=DXY')),/capital_dxy_unavailable/)
 assert.equal(f.requests.filter(u=>u.pathname.includes('/prices/')).length,0)
})
test('a storage failure while restoring a Capital chart is not cached until restart',async()=>{
 const f=fixture();let fail=true
 const store=async command=>{if(fail&&command[0]==='GET')throw Object.assign(new Error('disk'),{storageFailure:true});return f.store(command)}
 const source=createCandles(f.env,store),params=()=>new URLSearchParams({symbol:'DXY',timeframe:'H1'})
 await assert.rejects(source.get(params()),/disk/)
 fail=false
 const r=await source.get(params());assert.equal(r.source,'Capital');assert.equal(r.candles.length,300)
})
