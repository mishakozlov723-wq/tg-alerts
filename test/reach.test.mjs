import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

async function fixture() {
 const db = new DatabaseSync(':memory:')
 const store = createLocalStore({sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>fn()})
 store.initialize({main:emptyMain()})
 let price=1.3, stale=false, closed=false, now=Date.now(), core
 const clock=Date.now; Date.now=()=>now
 const env={LOCAL_STORE:store,PRICE_SOURCE:'mock',MONITOR_ALERTS:'false',OANDA_TOKEN:'artificial',OANDA_ACCOUNT:'fixture',OANDA_SIDE:'mid',FETCH:async url=>{
  if(url.includes('/pricing?'))return Response.json({prices:[{instrument:'GBP_USD',time:new Date(now-(stale?120000:0)).toISOString(),tradeable:!closed,bids:[{price:String(price)}],asks:[{price:String(price)}]}]})
  if(url.endsWith('/instruments'))return Response.json({instruments:[]})
  throw new Error('Unexpected network')
 }}
 core=await createEngine(env)
 return {
  async request(path='',method='GET',body,uid='1') {return core.http(new Request('https://local/api/alerts'+path,{method,headers:{'x-user-id':uid},...(body?{body:JSON.stringify(body)}:{})}))},
  async create(level,dir){return (await this.request('','POST',{symbol:'GBPUSD',level,...(dir?{dir}:{})})).json()},
  async tick(p,options={}){price=p;stale=!!options.stale;closed=!!options.closed;now+=21000;await core.refreshQuotes()},
  async restart(){core=await createEngine(env)},
  main:async()=>JSON.parse(await store.command(['GET','tg-alerts-db'])),
  close(){Date.now=clock;db.close()}
 }
}
test('reach touches or crosses either way once, retains baseline across restart, legacy unchanged',async()=>{
 const f=await fixture()
 try {
  await f.tick(1.3)
  const up=await f.create(1.4),down=await f.create(1.2),legacy=await f.create(1.1,'above')
  assert.equal(up.dir,'reach');assert.equal(up.referencePrice,1.3)
  await f.tick(1.35);let m=await f.main();assert.equal(m.alerts.find(a=>a.id===up.id).status,'active');assert.equal(m.alerts.find(a=>a.id===legacy.id).status,'fired')
  await f.restart();await f.tick(1.41);m=await f.main();assert.equal(m.alerts.find(a=>a.id===up.id).status,'fired')
  await f.tick(1.2);m=await f.main();assert.equal(m.alerts.find(a=>a.id===down.id).status,'fired')
  await f.tick(1.5);assert.equal((await f.main()).events.length,3)
  assert.match(m.events.find(e=>e.text.includes('reached 1.4')).text,/reached/)
 }finally{f.close()}
})
test('stale/closed data cannot arm; first fresh tick arms, next crossing fires; equality fires',async()=>{
 const f=await fixture()
 try {
  await f.tick(1.3,{stale:true});const a=await f.create(1.4);assert.equal(a.referencePrice,undefined)
  await f.tick(1.5,{closed:true});assert.equal((await f.main()).alerts[0].referencePrice,undefined)
  await f.tick(1.5);assert.equal((await f.main()).alerts[0].status,'active')
  await f.restart();await f.tick(1.39);assert.equal((await f.main()).alerts[0].status,'fired')
  const equal=await f.create(1.39);await f.tick(1.39);assert.equal((await f.main()).alerts.find(a=>a.id===equal.id).status,'fired')
 }finally{f.close()}
})
test('owned active level edit preserves identity/note, is idempotent, rejects foreign/fired/invalid edits',async()=>{
 const f=await fixture()
 try {
  await f.tick(1.3);const a=await f.create(1.4,'above')
  assert.equal((await f.request('/'+a.id,'PATCH',{level:1.5},'2')).status,404)
  assert.equal((await f.request('/'+a.id,'PATCH',{level:0,note:'bad'})).status,400)
  let r=await (await f.request('/'+a.id,'PATCH',{level:1.5,note:'note',userId:'2',status:'fired'})).json()
  assert.equal(r.id,a.id);assert.equal(r.userId,'1');assert.equal(r.status,'active');assert.equal(r.createdAt,a.createdAt);assert.equal(r.dir,'reach');assert.equal(r.referencePrice,1.3)
  await f.tick(1.4);await f.request('/'+a.id,'PATCH',{level:1.5});r=(await f.main()).alerts[0];assert.equal(r.referencePrice,1.3);assert.equal(r.note,'note')
  await f.restart();await f.tick(1.6);assert.equal((await f.request('/'+a.id,'PATCH',{level:1.7})).status,409)
  assert.equal((await f.main()).alerts.length,1)
  for(const level of [-1,0,'',null,'bad'])assert.equal((await f.request('','POST',{symbol:'GBPUSD',level})).status,400)
  assert.equal((await f.request('','POST',{symbol:'DXY',level:100})).status,400)
 }finally{f.close()}
})
