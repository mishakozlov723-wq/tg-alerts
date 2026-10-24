import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuoteFeed } from '../cloudflare/quotes.mjs'

const credentials = { CAPITAL_API_KEY:'fixture', CAPITAL_IDENTIFIER:'fixture', CAPITAL_PASSWORD:'fixture' }
test('Capital uses broker UTC time, rejects missing/future/old/closed quotes and never rejuvenates snapshots', async () => {
 const clock=Date.now; let now=Date.parse('2026-10-21T12:00:00Z'), raw=new Date(now).toISOString().slice(0,-1), status='TRADEABLE', bid=100
 Date.now=()=>now
 const feed=createQuoteFeed({...credentials,FETCH:async url=>url.endsWith('/session')?Response.json({}, {headers:{cst:'fixture','x-security-token':'fixture'}}):Response.json({marketDetails:[{instrument:{epic:'GOLD'},snapshot:{bid,offer:bid+1,marketStatus:status,updateTimeUTC:raw}}]})})
 const ticks=[]
 try {
  await feed.capital((...x)=>ticks.push(x));assert.equal(feed.prices.XAUUSD.dataTs,now);assert.equal(feed.fresh('XAUUSD'),true)
  now+=31000;await feed.capital((...x)=>ticks.push(x));assert.equal(ticks.length,1);assert.equal(feed.fresh('XAUUSD'),false)
  for(const invalid of [undefined,'invalid',new Date(now+120000).toISOString()]) {
   raw=invalid;await feed.capital((...x)=>ticks.push(x));assert.equal(feed.fresh('XAUUSD'),false);assert.equal(ticks.length,1)
  }
  raw=new Date(now).toISOString();await feed.capital((...x)=>ticks.push(x));assert.equal(ticks.length,2)
  const price=feed.prices.XAUUSD.price;raw=new Date(now-1000).toISOString();bid=200
  await feed.capital((...x)=>ticks.push(x));assert.equal(feed.prices.XAUUSD.price,price);assert.equal(ticks.length,2)
  status='CLOSED';raw=new Date(now+1).toISOString();await feed.capital((...x)=>ticks.push(x));assert.equal(feed.fresh('XAUUSD'),false);assert.equal(ticks.length,2)
 } finally {Date.now=clock}
})
test('OANDA reconnects and explicit reconciliation share the REST throttle, including failures', async () => {
 const clock=Date.now;let now=clock(),pricing=0,streams=0,fail=false
 Date.now=()=>now
 const ac=new AbortController()
 const feed=createQuoteFeed({OANDA_TOKEN:'fixture',OANDA_ACCOUNT:'fixture',FETCH:async url=>{
  if(url.endsWith('/instruments'))return Response.json({instruments:[]})
  if(url.includes('/pricing?')){pricing++;if(fail)throw new Error('fixture failure');return Response.json({prices:[]})}
  if(url.includes('/pricing/stream?')){streams++;return Response.json({}, {status:503})}
  throw new Error('Unexpected network')
 }})
 const running=feed.stream(null,ac.signal)
 try {
  await new Promise(r=>setTimeout(r,1150));assert.ok(streams>=2);assert.equal(pricing,1)
  await feed.refresh();assert.equal(pricing,1)
  now+=20000;fail=true;await feed.refresh();assert.equal(pricing,2)
  await new Promise(r=>setTimeout(r,1100));assert.equal(pricing,2)
  now+=20000;fail=false;await feed.refresh();assert.equal(pricing,3)
 } finally {ac.abort();await running;Date.now=clock}
})
