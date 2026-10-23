import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Script} from 'node:vm'
import {AsyncLocalStorage} from 'node:async_hooks'
import {DatabaseSync} from 'node:sqlite'
import {Miniflare,convertV4MiniflareOptions} from 'miniflare'
import {createLocalStore,emptyMain} from '../cloudflare/storage.mjs'
import {createQuoteFeed} from '../cloudflare/quotes.mjs'
import {createEngine} from '../cloudflare/core.mjs'

// No real credentials or live network. All API responses and identities are artificial.
const SECRET='artificial-signing-secret-01234567890123456789',WEBHOOK='artificial-webhook-secret-01234567890123456789',BOT='123456:artificial-token',uid='12345'
const env={ADMIN_CHAT_ID:'99999',MONITOR_ALERTS:'false',BOT_TOKEN:BOT,ACCESS_SIGNING_SECRET:SECRET,TELEGRAM_WEBHOOK_SECRET:WEBHOOK,OANDA_TOKEN:'artificial-oanda',OANDA_ACCOUNT:'test-account',PRICE_SOURCE:'oanda',OANDA_ENV:'practice',OANDA_SIDE:'bid',REQUIRE_ACCESS:'true',WEBAPP_URL:'https://alerts.test',AUTH_API_URL:'https://access.test',STREAM_WINDOW_SECONDS:'2'}
const initial=()=>({...emptyMain(),alerts:[{id:1,userId:uid,symbol:'EURUSD',dir:'above',level:9,status:'active',createdAt:1}],seq:30,owned:{[uid]:['XAUUSD','XAGUSD','GER40','DXY']},orders:{old:{status:'approved',userId:uid}},migrationMarker:'preserve',resetV2:true})
const sign=(user=uid,project='alerts',extra={})=>{const b=Buffer.from(JSON.stringify({sub:user,project,exp:Date.now()+600000,...extra})).toString('base64url');return b+'.'+createHmac('sha256',SECRET).update(b).digest('hex')}
let mf,sql,telegram=[],botName='artificial_alerts_bot',rejectStream=false,rejectTelegram=false,stale=false,closed=false,capitalCalls=0,candles=[],news=[],accessToken=null,streamStarts=0
const persist=mkdtempSync(join(tmpdir(),'alerts-stream-test-')),streams=new Map(),encoder=new TextEncoder()
const quote=(instrument='EUR_USD',value=1.2)=>({type:'PRICE',instrument,time:new Date(Date.now()-(stale?120000:0)).toISOString(),tradeable:!closed,bids:[{price:String(value)}],asks:[{price:String(value+.0002)}]})
function emit(value){for(const [c]of streams){try{c.enqueue(encoder.encode(JSON.stringify(quote('EUR_USD',value))+'\n'))}catch{}}}
function closeStreams(){for(const [c,t]of streams){clearInterval(t);try{c.close()}catch{}}streams.clear()}
async function outbound(req){
 const u=new URL(req.url)
 if(u.hostname==='api.telegram.org'){
  assert.ok(u.pathname.startsWith('/bot'+BOT+'/'));const method=u.pathname.split('/').at(-1),payload=await req.json();telegram.push({method,payload})
  if(rejectTelegram)return Response.json({ok:false},{status:502})
  return Response.json({ok:true,result:method==='getMe'?{username:botName}:method==='getWebhookInfo'?{url:'https://alerts.test/telegram/webhook'}:true})
 }
 if(u.hostname==='stream-fxpractice.oanda.com'){
  streamStarts++;if(rejectStream)return Response.json({error:'artificial outage'},{status:503})
  const body=new ReadableStream({start(c){
   for(const inst of ['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF','XAU_USD','DE30_EUR'])c.enqueue(encoder.encode(JSON.stringify(quote(inst,inst==='USD_JPY'?150:1.2))+'\n'))
   const t=setInterval(()=>{try{c.enqueue(encoder.encode(JSON.stringify({type:'HEARTBEAT',time:new Date().toISOString()})+'\n'))}catch{clearInterval(t);streams.delete(c)}},300);streams.set(c,t)
  },cancel(){closeStreams()}})
  return new Response(body,{headers:{'content-type':'application/octet-stream'}})
 }
 if(u.hostname==='api-fxpractice.oanda.com'){
  if(u.pathname.endsWith('/accounts'))return Response.json({accounts:[{id:'test-account'}]})
  if(u.pathname.endsWith('/instruments'))return Response.json({instruments:[{name:'XAU_USD'},{name:'DE30_EUR'}]})
  if(u.pathname.endsWith('/pricing'))return Response.json({prices:['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF','XAU_USD','DE30_EUR'].map(s=>quote(s,s==='USD_JPY'?150:1.2))})
  if(u.pathname.includes('/candles'))return Response.json({granularity:'H4',instrument:u.pathname.split('/')[3],candles})
 }
 if(u.hostname==='demo-api-capital.backend-capital.com'){
  capitalCalls++
  if(u.pathname.endsWith('/session'))return Response.json({}, {headers:{cst:'artificial-cst','x-security-token':'artificial-sec'}})
  return Response.json({marketDetails:['GOLD','DE40','SILVER'].map(epic=>({instrument:{epic},snapshot:{bid:100,offer:101,marketStatus:'TRADEABLE'}}))})
 }
 if(['nfs.faireconomy.media','cdn-nfs.faireconomy.media'].includes(u.hostname))return Response.json(news)
 if(u.hostname==='access.test'){assert.equal(u.pathname,'/api/verify-code');assert.equal((await req.json()).project,'alerts');return Response.json({ok:true,token:accessToken||sign()})}
 throw new Error('No live network permitted: '+u.hostname+u.pathname)
}
async function boot(extra={}){
 mf=new Miniflare(convertV4MiniflareOptions({name:'alerts-test',unsafeInspectDurableObjects:true,modules:true,scriptPath:'.cf-test/worker.js',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],durableObjects:{ALERTS:{className:'AlertsEngine',useSQLite:true}},resourcePersistencePath:persist,bindings:{...env,...extra},serviceBindings:{ASSETS:async()=>new Response(readFileSync('public/index.html'),{headers:{'content-type':'text/html',etag:'artificial','content-encoding':'identity'}})},outboundService:outbound}))
 await mf.ready;sql=await mf.unsafeGetDurableObjectStorage('alerts-test','AlertsEngine',{name:'production'})
}
before(()=>boot())
after(async()=>{closeStreams();await mf?.dispose();rmSync(persist,{recursive:true,force:true})})
async function request(path,body,headers={},method='POST'){
 const r=await mf.dispatchFetch('https://alerts.test'+path,{method,headers:{'content-type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body||{})})});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text};return {status:r.status,data,headers:r.headers}
}
const admin=(p,b)=>request('/admin/'+p,b,{'x-setup-secret':WEBHOOK})
const api=(p,b,method='GET',token=sign())=>request('/api/'+p,b,{'x-access-token':token},method)
const getMain=async()=>JSON.parse((await sql.exec("SELECT v FROM alerts_kv WHERE k='tg-alerts-db'"))[0].v)
async function waitFor(fn,ms=6000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Timed out awaiting artificial test condition')}
function local(snapshot={main:emptyMain()}){
 const db=new DatabaseSync(':memory:');const storage={sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>{db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};const store=createLocalStore(storage);if(snapshot)store.initialize(snapshot);return {db,store}
}
const mockFetch=(input,init)=>outbound(new Request(input,init))

 test('no Redis configuration required, no automatic empty initialization or activation',async()=>{
  const r=await request('/health',null,{},'GET');assert.equal(r.status,503);assert.equal(r.data.error,'storage_not_initialized');assert.equal(telegram.length,0);assert.equal(streamStarts,0)
  assert.equal((await api('prices')).status,503);assert.equal((await admin('activate',{confirmBot:botName})).status,409)
 })
 test('admin secrets protect initialization; Access bot is rejected',async()=>{
  assert.equal((await request('/admin/initialize',{startEmpty:true})).status,403)
  botName='verifycapp';assert.equal((await admin('inspect')).status,409);botName='artificial_alerts_bot'
  const r=await admin('inspect');assert.equal(r.status,200);assert.equal(r.data.initialized,false)
 })
 test('explicit import validates atomically and cannot overwrite initialized state',async()=>{
  assert.equal((await admin('initialize',{startEmpty:true})).status,400)
  assert.equal((await admin('initialize',{confirm:'INITIALIZE_ALERTS_SQLITE',snapshot:{main:initial(),live:[{}]}})).status,400)
  assert.equal((await admin('inspect')).data.initialized,false)
  const r=await admin('initialize',{confirm:'INITIALIZE_ALERTS_SQLITE',snapshot:{main:initial(),h4:{[uid]:{enabled:false,symbols:['EURUSD'],lead:[5],atClose:true,since:1}}}})
  assert.equal(r.status,200);assert.equal(r.data.data.purchaseOwners,1)
  assert.equal((await admin('initialize',{confirm:'INITIALIZE_ALERTS_SQLITE',startEmpty:true})).status,409)
  assert.deepEqual((await getMain()).orders,initial().orders);assert.equal((await getMain()).resetV3,undefined)
 })
 test('setup and app scripts parse, display polls every second without snapshot interpolation',async()=>{
  for(const p of ['/','/index.html','/setup.html']){
   const r=await request(p,null,{},'GET');assert.equal(r.status,200)
   for(const m of r.data.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g))new Script(m[1])
   if(p!=='/setup.html'){assert.equal(r.headers.get('etag'),null);assert.equal(r.headers.get('content-encoding'),null);assert.ok(r.data.includes("fetch('/api/access/redeem'"));assert.ok(r.data.includes('ACCESS_SIGNING_SECRET в Alerts не совпадает'));assert.ok(!r.data.includes("catch { status.textContent = 'Invalid or already used code.' }"));assert.ok(r.data.includes('}, 1000)'));assert.ok(r.data.includes('last quote · reconnecting / market closed'));assert.ok(!r.data.includes('snapshots ~10s'));assert.ok(r.data.includes('streaming'))}
  }
 })
 test('activation requires correct bot, then scheduler runs independently of UI',async()=>{
  assert.equal((await admin('activate',{confirmBot:'wrong'})).status,400)
  assert.equal((await admin('activate',{confirmBot:botName})).status,200)
  await waitFor(()=>streamStarts>0)
  const r=await request('/health',null,{},'GET');assert.equal(r.data.storage,'sqlite');assert.equal(r.data.quoteMode,'stream');assert.equal(r.data.enabled,true);assert.equal(r.data.feed.pricing.oandaSide,'bid');assert.equal(r.data.feed.pricing.oandaEnvironment,'practice')
 })
 test('API stays responsive while a long stream alarm is running; tokens and CRUD preserved',async()=>{
  const start=Date.now();assert.equal((await api('prices')).status,200);assert.ok(Date.now()-start<1500)
  assert.equal((await api('alerts',null,'GET','bad')).status,401)
  assert.equal((await api('alerts',null,'GET',sign(uid,'calendar'))).status,401)
  assert.equal((await api('alerts',{symbol:'EURUSD',dir:'above',level:''},'POST')).status,400)
  const r=await Promise.all([api('alerts',{symbol:'EURUSD',dir:'above',level:8,note:'first'},'POST'),api('alerts',{symbol:'GBPUSD',dir:'below',level:.01,note:'second'},'POST')]);assert.ok(r.every(x=>x.status===200));assert.notEqual(r[0].data.id,r[1].data.id)
  const d=await getMain();assert.deepEqual(d.owned,initial().owned);assert.equal(d.migrationMarker,'preserve');assert.equal(d.alerts.length,3)
 })
 test('brief received level crossing fires even without any price polling from mini-app',async()=>{
  const a=await api('alerts',{symbol:'EURUSD',dir:'above',level:1.5,note:'ARTIFICIAL BRIEF CROSSING'},'POST');assert.equal(a.status,200)
  await waitFor(()=>streams.size>0);emit(1.6);emit(1.2)
  await waitFor(()=>telegram.some(x=>x.payload?.text?.includes('ARTIFICIAL BRIEF CROSSING')))
  assert.equal(telegram.filter(x=>x.payload?.text?.includes('ARTIFICIAL BRIEF CROSSING')).length,1)
  assert.equal((await getMain()).alerts.find(x=>x.id===a.data.id).status,'fired')
  emit(1.6);await new Promise(r=>setTimeout(r,100));assert.equal(telegram.filter(x=>x.payload?.text?.includes('ARTIFICIAL BRIEF CROSSING')).length,1)
 })
 test('incoming ticks do not checkpoint prices or rewrite database on each update',async()=>{
  await sql.exec('CREATE TABLE audit_write(n INTEGER)');await sql.exec("CREATE TRIGGER audit_main AFTER UPDATE ON alerts_kv WHEN NEW.k='tg-alerts-db' BEGIN INSERT INTO audit_write VALUES(1); END")
  const before=(await sql.exec('SELECT count(*) AS n FROM audit_write'))[0].n
  for(let i=0;i<100;i++)emit(1.21+i*.00001)
  await new Promise(r=>setTimeout(r,300))
  assert.equal((await sql.exec('SELECT count(*) AS n FROM audit_write'))[0].n,before)
  assert.ok(!Object.hasOwn(await getMain(),'prices'))
 })
 test('successful webhook update is persisted and deduplicated; method/secret enforced',async()=>{
  assert.equal((await request('/telegram/webhook',{})).status,403)
  assert.equal((await request('/telegram/webhook',null,{'x-telegram-bot-api-secret-token':WEBHOOK},'GET')).status,405)
  const update={update_id:100,message:{chat:{id:Number(uid),type:'private'},from:{id:Number(uid)},text:'/start'}},before=telegram.filter(x=>x.method==='sendMessage').length
  for(let i=0;i<2;i++)assert.equal((await request('/telegram/webhook',update,{'x-telegram-bot-api-secret-token':WEBHOOK})).status,200)
  assert.equal(telegram.filter(x=>x.method==='sendMessage').length,before+1)
  assert.ok(telegram.some(x=>x.payload?.reply_markup?.keyboard?.[0]?.[0]?.web_app?.url==='https://alerts.test'))
 })
 test('founder status and drilldown work through authenticated webhook, not for other users',async()=>{
  const webhook=(id,user,text)=>request('/telegram/webhook',{update_id:id,message:{chat:{id:Number(user),type:'private'},from:{id:Number(user)},text}},{'x-telegram-bot-api-secret-token':WEBHOOK})
  let before=telegram.length
  assert.equal((await webhook(110,'12345','/status')).status,200);assert.equal(telegram.length,before)
  assert.equal((await webhook(111,'99999','/status quotes')).status,200)
  assert.match(telegram.at(-1).payload.text,/DXY/);assert.equal(telegram.at(-1).payload.chat_id,'99999')
  const callback={update_id:112,callback_query:{id:'status-detail',from:{id:99999},data:'status:logs',message:{chat:{id:99999,type:'private'},message_id:1}}}
  assert.equal((await request('/telegram/webhook',callback,{'x-telegram-bot-api-secret-token':WEBHOOK})).status,200)
  assert.match(telegram.at(-1).payload.text,/Последние инциденты/)
 })
 test('Access redemption and bounded bodies; existing H4/Live routes remain separate',async()=>{
  assert.equal((await request('/api/access/redeem',{code:'123456'})).status,200)
  accessToken=sign(uid,'alerts').replace(/.$/, 'z');const mismatch=await request('/api/access/redeem',{code:'123456'});assert.equal(mismatch.status,503);assert.equal(mismatch.data.error,'access_signing_secret_mismatch');accessToken=null
  assert.equal((await api('alerts',{note:'x'.repeat(13000)},'POST')).status,413)
  assert.deepEqual((await api('h4/settings')).data.symbols,['EURUSD']);assert.equal((await api('live')).status,200)
 })
 test('stream reconnects across bounded windows without restarting user data',async()=>{
  const before=streamStarts,main=await getMain();await waitFor(()=>streamStarts>before,7000)
  assert.deepEqual((await getMain()).owned,main.owned);assert.equal((await getMain()).alerts.length,main.alerts.length)
 })
 test('outbound budget rotates safely and deferred price notifications drain without duplication',async()=>{
  for(let i=0;i<45;i++)assert.equal((await api('alerts',{symbol:'EURUSD',dir:'above',level:1.8,note:'ARTIFICIAL BUDGET '+i},'POST')).status,200)
  await waitFor(()=>streams.size>0);emit(1.9)
  await waitFor(()=>telegram.filter(x=>x.payload?.text?.includes('ARTIFICIAL BUDGET ')).length===45,15000)
  const messages=telegram.filter(x=>x.payload?.text?.includes('ARTIFICIAL BUDGET '));assert.equal(new Set(messages.map(x=>x.payload.text)).size,45)
  assert.equal((await getMain()).events.filter(x=>x.text?.includes('ARTIFICIAL BUDGET ')&&x.delivery==='pending').length,0)
  assert.ok((await request('/health',null,{},'GET')).data.windowOutboundRequests<=40)
 })
 test('private export includes state and reminder claims and is inaccessible without setup secret',async()=>{
  assert.equal((await request('/admin/export',{})).status,403)
  const r=await admin('export');assert.equal(r.status,200);assert.deepEqual(r.data.snapshot.main.owned,initial().owned)
  const {db,store}=local(null);try{store.initialize(r.data.snapshot);assert.equal(JSON.parse(await store.command(['GET','tg-alerts-db'])).alerts.length,(await getMain()).alerts.length)}finally{db.close()}
 })
 test('stop and restart preserve data, disabled flag and successful webhook history',async()=>{
  await admin('stop');await waitFor(async()=>(await request('/health',null,{},'GET')).data.schedulerActive===false)
  closeStreams();await mf.dispose();await boot();const h=await request('/health',null,{},'GET');assert.equal(h.data.enabled,false);assert.equal((await getMain()).migrationMarker,'preserve')
  await admin('activate',{confirmBot:botName});const before=telegram.filter(x=>x.method==='sendMessage').length
  assert.equal((await request('/telegram/webhook',{update_id:100,message:{chat:{id:Number(uid),type:'private'},from:{id:Number(uid)},text:'/start'}},{'x-telegram-bot-api-secret-token':WEBHOOK})).status,200)
  assert.equal(telegram.filter(x=>x.method==='sendMessage').length,before);await admin('stop')
 })
 test('SQLite CAS prevents stale Live edits and H4 marker claims survive restart',async()=>{
  const {db,store}=local();try{
   const k='tg-alerts:{live}:reminders:v1',cmd=['EVAL',"ARGV[5]=='1'",1,k,uid+'|id','','value',uid+'|','1']
   assert.equal(await store.command(cmd),1);assert.equal(await store.command(cmd),0)
   await store.command(['HSET','h4',uid,'settings'])
   const claim=['EVAL',"redis.call('SET', KEYS[2]",2,'h4','marker',uid,'settings'];assert.equal(await store.command(claim),'OK');assert.equal(await store.command(claim),null)
   assert.equal(createLocalStore({sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>fn()}).initialized(),true)
  }finally{db.close()}
 })
 test('closed and stale streamed quotes never trigger price alerts',async()=>{
  for(const mode of ['old','closed','fresh']){
   const ac=new AbortController(),seen=[];stale=mode==='old';closed=mode==='closed'
   const fetch=async(input,init)=>{const u=new URL(input);if(u.hostname.startsWith('stream-'))return new Response(JSON.stringify(quote())+'\n');return mockFetch(input,init)}
   const feed=createQuoteFeed({...env,FETCH:fetch});const timer=setTimeout(()=>ac.abort(),30)
   await feed.stream((...v)=>seen.push(v),ac.signal,fn=>fn());clearTimeout(timer);assert.equal(seen.length>0,mode==='fresh')
  }
  stale=false;closed=false
 })
 test('deferred-before-fetch price delivery is persisted and retried after engine restart',async()=>{
  const {db,store}=local({main:{...emptyMain(),alerts:[{id:1,userId:uid,symbol:'EURUSD',dir:'above',level:1,status:'active'}],seq:2}})
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),40);let defer=true
  const fetch=async(input,init)=>{const url=new URL(input);if(url.hostname.startsWith('stream-'))return new Response(JSON.stringify(quote())+'\n');if(defer&&url.hostname==='api.telegram.org')throw Object.assign(new Error('outbound_budget_deferred'),{retrySafe:true});return mockFetch(input,init)}
  try{
   const core=await createEngine({...env,LOCAL_STORE:store,FETCH:fetch});await core.stream(ac.signal,fn=>fn());clearTimeout(timer)
   let d=JSON.parse(await store.command(['GET','tg-alerts-db']));assert.equal(d.events[0].delivery,'pending');assert.equal(d.alerts[0].status,'fired')
   defer=false;const before=telegram.length;await(await createEngine({...env,LOCAL_STORE:store,FETCH:fetch})).housekeeping();d=JSON.parse(await store.command(['GET','tg-alerts-db']));assert.equal(d.events[0].delivery,'sent');assert.equal(telegram.slice(before).filter(x=>x.method==='sendMessage').length,1)
  }finally{clearTimeout(timer);db.close()}
 })
 test('source reconnect fallback remains explicit, never called a connected stream',async()=>{
  const ac=new AbortController(),feed=createQuoteFeed({...env,FETCH:async(input,init)=>new URL(input).hostname.startsWith('stream-')?Response.json({error:'outage'},{status:503}):mockFetch(input,init)})
  const timer=setTimeout(()=>ac.abort(),30);let seen=0;await feed.stream(()=>{seen++},ac.signal,fn=>fn());clearTimeout(timer);assert.ok(seen>0);assert.equal(feed.status().connected,false);assert.equal(feed.status().source,'polling_fallback')
 })
 test('news, H4 and personal reminders use local SQLite and deduplicate after core restart',async()=>{
  const clock=Date.now,now=Date.parse('2026-10-22T16:59:30Z'),rid='12345678-1234-4234-8234-123456789abc';Date.now=()=>now
  const {db,store}=local({main:{...initial(),settings:{[uid]:{lead:[1],currencies:['USD']}}},h4:{[uid]:{enabled:true,symbols:['EURUSD'],lead:[1],atClose:true,since:now-120000}},live:[{id:rid,userId:uid,config:{text:'ARTIFICIAL PERSONAL',timezone:'UTC'},enabled:true,revision:'old',createdAt:1,updatedAt:1,deliveries:[{at:now-1000,status:'pending'}]}]})
  try{
   news=[{impact:'High',country:'USD',title:'ARTIFICIAL NEWS',date:new Date(now+60000).toISOString()}];candles=[{time:'2026-10-22T13:00:00Z',complete:false,volume:10}]
   const before=telegram.length;for(let i=0;i<2;i++)await(await createEngine({...env,LOCAL_STORE:store,FETCH:mockFetch})).housekeeping()
   const sent=telegram.slice(before).filter(x=>x.method==='sendMessage').map(x=>x.payload.text)
   for(const term of ['ARTIFICIAL PERSONAL','ARTIFICIAL NEWS','H4'])assert.equal(sent.filter(x=>x.includes(term)).length,1,term)
   assert.deepEqual(JSON.parse(await store.command(['GET','tg-alerts-db'])).owned,initial().owned)
  }finally{Date.now=clock;news=[];candles=[];db.close()}
 })
 test('corrupt durable state fails closed rather than replacing with empty data',async()=>{
  const {db,store}=local();try{await store.command(['SET','tg-alerts-db','{bad']);await assert.rejects(createEngine({...env,LOCAL_STORE:store,FETCH:mockFetch}));assert.equal(await store.command(['GET','tg-alerts-db']),'{bad')}finally{db.close()}
 })

 test('Capital preserves previous polling quote side, offsets and paid-price trigger',async()=>{
  const {db,store}=local({main:{...initial(),alerts:[{id:1,userId:uid,symbol:'XAUUSD',dir:'above',level:101,status:'active'}]}})
  try{
   const core=await createEngine({...env,LOCAL_STORE:store,FETCH:mockFetch,CAPITAL_API_KEY:'artificial',CAPITAL_IDENTIFIER:'artificial',CAPITAL_PASSWORD:'artificial',CAPITAL_SIDE:'ask',OFFSET_XAUUSD:'2'})
   const before=telegram.length;await core.capital();const d=JSON.parse(await store.command(['GET','tg-alerts-db']));assert.equal(d.alerts[0].firedPrice,103);assert.equal(d.alerts[0].status,'fired');assert.equal(telegram.slice(before).filter(x=>x.method==='sendMessage').length,1);assert.equal(core.feedStatus().capitalIntervalMs,1500)
  }finally{db.close()}
 })
 test('event retention never deletes a deferred notification',async()=>{
  const main={...emptyMain(),events:Array.from({length:501},(_,i)=>({id:i+1,userId:uid,text:'PENDING '+i,delivery:'pending',ts:Date.now()})),seq:502,alerts:[{id:600,userId:uid,symbol:'XAUUSD',dir:'above',level:1,status:'active'}],owned:{[uid]:['XAUUSD']}}
  const {db,store}=local({main})
  try{
   const core=await createEngine({...env,LOCAL_STORE:store,CAPITAL_API_KEY:'artificial',CAPITAL_IDENTIFIER:'artificial',CAPITAL_PASSWORD:'artificial',FETCH:async(i,o)=>new URL(i).hostname==='api.telegram.org'?Promise.reject(Object.assign(new Error('deferred'),{retrySafe:true})):mockFetch(i,o)})
   await core.capital();const d=JSON.parse(await store.command(['GET','tg-alerts-db']));assert.equal(d.events.length,502);assert.ok(d.events.every(e=>e.delivery==='pending'))
  }finally{db.close()}
 })

 test('cold deployment resumes enabled scheduler without waiting for old watchdog; stop and failure backoff preserved',async()=>{
  const source=readFileSync('cloudflare/worker.mjs','utf8'),ctor=source.slice(source.indexOf('export class AlertsEngine'),source.indexOf(' serial(fn)')).replace('export class','class')+'}\nglobalThis.Engine=AlertsEngine'
  for(const scenario of [{enabled:true,initialized:true,failures:0,expect:true},{enabled:false,initialized:true,failures:0,expect:false},{enabled:true,initialized:false,failures:0,expect:false},{enabled:true,initialized:true,failures:2,expect:false}]){
   let scheduled=null,ready
   const old=Date.now()+570000,ctx={storage:{get:async k=>k==='enabled'?scenario.enabled:scenario.failures,getAlarm:async()=>old,setAlarm:async t=>{scheduled=t}},blockConcurrencyWhile:fn=>{ready=fn()}}
   const sandbox={DurableObject:class{},createLocalStore:()=>({initialized:()=>scenario.initialized}),AsyncLocalStorage,missing:()=>[],Date,Promise,globalThis:null};sandbox.globalThis=sandbox
   new Script(ctor).runInNewContext(sandbox);new sandbox.Engine(ctx,{});await ready
   if(scenario.expect)assert.ok(scheduled>=Date.now()-1000&&scheduled<Date.now()+1000);else assert.equal(scheduled,null)
  }
 })
