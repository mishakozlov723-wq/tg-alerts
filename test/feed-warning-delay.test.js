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
