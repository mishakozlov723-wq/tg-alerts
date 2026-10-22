import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { createHmac } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createQuoteFeed } from '../cloudflare/quotes.mjs'
import { loadLegacy } from '../cloudflare/redis.mjs'
import { createEngine } from '../cloudflare/core.mjs'

// All credentials, accounts, users and messages here are artificial. Never use production secrets.
const SECRET='artificial-signing-secret-01234567890123456789', WEBHOOK='artificial-webhook-secret-01234567890123456789'
const BOT='123456:artificial-token', uid='12345', HASH='tg-alerts:{live}:reminders:v1', H4HASH='tg-alerts:{h4}:settings:v1'
const env={BOT_TOKEN:BOT,ACCESS_SIGNING_SECRET:SECRET,TELEGRAM_WEBHOOK_SECRET:WEBHOOK,OANDA_TOKEN:'artificial-oanda',OANDA_ACCOUNT:'test-account',PRICE_SOURCE:'oanda',OANDA_ENV:'practice',OANDA_SIDE:'mid',REQUIRE_ACCESS:'true',UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'artificial-redis',WEBAPP_URL:'https://alerts.test',AUTH_API_URL:'https://access.test',SNAPSHOT_QUOTES_APPROVED:'true'}
const sign=(user=uid,project='alerts',extra={})=>{const b=Buffer.from(JSON.stringify({sub:user,project,exp:Date.now()+600000,...extra})).toString('base64url');return b+'.'+createHmac('sha256',SECRET).update(b).digest('hex')}
const persist=mkdtempSync(join(tmpdir(),'tg-alerts-test-'))
let newsFixture=[], candlesFixture=[]
let mf, mainWrites=0, telegram=[], failedRedis=false, failWrites=false, botName='artificial_alerts_bot', quoteOld=false, quoteClosed=false, price=1.2, rejectTelegram=false, accessToken, redisCalls=[]
const initial=()=>({alerts:[{id:1,userId:uid,symbol:'EURUSD',dir:'above',level:9,status:'active',createdAt:1}],settings:{},events:[],sentNews:{},seq:30,owned:{[uid]:['XAUUSD','XAGUSD','DXY','GER40']},orders:{old:{status:'approved',userId:uid}},customMigrationMarker:'preserve',resetV2:true})
const kv=new Map([['tg-alerts-db',JSON.stringify(initial())]])
const hashes=new Map([[H4HASH,new Map([[uid,JSON.stringify({enabled:false,symbols:['EURUSD'],lead:[5],atClose:true,since:1})]])],[HASH,new Map()]])
async function outbound(req){
 const u=new URL(req.url)
 if(u.hostname==='redis.test'){
  if(failedRedis)return Response.json({error:'simulated outage'},{status:503})
  const c=await req.json();redisCalls.push(c);let result
  if(c[0]==='GET')result=kv.get(c[1])??null
  else if(c[0]==='SET'){
   if(failWrites)return Response.json({error:'simulated write outage'},{status:503})
   if(c.includes('NX')&&kv.has(c[1]))result=null
   else{kv.set(c[1],c[2]);result='OK';if(c[1]==='tg-alerts-db')mainWrites++}
  } else if(c[0]==='HGETALL')result=[...(hashes.get(c[1])||new Map())].flat()
  else if(c[0]==='HGET')result=hashes.get(c[1])?.get(c[2])??null
  else if(c[0]==='HSET'){if(!hashes.has(c[1]))hashes.set(c[1],new Map());hashes.get(c[1]).set(c[2],c[3]);result=1}
  else if(c[0]==='EVAL'&&c[2]===1){
   const [,script,n,key,field,old,next,prefix,isCreate]=c
   if(!hashes.has(key))hashes.set(key,new Map());const h=hashes.get(key)
   if((h.get(field)||'')!==old)result=0
   else if(isCreate==='1'&&[...h.keys()].filter(x=>x.startsWith(prefix)).length>=100)result=-1
   else{if(next)h.set(field,next);else h.delete(field);result=1}
  } else if(c[0]==='EVAL'&&c[2]===2){const [,,n,key,marker,user,value]=c;if(hashes.get(key)?.get(user)!==value||kv.has(marker))result=null;else{kv.set(marker,'1');result='OK'}}
  else throw new Error('Unmocked Redis command '+c[0])
  return Response.json({result})
 }
 if(u.hostname==='api.telegram.org'){
  assert.ok(u.pathname.startsWith('/bot'+BOT+'/'),'Unexpected Telegram token')
  const method=u.pathname.split('/').at(-1),payload=await req.json();telegram.push({method,payload})
  if(rejectTelegram)return Response.json({ok:false,description:'simulated rejection'},{status:502})
  const result=method==='getMe'?{username:botName}:method==='getWebhookInfo'?{url:'https://alerts.test/telegram/webhook'}:true
  return Response.json({ok:true,result})
 }
 if(u.hostname==='api-fxpractice.oanda.com'){
  if(u.pathname.endsWith('/accounts'))return Response.json({accounts:[{id:'test-account'}]})
  if(u.pathname.endsWith('/instruments'))return Response.json({instruments:[{name:'XAU_USD'},{name:'DE30_EUR'}]})
  if(u.pathname.endsWith('/pricing'))return Response.json({prices:['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF','XAU_USD','DE30_EUR'].map(instrument=>({instrument,time:new Date(Date.now()-(quoteOld?120000:0)).toISOString(),tradeable:!quoteClosed,bids:[{price:String(instrument==='EUR_USD'?price:instrument==='USD_JPY'?150:1.1)}],asks:[{price:String(instrument==='EUR_USD'?price:instrument==='USD_JPY'?150:1.1)}]}))})
  if(u.pathname.includes('/candles'))return Response.json({granularity:'H4',instrument:u.pathname.split('/')[3],candles:candlesFixture})
  throw new Error('Unexpected broker URL '+u.pathname)
 }
 if(u.hostname==='nfs.faireconomy.media'||u.hostname==='cdn-nfs.faireconomy.media')return Response.json(newsFixture)
 if(u.hostname==='access.test'){
  assert.equal(u.pathname,'/api/verify-code');const b=await req.json();assert.equal(b.project,'alerts')
  return b.code==='123456'?Response.json({ok:true,token:accessToken||sign()}):Response.json({error:'invalid_code'},{status:400})
 }
 throw new Error('No live network permitted: '+u.hostname)
}
async function boot(overrides={}){
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.cf-test/worker.js',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],durableObjects:{ALERTS:{className:'AlertsEngine',useSQLite:true}},resourcePersistencePath:persist,bindings:{...env,...overrides},serviceBindings:{ASSETS:async()=>new Response(readFileSync('public/index.html'),{headers:{'content-type':'text/html'}})},outboundService:outbound}))
 await mf.ready
}
before(()=>boot({SNAPSHOT_QUOTES_APPROVED:'false'}))
after(async()=>{await mf?.dispose();rmSync(persist,{recursive:true,force:true})})
async function request(p,body,headers={},method='POST'){
 const r=await mf.dispatchFetch('https://alerts.test'+p,{method,headers:{'content-type':'application/json',...headers},...(method==='GET'||method==='HEAD'?{}:{body:JSON.stringify(body||{})})})
 const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
 return {status:r.status,data,headers:r.headers}
}
const admin=(p,body)=>request('/admin/'+p,body,{'x-setup-secret':WEBHOOK})
const api=(p,body,method='GET',token=sign())=>request('/api/'+p,body,{'x-access-token':token},method)
const withMock=async fn=>{const f=globalThis.fetch;globalThis.fetch=(input,init)=>outbound(new Request(input,init));try{return await fn()}finally{globalThis.fetch=f}}

 test('activation is blocked by default, while static UI remains available',async()=>{
  const r=await admin('activate',{confirmBot:botName,acceptSnapshots:true});assert.equal(r.status,503);assert.ok(r.data.missing.includes('SNAPSHOT_QUOTES_APPROVED'));assert.equal(telegram.length,0)
  assert.equal((await request('/',null,{},'GET')).status,200)
  await mf.dispose();await boot()
 })
 test('missing legacy data never starts an empty database or writes a reset',async()=>{
  await assert.rejects(loadLegacy(async()=>null),/legacy_database_missing/)
  await assert.rejects(loadLegacy(async()=>'{bad'),/legacy_database_invalid/)
  const d=await loadLegacy(async()=>JSON.stringify(initial()));assert.deepEqual(d.owned,initial().owned);assert.equal(d.customMigrationMarker,'preserve');assert.equal(d.resetV3,undefined)
 })
 test('health checks actual Redis and reminders but does not activate Telegram',async()=>{
  const before=telegram.length,r=await request('/health',null,{},'GET');assert.equal(r.status,200);assert.equal(r.data.enabled,false);assert.equal(r.data.quoteMode,'snapshot');assert.equal(telegram.length,before);assert.equal(mainWrites,0)
 })
 test('no admin action without secret; reject Access bot token even with setup secret',async()=>{
  assert.equal((await request('/admin/inspect')).status,403)
  botName='verifycapp';assert.equal((await admin('inspect')).status,409);botName='artificial_alerts_bot'
  const r=await admin('inspect');assert.equal(r.status,200);assert.equal(r.data.data.purchases,1);assert.equal(r.data.data.alerts,1);assert.equal(r.data.data.h4Users,1)
 })
 test('activation requires explicit bot identity and snapshot consent',async()=>{
  assert.equal((await admin('activate',{confirmBot:botName})).status,400)
  assert.equal((await admin('activate',{confirmBot:'wrong',acceptSnapshots:true})).status,400)
  assert.equal(telegram.filter(x=>x.method==='setWebhook').length,0)
  assert.equal((await admin('activate',{confirmBot:botName,acceptSnapshots:true})).status,200)
  const wh=telegram.find(x=>x.method==='setWebhook').payload;assert.equal(wh.secret_token,WEBHOOK);assert.equal(wh.drop_pending_updates,false);assert.equal(wh.url,'https://alerts.test/telegram/webhook')
 })
 test('Access tokens required; CRUD keeps original purchases/orders and serializes concurrent changes',async()=>{
  assert.equal((await api('alerts',null,'GET','bad')).status,401)
  assert.equal((await api('alerts',null,'GET',sign(uid,'calendar'))).status,401)
  assert.equal((await api('alerts',null,'GET',sign(uid,'alerts',{exp:1}))).status,401)
  assert.equal((await api('alerts',{symbol:'EURUSD',dir:'above',level:''},'POST')).status,400)
  const r=await Promise.all([api('alerts',{symbol:'EURUSD',dir:'above',level:8,note:'one'},'POST'),api('alerts',{symbol:'GBPUSD',dir:'below',level:.01,note:'two'},'POST')]);assert.ok(r.every(x=>x.status===200));assert.notEqual(r[0].data.id,r[1].data.id)
  const db=JSON.parse(kv.get('tg-alerts-db'));assert.equal(db.alerts.length,3);assert.deepEqual(db.owned,initial().owned);assert.deepEqual(db.orders,initial().orders);assert.equal(db.customMigrationMarker,'preserve');assert.equal(db.resetV3,undefined)
  assert.equal((await api('alerts/'+r[0].data.id,{note:'updated'},'PATCH')).status,200)
  assert.equal((await api('alerts/'+r[0].data.id,null,'DELETE')).status,200)
 })
 test('legacy snapshot quotes cannot trigger on stale or closed prices',async()=>withMock(async()=>{
  for(const mode of ['old','closed','fresh']){quoteOld=mode==='old';quoteClosed=mode==='closed';const feed=createQuoteFeed(env),seen=[];await feed.poll((...a)=>seen.push(a));assert.equal(seen.length>0,mode==='fresh');assert.equal(feed.tradeable('EURUSD'),mode==='fresh');assert.equal(feed.status().mode,'snapshot')}
  quoteOld=false;quoteClosed=false
 }))
 test('successful alarm runs preserve data and trigger an alert only once',async()=>{
  const add=await api('alerts',{symbol:'EURUSD',dir:'above',level:1,note:'Artificial test alert'},'POST');assert.equal(add.status,200)
  const until=Date.now()+16000
  while(Date.now()<until&&!telegram.some(x=>x.payload?.text?.includes('Artificial test alert')))await new Promise(r=>setTimeout(r,250))
  assert.equal(telegram.filter(x=>x.payload?.text?.includes('Artificial test alert')).length,1)
  assert.equal(JSON.parse(kv.get('tg-alerts-db')).alerts.find(a=>a.id===add.data.id).status,'fired')
  const h=await request('/health',null,{},'GET');assert.ok(h.data.lastSchedulerRun)
 })
 test('webhook validates method/secret and persists successful update deduplication',async()=>{
  assert.equal((await request('/telegram/webhook',{})).status,403)
  assert.equal((await request('/telegram/webhook',null,{'x-telegram-bot-api-secret-token':WEBHOOK},'GET')).status,405)
  const b={update_id:100,message:{chat:{id:Number(uid),type:'private'},from:{id:Number(uid)},text:'/start'}}
  const before=telegram.filter(x=>x.method==='sendMessage').length
  for(let i=0;i<2;i++)assert.equal((await request('/telegram/webhook',b,{'x-telegram-bot-api-secret-token':WEBHOOK})).status,200)
  assert.equal(telegram.filter(x=>x.method==='sendMessage').length,before+1)
 })
 test('bounded request bodies and independent H4/Live routes',async()=>{
  assert.equal((await api('alerts',{note:'x'.repeat(13000)},'POST')).status,413)
  const h=await api('h4/settings');assert.equal(h.status,200);assert.deepEqual(h.data.symbols,['EURUSD']);assert.equal(h.data.enabled,false)
  const l=await api('live');assert.equal(l.status,200)
  assert.equal((await api('settings',{lead:['bad'],currencies:['USD']},'POST')).status,400)
 })
 test('same-origin Access redemption verifies project and shared signing secret',async()=>{
  assert.equal((await request('/api/access/redeem',{code:'123'})).status,400)
  assert.equal((await request('/api/access/redeem',{code:'123456'})).status,200)
  accessToken=sign(uid,'calendar');assert.equal((await request('/api/access/redeem',{code:'123456'})).status,503);accessToken=null
 })
 test('UI uses slower polling, discloses snapshots, refreshes symbol permissions after login',async()=>{
  const r=await request('/',null,{},'GET'),html=r.data
  assert.ok(html.includes("fetch('/api/access/redeem'"));assert.ok(!html.includes("fetch(authApi.replace"));assert.ok(html.includes('5000)'));assert.ok(!html.includes('tick().catch(() => {}), 400)'));assert.ok(html.includes('Brief level crossings'));assert.ok(html.includes("cfg = await api('/api/config'); renderTiles()"))
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1])
  assert.equal(r.headers.get('cache-control'),'no-store')
 })
 test('write failure does not silently succeed or destroy durable old state',async()=>{
  const before=kv.get('tg-alerts-db');failWrites=true
  assert.equal((await api('alerts',{symbol:'EURUSD',dir:'above',level:50},'POST')).status,503)
  assert.equal(kv.get('tg-alerts-db'),before);failWrites=false
  assert.equal((await api('alerts')).data.length,JSON.parse(before).alerts.length)
 })
 test('Redis outage returns unavailable, never replaces database with empty state',async()=>{
  await admin('stop');await mf.dispose();failedRedis=true;const before=kv.get('tg-alerts-db');await boot()
  assert.equal((await request('/health',null,{},'GET')).status,503);assert.equal(kv.get('tg-alerts-db'),before)
  failedRedis=false;assert.equal((await request('/health',null,{},'GET')).status,200)
 })
 test('restart keeps disabled scheduler and webhook update history',async()=>{
  assert.equal((await request('/health',null,{},'GET')).data.enabled,false)
  await admin('activate',{confirmBot:botName,acceptSnapshots:true})
  const before=telegram.filter(x=>x.method==='sendMessage').length
  assert.equal((await request('/telegram/webhook',{update_id:100,message:{chat:{id:Number(uid),type:'private'},from:{id:Number(uid)},text:'/start'}},{'x-telegram-bot-api-secret-token':WEBHOOK})).status,200)
  assert.equal(telegram.filter(x=>x.method==='sendMessage').length,before)
  await admin('stop')
 })
 test('core propagates persistence errors in quote alerts rather than consuming in-memory alerts',async()=>withMock(async()=>{
  const old=kv.get('tg-alerts-db');kv.set('tg-alerts-db',JSON.stringify({...initial(),alerts:[{id:1,userId:uid,symbol:'EURUSD',dir:'above',level:1,status:'active'}]}))
  const core=await createEngine(env);failWrites=true
  try{await assert.rejects(core.tick(),e=>e.storageFailure===true)}finally{failWrites=false;kv.set('tg-alerts-db',old)}
 }))
 test('news, H4 and Live reminders retain Redis data and deduplicate delivery after engine restart',async()=>withMock(async()=>{
  const old=kv.get('tg-alerts-db'),oldNews=kv.get('tg-alerts-news'),oldH4=hashes.get(H4HASH),oldLive=hashes.get(HASH),clock=Date.now
  const now=Date.parse('2026-10-22T16:59:30Z'),rid='12345678-1234-4234-8234-123456789abc';Date.now=()=>now
  try{
   kv.delete('tg-alerts-news');kv.set('tg-alerts-db',JSON.stringify({...initial(),settings:{[uid]:{lead:[1],currencies:['USD']}}}))
   hashes.set(H4HASH,new Map([[uid,JSON.stringify({enabled:true,symbols:['EURUSD'],lead:[1],atClose:true,since:now-120000})]]))
   hashes.set(HASH,new Map([[uid+'|'+rid,JSON.stringify({id:rid,userId:uid,config:{text:'Artificial personal reminder',timezone:'UTC'},enabled:true,revision:'old',createdAt:1,updatedAt:1,deliveries:[{at:now-1000,status:'pending'}]})]]))
   newsFixture=[{impact:'High',country:'USD',title:'Artificial calendar news',date:new Date(now+60000).toISOString()}]
   candlesFixture=[{time:'2026-10-22T13:00:00Z',complete:false,volume:10}]
   const before=telegram.length;await(await createEngine(env)).tick();await(await createEngine(env)).tick()
   const sent=telegram.slice(before).filter(x=>x.method==='sendMessage').map(x=>x.payload.text)
   assert.equal(sent.filter(x=>x.includes('Artificial personal reminder')).length,1)
   assert.equal(sent.filter(x=>x.includes('Artificial calendar news')).length,1)
   assert.equal(sent.filter(x=>x.includes('H4')).length,1)
   assert.equal(JSON.parse(hashes.get(HASH).get(uid+'|'+rid)).deliveries[0].status,'sent')
   assert.deepEqual(JSON.parse(kv.get('tg-alerts-db')).owned,initial().owned)
  }finally{Date.now=clock;kv.set('tg-alerts-db',old);if(oldNews)kv.set('tg-alerts-news',oldNews);else kv.delete('tg-alerts-news');hashes.set(H4HASH,oldH4);hashes.set(HASH,oldLive);newsFixture=[];candlesFixture=[]}
 }))
 test('simultaneous broker responses serialize alert persistence callbacks',async()=>{
  const f=globalThis.fetch;let active=0,maxActive=0,count=0
  globalThis.fetch=async(input,init)=>{
   const req=new Request(input,init),u=new URL(req.url)
   if(u.hostname==='demo-api-capital.backend-capital.com'){
    if(u.pathname.endsWith('/session'))return Response.json({}, {headers:{cst:'test-cst','x-security-token':'test-sec'}})
    return Response.json({marketDetails:['GOLD','DE40','SILVER'].map(epic=>({instrument:{epic},snapshot:{bid:100,offer:101,marketStatus:'TRADEABLE'}}))})
   }
   return outbound(req)
  }
  try{
   const feed=createQuoteFeed({...env,CAPITAL_API_KEY:'artificial',CAPITAL_IDENTIFIER:'artificial',CAPITAL_PASSWORD:'artificial'})
   await feed.poll(async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,3));count++;active--})
   assert.ok(count>=6);assert.equal(maxActive,1);assert.equal(feed.tradeable('XAGUSD'),true)
  }finally{globalThis.fetch=f}
 })
 test('snapshot frame never interpolates or retains stale prices, including index.html route',async()=>{
  const {data:html}=await request('/index.html',null,{},'GET')
  assert.ok(html.includes('Display actual snapshots only'));assert.ok(!html.includes('two chained smoothers'));assert.ok(html.includes('delete shown[k]'));assert.ok(html.includes('waiting for fresh quote'))
 })
