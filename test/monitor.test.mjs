import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { createMonitor } from '../cloudflare/monitor.mjs'
import { createNews } from '../cloudflare/news.mjs'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

test('incidents persist, coalesce, recover and do not expose upstream secrets', async () => {
  const data = new Map(), sent = []; let now = 1000000
  const options = { store: async ([op,k,v]) => op === 'GET' ? data.get(k) || null : data.set(k,v), clock: () => now, send: async text => sent.push(text) }
  let monitor = await createMonitor(options)
  monitor.sample('news','Новости','ok','Загружено'); await monitor.notify(); assert.equal(sent.length,0)
  monitor.sample('news','Новости','error','Источник недоступен'); await monitor.notify(); assert.equal(sent.length,1)
  monitor = await createMonitor(options)
  monitor.sample('news','Новости','error','Источник недоступен'); await monitor.notify(); assert.equal(sent.length,1)
  now += 300001
  monitor.sample('news','Новости','ok','Источник восстановлен'); await monitor.notify(); assert.equal(sent.length,2)
  assert.match(sent[1],/✅/); assert.equal(monitor.snapshot().incidents.length,2)
  assert.match(monitor.render('logs'),/Источник недоступен/)
  assert.match(monitor.render(),/в норме/)
})
for (const safe of [false,true]) test(`monitor notification failure: retrySafe=${safe}`, async () => {
  const data = new Map(); let now = 1000000, calls = 0
  const options = { store: async ([op,k,v]) => op === 'GET' ? data.get(k) || null : data.set(k,v), clock: () => now,
    send: async () => { calls++; throw Object.assign(new Error('artificial'), { retrySafe: safe, retryAfterMs: 10000 }) } }
  let m = await createMonitor(options); m.sample('x','X','error','Ошибка'); await m.notify()
  m = await createMonitor(options); await m.notify(); assert.equal(calls,1)
  now += 300001; await m.notify(); assert.equal(calls,safe ? 2 : 1)
})
function fixture() {
  const db = new DatabaseSync(':memory:'), calls = []
  const store = createLocalStore({ sql: { exec: (q,...a) => db.prepare(q).all(...a) }, transactionSync: fn => {
    db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch(e) { db.exec('ROLLBACK'); throw e }
  } })
  store.initialize({ main: emptyMain() })
  let brokenNews = false, brokenAccess = false
  const env = { ADMIN_CHAT_ID:'99999', BOT_TOKEN:'artificial-token', PRICE_SOURCE:'mock', AUTH_API_URL:'https://access.test', LOCAL_STORE:store,
    FETCH:async (input, init) => {
      const u = new URL(input)
      if (u.hostname === 'api.telegram.org') { calls.push({method:u.pathname.split('/').at(-1),payload:JSON.parse(init.body)}); return Response.json({ok:true,result:true}) }
      if (u.hostname === 'access.test') return Response.json({ok:!brokenAccess},{status:brokenAccess?503:200})
      if (u.hostname.includes('faireconomy')) { if(brokenNews)throw new Error('private-secret-should-not-leak'); return Response.json([]) }
      throw new Error('Unexpected network')
    } }
  const update = (id,text,chat=id,type='private') => ({ message:{from:{id},chat:{id:chat,type},text} })
  return {db,store,calls,env,update,breakNews:()=>{brokenNews=true},breakAccess:()=>{brokenAccess=true} }
}
test('status command and detail buttons are founder-only, no implicit admin fallback',async()=>{
  const f=fixture()
  try {
    let engine=await createEngine(f.env)
    await engine.update(f.update(12345,'/status')); assert.equal(f.calls.length,0)
    await engine.update(f.update(99999,'/status',-100,'group')); assert.equal(f.calls.length,0)
    await engine.update(f.update(99999,'/status')); assert.match(f.calls.at(-1).payload.text,/Alerts:/)
    assert.ok(f.calls.at(-1).payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='status:logs'))
    await engine.update({callback_query:{id:'a',from:{id:12345},data:'status:logs',message:{chat:{id:12345,type:'private'}}}})
    assert.equal(f.calls.at(-1).payload.text,'Admin only')
    await engine.update({callback_query:{id:'b',from:{id:99999},data:'status:quotes',message:{chat:{id:99999,type:'private'}}}})
    assert.match(f.calls.at(-1).payload.text,/DXY/)
    f.calls.length=0; engine=await createEngine({...f.env,ADMIN_CHAT_ID:''})
    await engine.update(f.update(1011596614,'/status')); assert.equal(f.calls.length,0)
  } finally {f.db.close()}
})
test('housekeeping reports source failures, preserves diagnostics across restart, and empty news is healthy',async()=>{
  const f=fixture()
  try {
    const engine=await createEngine(f.env); await engine.housekeeping()
    let state=JSON.parse(await f.store.command(['GET','tg-alerts:monitor:v1']))
    assert.equal(state.parts.news.level,'ok'); assert.equal(state.parts.live.level,'idle')
    assert.equal(state.parts.h4.level,'idle'); assert.equal(state.parts.access.level,'ok')
    f.breakNews();f.breakAccess()
    // Expire the calendar cache without a live wait, then restart to test persistence.
    await f.store.command(['SET','tg-alerts-news',JSON.stringify({ts:1,items:[]})])
    const restarted=await createEngine(f.env); await restarted.housekeeping()
    state=JSON.parse(await f.store.command(['GET','tg-alerts:monitor:v1']))
    assert.equal(state.parts.news.level,'error');assert.equal(state.parts.access.level,'error')
    const messages=f.calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text)
    assert.ok(messages.some(t=>t.includes('Новости')&&t.includes('ошибок подряд: 1')))
    assert.ok(!messages.join('').includes('private-secret-should-not-leak'))
    const count=messages.length;await restarted.housekeeping()
    assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,count)
  } finally {f.db.close()}
})
test('flapping sends only current state and retains an unsent outage in recovery', async () => {
  const data = new Map(), sent = []; let now = 1000000
  const m = await createMonitor({ store: async ([op,k,v]) => op === 'GET' ? data.get(k) : data.set(k,v), clock:()=>now, send:async t=>sent.push(t) })
  m.sample('x','X','error','Первый сбой'); await m.notify()
  m.sample('x','X','ok','Восстановлено'); await m.notify()
  m.sample('x','X','error','Новый сбой'); await m.notify()
  now+=300001; await m.notify(); assert.match(sent.at(-1),/Новый сбой/); assert.doesNotMatch(sent.at(-1),/Восстановлено/)
  m.sample('y','Y','error','Пропущенный сбой'); m.sample('y','Y','ok','Работает'); await m.notify()
  assert.match(sent.at(-1),/Предшествующий сбой: Пропущенный сбой/)
})
test('status does not refresh background progress; watchdog survives restart', async () => {
  const f=fixture(), realNow=Date.now; let now=realNow(); Date.now=()=>now
  try {
    let e=await createEngine(f.env); await e.housekeeping()
    now+=130000; await e.update(f.update(99999,'/status'))
    let state=JSON.parse(await f.store.command(['GET','tg-alerts:monitor:v1']))
    assert.equal(state.parts.scheduler.level,'error'); assert.ok(state.housekeepingAt<now-120000)
    e=await createEngine(f.env); await e.watchdog()
    assert.ok(f.calls.some(c=>c.payload.text?.includes('[Alerts] Фоновые задачи')))
    state=JSON.parse(await f.store.command(['GET','tg-alerts:monitor:v1']))
    assert.equal(state.parts.scheduler.level,'error'); assert.ok(state.housekeepingAt<now-120000)
    await e.housekeeping();state=JSON.parse(await f.store.command(['GET','tg-alerts:monitor:v1']))
    assert.equal(state.parts.scheduler.level,'ok')
  } finally {Date.now=realNow;f.db.close()}
})
test('news budget deferral is not a source failure; malformed nonempty data is rejected', async () => {
  const data=new Map();let deferred=true, malformed=false
  const news=createNews({LOCAL_STORE:{command:async([op,k,v])=>op==='GET'?data.get(k):data.set(k,v)}, FETCH:async()=>{
    if(deferred)throw Object.assign(new Error('budget'),{retrySafe:true})
    return Response.json(malformed?[{}]:[])
  }})
  await assert.rejects(news.getNews(),{message:'budget'});assert.equal(news.status().fails,0)
  deferred=false;malformed=true;await news.getNews();assert.equal(news.status().fails,1);assert.equal(news.status().lastSuccess,0)
  const healthy=createNews({LOCAL_STORE:{command:async()=>null},FETCH:async()=>Response.json([])})
  await healthy.getNews();assert.ok(healthy.status().lastSuccess);assert.equal(healthy.status().fails,0)
})
test('Access diagnostics use the same default endpoint as code redemption',async()=>{
  const f=fixture();let checked=false
  try {
    const e=await createEngine({...f.env,AUTH_API_URL:'',FETCH:async(u,i)=>{
      if(new URL(u).hostname==='retocker-access.retocker.workers.dev'){checked=true;assert.equal(new URL(u).pathname,'/health');return Response.json({ok:true})}
      return f.env.FETCH(u,i)
    }})
    await e.housekeeping();assert.ok(checked)
    assert.equal(JSON.parse(await f.store.command(['GET','tg-alerts:monitor:v1'])).parts.access.level,'ok')
  }finally{f.db.close()}
})
test('recovery consumes persisted window fault only after reporting it',async()=>{
  const source=readFileSync(new URL('../cloudflare/worker.mjs',import.meta.url),'utf8')
  const method=source.slice(source.indexOf(' async handle(req){'),source.indexOf("  if(p==='/health')"))+' return null; }'
  const data=new Map([['enabled',true],['monitorSchedulerFailure',true]]), calls=[]
  const storage={get:async k=>data.get(k),delete:async k=>data.delete(k),getAlarm:async()=>123}
  const obj={env:{},ctx:{storage},window:null,local:{initialized:()=>true},core:async()=>({reportFailure:async()=>calls.push('failure'),watchdog:async()=>calls.push('watchdog')})}
  const sandbox={URL,json:(status,value)=>({status,value})}
  new Script('globalThis.handle=({'+method+'}).handle').runInNewContext(sandbox)
  await sandbox.handle.call(obj,new Request('https://internal/internal/recover'))
  assert.deepEqual(calls,['failure','watchdog']);assert.equal(data.has('monitorSchedulerFailure'),false)
  data.set('monitorSchedulerFailure',true);obj.core=async()=>({reportFailure:async()=>{throw new Error('storage unavailable')}})
  await assert.rejects(sandbox.handle.call(obj,new Request('https://internal/internal/recover')))
  assert.equal(data.get('monitorSchedulerFailure'),true)
})
test('unexpected scheduler failure is recorded and sent without exception payload',async()=>{
  const f=fixture()
  try {const engine=await createEngine(f.env);await engine.reportFailure();assert.match(f.calls.at(-1).payload.text,/Фоновые задачи/);await engine.reportFailure();assert.equal(f.calls.length,1)}finally{f.db.close()}
})
