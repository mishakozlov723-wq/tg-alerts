import {test} from 'node:test'
import assert from 'node:assert/strict'
import {FEED_WARNING_DELAY_MS,sampleFeedWatch} from '../cloudflare/feed-watch.mjs'
const recipients=fresh=>({'1':{EURUSD:fresh,GBPUSD:true}})
test('quote warning is silent at 30s, 60s and 179999ms, then fires once at three minutes',()=>{
 const state={},base=1000000
 const sample=(offset,fresh=false)=>sampleFeedWatch(state,{now:base+offset,open:true,recipients:recipients(fresh)}).messages
 assert.equal(FEED_WARNING_DELAY_MS,180000)
 for(const offset of [0,30000,60000,120000,179999])assert.deepEqual(sample(offset),[])
 const warning=sample(180000)
 assert.equal(warning.length,1);assert.equal(warning[0].kind,'warning');assert.match(warning[0].text,/at least 3 minutes/);assert.match(warning[0].text,/EURUSD/);assert.doesNotMatch(warning[0].text,/GBPUSD/)
 assert.deepEqual(sample(181000),[])
 assert.deepEqual(sample(182000,true),[]);assert.deepEqual(sample(211999,true),[]);assert.equal(sample(212000,true)[0].kind,'recovery');assert.deepEqual(sample(213000,true),[])
})
test('short interruptions recover silently and a new interruption starts a fresh three-minute timer',()=>{
 let state={},base=2000000
 const sample=(offset,fresh=false)=>sampleFeedWatch(state,{now:base+offset,open:true,recipients:recipients(fresh)}).messages
 assert.deepEqual(sample(0),[]);assert.deepEqual(sample(90000),[]);assert.deepEqual(sample(100000,true),[]);assert.deepEqual(sample(140000,true),[])
 assert.deepEqual(sample(150000),[]);assert.deepEqual(sample(329999),[])
 state=JSON.parse(JSON.stringify(state));assert.equal(sample(330000)[0].kind,'warning')
})
test('a broker pause (null) is silent, resets the timer, and a failure that outlasts it still warns',()=>{
 const state={},base=3000000
 const sample=(offset,value)=>sampleFeedWatch(state,{now:base+offset,open:true,recipients:{'1':{EURUSD:value,DXY:value}}}).messages
 assert.deepEqual(sample(0,false),[]);assert.deepEqual(sample(40000,false),[])
 for(let offset=60000;offset<=420000;offset+=10000)assert.deepEqual(sample(offset,null),[])
 assert.deepEqual(sample(430000,true),[]);assert.deepEqual(sample(470000,true),[])
 for(let offset=480000;offset<=840000;offset+=10000)assert.deepEqual(sample(offset,null),[])
 assert.deepEqual(sample(850000,false),[]);assert.deepEqual(sample(1029999,false),[])
 const warning=sample(1030000,false);assert.equal(warning.length,1);assert.equal(warning[0].kind,'warning')
})
test('a pause after a delivered warning sends no recovery until quotes are really fresh again',()=>{
 const state={},base=4000000
 const sample=(offset,value)=>sampleFeedWatch(state,{now:base+offset,open:true,recipients:{'1':{EURUSD:value}}}).messages
 sample(0,false);assert.equal(sample(180000,false)[0].kind,'warning')
 for(let offset=190000;offset<=600000;offset+=10000)assert.deepEqual(sample(offset,null),[])
 assert.deepEqual(sample(610000,true),[]);assert.equal(sample(640000,true)[0].kind,'recovery')
})
test('OANDA daily FX break is 16:59-17:05 New York in winter and summer',async()=>{
 const {fxDailyBreak}=await import('../cloudflare/quotes.mjs')
 for(const[iso,expected]of [['2026-11-11T21:58:59Z',false],['2026-11-11T21:59:00Z',true],['2026-11-11T22:04:59Z',true],['2026-11-11T22:05:00Z',false],['2026-06-10T20:59:00Z',true],['2026-06-10T21:05:00Z',false],['2026-06-10T21:59:00Z',false]])assert.equal(fxDailyBreak(Date.parse(iso)),expected,iso)
})
test('broker-reported closed quotes pause EURUSD and derived DXY only while the status stays observed',async()=>{
 const {createQuoteFeed}=await import('../cloudflare/quotes.mjs')
 const original=Date.now;let now=Date.parse('2026-11-11T12:00:00Z'),tradeable=false
 try{
  Date.now=()=>now
  const feed=createQuoteFeed({OANDA_TOKEN:'fixture',OANDA_ACCOUNT:'fixture',FETCH:async url=>{
   if(url.endsWith('/instruments'))return Response.json({instruments:[]})
   if(url.includes('/pricing?'))return Response.json({prices:['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF'].map(instrument=>({instrument,tradeable,time:String(now/1000),bids:[{price:'1.1'}],asks:[{price:'1.2'}]}))})
   throw new Error('Unexpected network')
  }})
  assert.equal(feed.paused('EURUSD'),false)
  await feed.refresh(null)
  assert.equal(feed.fresh('EURUSD'),false);assert.equal(feed.paused('EURUSD'),true);assert.equal(feed.paused('DXY'),true)
  now+=179000;assert.equal(feed.paused('EURUSD'),true)
  now+=2000;assert.equal(feed.paused('EURUSD'),false);assert.equal(feed.paused('DXY'),false)
  tradeable=true;await feed.refresh(null)
  assert.equal(feed.fresh('EURUSD'),true);assert.equal(feed.paused('EURUSD'),false);assert.equal(feed.paused('DXY'),false)
  now=Date.parse('2026-11-11T22:01:00Z');assert.equal(feed.paused('EURUSD'),true)
 }finally{Date.now=original}
})
