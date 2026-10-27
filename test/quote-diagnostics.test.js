import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createQuoteFeed} from '../cloudflare/quotes.mjs'

test('Capital diagnostics distinguish source age from receipt age without changing freshness',async()=>{
 const clock=Date.now;let now=Date.parse('2026-10-27T12:00:00Z'),source=now,status='TRADEABLE'
 Date.now=()=>now
 const secret='private-artificial-credential',feed=createQuoteFeed({CAPITAL_API_KEY:secret,CAPITAL_IDENTIFIER:secret,CAPITAL_PASSWORD:secret,CAPITAL_EPIC_DXY:'DXFIXTURE',FETCH:async url=>url.endsWith('/session')?Response.json({}, {headers:{cst:secret,'x-security-token':secret}}):Response.json({markets:[{epic:'DXFIXTURE',bid:100,offer:101,marketStatus:status,updateTimeUTC:source==null?'invalid':new Date(source).toISOString(),private:secret}]})})
 const ticks=[]
 try{
  await feed.capital((...args)=>ticks.push(args))
  let d=feed.status().capitalDiagnostics
  assert.equal(d.quoteTimingVersion,1);assert.equal(d.quotes.DXY.sourceAgeMs,0);assert.equal(d.quotes.DXY.receivedAgeMs,0);assert.equal(feed.fresh('DXY'),true)
  now+=95000
  await feed.capital((...args)=>ticks.push(args))
  d=feed.status().capitalDiagnostics
  assert.equal(d.httpStatus,200);assert.equal(d.quotes.DXY.reason,'stale');assert.equal(d.quotes.DXY.sourceAgeMs,95000);assert.equal(d.quotes.DXY.receivedAgeMs,0);assert.equal(d.quotes.DXY.marketStatus,'TRADEABLE')
  assert.equal(feed.fresh('DXY'),false);assert.equal(ticks.length,1)
  now+=5000;d=feed.status().capitalDiagnostics
  assert.equal(d.quotes.DXY.sourceAgeMs,100000);assert.equal(d.quotes.DXY.receivedAgeMs,5000)
  assert.equal(d.quotes.DXY.sourceTime,source);assert.equal(d.quotes.DXY.receivedAt,now-5000)
  assert.ok(!JSON.stringify(d).includes(secret));assert.ok(!JSON.stringify(d).includes('DXFIXTURE'))
  source=now;await feed.capital((...args)=>ticks.push(args));assert.equal(feed.fresh('DXY'),true);assert.equal(ticks.length,2)
  source=null;status=secret;await feed.capital((...args)=>ticks.push(args));d=feed.status().capitalDiagnostics
  assert.equal(d.quotes.DXY.sourceTime,null);assert.equal(d.quotes.DXY.sourceAgeMs,null);assert.equal(d.quotes.DXY.marketStatus,'UNKNOWN');assert.ok(!JSON.stringify(d).includes(secret));assert.equal(feed.fresh('DXY'),false)
 }finally{Date.now=clock}
})
