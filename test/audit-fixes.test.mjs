import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createHmac} from 'node:crypto'
import {sampleFeedWatch} from '../cloudflare/feed-watch.mjs'
import {createQuoteFeed} from '../cloudflare/quotes.mjs'
import {createCapitalCandles} from '../cloudflare/capital-candles.mjs'
import {createLocalStore,emptyMain} from '../cloudflare/storage.mjs'
import {createEngine} from '../cloudflare/core.mjs'
import {newReminder} from '../live.js'
function local(main=emptyMain()) {
 const db=new DatabaseSync(':memory:')
 const store=createLocalStore({sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>{db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}})
 store.initialize({main});return{db,store}
}
test('three-minute stale timers never transfer between instruments, including restart',()=>{
 let state={};const t=1800000000000,run=(elapsed,symbols)=>sampleFeedWatch(state,{now:t+elapsed,open:true,recipients:{123:symbols}}).messages
 run(0,{EURUSD:false,GBPUSD:true});run(100000,{EURUSD:true,GBPUSD:false});state=JSON.parse(JSON.stringify(state))
 assert.equal(run(180000,{EURUSD:true,GBPUSD:false}).length,0)
 assert.equal(run(279999,{EURUSD:true,GBPUSD:false}).length,0)
 const r=run(280000,{EURUSD:true,GBPUSD:false});assert.equal(r.length,1);assert.deepEqual(r[0].symbols,['GBPUSD'])
})
test('EURUSD recovery does not wait for unrelated stale GBPUSD; old shared timer is not inherited',()=>{
 const state={},t=1800000000000,run=(n,s)=>sampleFeedWatch(state,{now:t+n,open:true,recipients:{123:s}}).messages
 run(0,{EURUSD:false,GBPUSD:true});assert.equal(run(180000,{EURUSD:false,GBPUSD:true})[0].kind,'warning')
 run(190000,{EURUSD:true,GBPUSD:false});const r=run(220000,{EURUSD:true,GBPUSD:false});assert.equal(r[0].kind,'recovery');assert.deepEqual(r[0].symbols,['EURUSD'])
 const legacy={123:{badSince:t-3600000,lastWarning:0}};assert.equal(sampleFeedWatch(legacy,{now:t,open:true,recipients:{123:{GBPUSD:false}}}).messages.length,0)
})
test('New York FX market hours follow both winter and summer DST boundaries',()=>{
 const original=Date.now;try{for(const[iso,open]of [['2026-01-09T21:30Z',true],['2026-01-09T22:00Z',false],['2026-06-14T21:30Z',true],['2026-06-14T20:59Z',false],['2026-01-11T21:59Z',false],['2026-01-11T22:00Z',true],['2026-06-12T21:00Z',false],['2026-06-13T12:00Z',false]]){Date.now=()=>Date.parse(iso);assert.equal(createQuoteFeed({}).marketOpen(),open,iso)}}finally{Date.now=original}
})
test('Capital candles reject null/empty/boolean/negative and crossed required legs; valid one-sided quotes remain usable',async()=>{
 for(const[side,bid,ask,valid]of [['mid',100,null,false],['mid',100,'',false],['mid',100,false,false],['mid',100,0,false],['mid',100,99,false],['mid',100,102,true],['bid',100,null,true],['ask',null,102,true]]) {
  const now=Math.floor(Date.now()/1000)*1000,kv=new Map(),env={CAPITAL_SIDE:side,CAPITAL_API_KEY:'artificial',CAPITAL_IDENTIFIER:'artificial',CAPITAL_PASSWORD:'artificial',FETCH:async input=>new URL(input).pathname.endsWith('/session')?Response.json({},{headers:{cst:'test','x-security-token':'test'}}):Response.json({prices:[{snapshotTimeUTC:new Date(now-3600000).toISOString(),...Object.fromEntries(['openPrice','highPrice','lowPrice','closePrice'].map(k=>[k,{bid,ask}]))}]})}
  const source=createCapitalCandles(env,async([op,k,v])=>op==='GET'?kv.get(k)||null:(kv.set(k,v),'OK'))
  const job=()=>source.get(new URLSearchParams('symbol=XAUUSD'))
  if(valid){const r=await job();assert.equal(r.candles[0].close,side==='bid'?100:side==='ask'?102:101)}else{await assert.rejects(job,/invalid_candles/);assert.equal(kv.size,0)}
  await assert.rejects(source.get(new URLSearchParams('symbol=XAUUSD&timeframe=toString')),e=>e.status===400)
 }
})
test('import repairs a stale global sequence and rejects ambiguous duplicate alert IDs atomically',async()=>{
 const main={...emptyMain(),seq:1,alerts:[{id:1,userId:'123',symbol:'EURUSD',dir:'reach',level:1.2,status:'active'}]}, {db,store}=local(main)
 try{const engine=await createEngine({LOCAL_STORE:store,PRICE_SOURCE:'mock',REQUIRE_ACCESS:'false',MONITOR_ALERTS:'false'})
 const call=(p,method='GET',body)=>engine.http(new Request('https://local'+p,{method,headers:{'content-type':'application/json','x-user-id':'123'},...(body?{body:JSON.stringify(body)}:{})}))
 assert.equal((await(await call('/api/alerts','POST',{symbol:'EURUSD',level:1.3})).json()).id,2)
 await call('/api/alerts/1','DELETE');assert.equal((await(await call('/api/alerts')).json()).length,1)
 }finally{db.close()}
 assert.throws(()=>local({...main,alerts:[main.alerts[0],main.alerts[0]]}),/duplicate_alert_ids/)
})
test('manual create retry is idempotent, payload conflicts rejected and users isolated',async()=>{
 const{db,store}=local();try{const engine=await createEngine({LOCAL_STORE:store,PRICE_SOURCE:'mock',REQUIRE_ACCESS:'false',MONITOR_ALERTS:'false'}),id='12345678-1234-4234-8234-123456789abc',b={symbol:'EURUSD',level:1.3,note:'test',requestId:id}
 const post=(body,uid='123')=>engine.http(new Request('https://local/api/alerts',{method:'POST',headers:{'content-type':'application/json','x-user-id':uid},body:JSON.stringify(body)}))
 const a=await(await post(b)).json(),retry=await(await post(b)).json();assert.equal(a.id,retry.id)
 assert.equal((await post({...b,level:1.4})).status,409);assert.equal((await post({...b,requestId:'not-an-id'})).status,400)
 assert.notEqual((await(await post(b,'456')).json()).id,a.id)
 assert.equal(JSON.parse(await store.command(['GET','tg-alerts-db'])).alerts.length,2)
 }finally{db.close()}
})
test('Live text-only PUT preserves sent occurrences, remaining schedule and paused state',async()=>{
 const original=Date.now,{db,store}=local();try{Date.now=()=>Date.parse('2026-11-02T10:00Z')
 const config={text:'before',date:'2026-11-02',times:['09:00'],timezone:'UTC',repeat:'daily',count:3},r=newReminder('123','12345678-1234-4234-8234-123456789abc',config,Date.parse('2026-11-01T00:00Z'));r.deliveries[0].status='sent';r.enabled=false
 await store.command(['HSET','tg-alerts:{live}:reminders:v1','123|'+r.id,JSON.stringify(r)])
 const secret='artificial-key',p=Buffer.from(JSON.stringify({sub:'123',project:'alerts',iat:Date.now(),exp:Date.now()+60000})).toString('base64url'),token=p+'.'+createHmac('sha256',secret).update(p).digest('hex'),engine=await createEngine({LOCAL_STORE:store,BOT_TOKEN:'artificial',ACCESS_SIGNING_SECRET:secret,REQUIRE_ACCESS:'true',PRICE_SOURCE:'oanda',MONITOR_ALERTS:'false'})
 const response=await engine.http(new Request('https://local/api/live/'+r.id,{method:'PUT',headers:{'content-type':'application/json','x-access-token':token},body:JSON.stringify({...config,text:'after',revision:r.revision})}));assert.equal(response.status,200)
 const saved=JSON.parse(await store.command(['HGET','tg-alerts:{live}:reminders:v1','123|'+r.id]));assert.equal(saved.config.text,'after');assert.deepEqual(saved.deliveries,r.deliveries);assert.equal(saved.enabled,false);assert.notEqual(saved.revision,r.revision)
 }finally{Date.now=original;db.close()}
})
for(const stage of ['before','after'])test(`H4 dedup and outbox survive ${stage}-commit storage failure and engine restart`,async()=>{
 const original=Date.now,{db,store}=local();let fault=true,failed=false,sends=0
 try{const now=Date.parse('2026-11-02T17:55Z');Date.now=()=>now
 await store.command(['HSET','tg-alerts:{h4}:settings:v1','123',JSON.stringify({enabled:true,symbols:['EURUSD'],lead:[5],atClose:false,since:Date.parse('2026-11-02T14:00Z')})])
 const wrapped={command:async c=>{if(fault&&c[0]==='SET'&&c[1]==='tg-alerts-db'&&JSON.parse(c[2]).events.some(e=>e.h4)){fault=false;failed=true;if(stage==='after')await store.command(c);throw Object.assign(Error('artificial disk failure'),{storageFailure:true})}return store.command(c)}}
 const env={LOCAL_STORE:wrapped,PRICE_SOURCE:'oanda',BOT_TOKEN:'artificial',OANDA_TOKEN:'artificial',OANDA_ACCOUNT:'fixture',MONITOR_ALERTS:'false',NEWS_SOURCE:'mock',FETCH:async(input,init)=>{
  const u=new URL(input)
  if(u.hostname==='api.telegram.org'){if(JSON.parse(init.body).text.includes('H4'))sends++;return Response.json({ok:true})}
  if(u.pathname.endsWith('/candles'))return Response.json({instrument:'EUR_USD',granularity:'H4',candles:[{time:'2026-11-02T14:00:00Z',complete:false,volume:10}]})
  if(u.pathname.endsWith('/pricing'))return Response.json({prices:[{instrument:'EUR_USD',tradeable:true}]})
  throw Error('Unmocked network forbidden: '+u.pathname)
 }}
 let engine=await createEngine(env);await engine.housekeeping();assert.equal(failed,true);assert.equal(sends,0)
 engine=await createEngine(env);await engine.housekeeping();await engine.flushEvents();await engine.housekeeping();assert.equal(sends,1)
 const main=JSON.parse(await store.command(['GET','tg-alerts-db']));assert.equal(main.events.filter(e=>e.h4).length,1);assert.equal(Object.keys(main.h4Queued).length,1)
 }finally{Date.now=original;db.close()}
})
