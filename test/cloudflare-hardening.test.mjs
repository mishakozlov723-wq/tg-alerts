import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processUpdateOnce } from '../cloudflare/update-once.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'
import { createLiveStore, LiveConflict } from '../live-store.js'
import { newReminder, createLiveRunner } from '../live.js'
import { createMonitor } from '../cloudflare/monitor.mjs'
const update={update_id:42}, date=Date.parse('2026-10-30T00:00:00Z')
function kv(){const data=new Map();return {data,get:async k=>data.get(k),put:async(k,v)=>data.set(k,structuredClone(v))}}
for (const failDone of [false,true]) test(`interrupted command never repeats an external effect; done checkpoint fails=${failDone}`,async()=>{
 const storage=kv(),put=storage.put;let effects=0,preparations=0
 if(failDone)storage.put=async(k,v)=>{if(v.status!=='processing')throw new Error('write unavailable');return put(k,v)}
 const prepare=async()=>{preparations++;return async()=>{effects++;if(!failDone)throw new Error('failure after send')}}
 await assert.rejects(processUpdateOnce({storage,update,prepare}))
 assert.ok(['unknown','processing'].includes((await storage.get('update:42')).status))
 // New invocation/process uses only persisted state, not a local in-flight flag.
 assert.equal((await processUpdateOnce({storage,update,prepare})).duplicate,true)
 assert.equal(effects,1);assert.equal(preparations,1)
})
test('initialization/claim failures can retry safely; normal completion deduplicates',async()=>{
 const storage=kv();let effects=0
 await assert.rejects(processUpdateOnce({storage,update,prepare:async()=>{throw Error('init')}}));assert.equal(storage.data.size,0)
 const put=storage.put;storage.put=async()=>{throw Error('disk')}
 const prepare=async()=>async()=>{effects++}
 await assert.rejects(processUpdateOnce({storage,update,prepare}));assert.equal(effects,0)
 storage.put=put;await processUpdateOnce({storage,update,prepare});await processUpdateOnce({storage,update,prepare});assert.equal(effects,1)
 assert.equal((await storage.get('update:42')).status,'done')
})
function sqlite(){const db=new DatabaseSync(':memory:');const store=createLocalStore({sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>{db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}});store.initialize({main:emptyMain()});return {db,store}}
function reminder(uid='12345'){return newReminder(uid,'12345678-1234-4234-8234-123456789abc',{text:'test',date:'2026-10-30',times:['00:01'],timezone:'UTC',repeat:'once',count:1},date)}
test('SQLite Live quarantines bad JSON, wrong keys and invalid delivery rows; healthy users still send and restart',async()=>{
 const {db,store}=sqlite(),HASH='tg-alerts:{live}:reminders:v1',a=reminder(),b=reminder('67890'),sent=[]
 const badRows={'bad|json':'not-json','wrong|key':JSON.stringify(a),'12345|bad':JSON.stringify({...a,config:null}),'12345|delivery':JSON.stringify({...a,id:'delivery',deliveries:[null]})}
 try{
  for(const [k,v] of Object.entries(badRows))await store.command(['HSET',HASH,k,v])
  let live=await createLiveStore({redis:store.command});await live.cas(a.userId,a.id,null,a,true);await live.cas(b.userId,b.id,null,b,true)
  assert.equal(live.diagnostics().invalidRecords,4);assert.equal(live.all().length,2);assert.equal(live.list(a.userId).length,1)
  assert.equal(await live.read('bad','json'),null)
  await assert.rejects(live.cas('bad','json',null,a,true),LiveConflict)
  await createLiveRunner({store:live,clock:()=>date+60001,deliver:async uid=>sent.push(uid)})()
  assert.deepEqual(sent.sort(),['12345','67890'])
  live=await createLiveStore({redis:store.command});await createLiveRunner({store:live,clock:()=>date+61000,deliver:async()=>sent.push('duplicate')})()
  assert.equal(sent.length,2);assert.equal(live.diagnostics().invalidRecords,4)
  for(const [k,v] of Object.entries(badRows))assert.equal(await store.command(['HGET',HASH,k]),v,'quarantine preserves original bytes')
  await store.command(['HSET',HASH,'bad|json',JSON.stringify({...a,userId:'bad',id:'json'})]);await live.refresh();assert.equal(live.diagnostics().invalidRecords,3)
 }finally{db.close()}
})
test('file Live isolates damaged rows without erasing them when healthy reminders change',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'live-isolation-')),file=join(dir,'live.json'),a=reminder()
 try{writeFileSync(file,JSON.stringify({'broken|record':'malformed'}));const live=await createLiveStore({file});await live.cas(a.userId,a.id,null,a,true)
 assert.equal(live.all().length,1);assert.equal(live.diagnostics().invalidRecords,1);assert.equal(JSON.parse(readFileSync(file))['broken|record'],'malformed')
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('monitor checkpoints changes inside one minute, including same-level details and immediate restart',async()=>{
 const storage=kv();let now=date,writes=0
 const options={store:async([op,k,v])=>{if(op==='GET')return storage.data.get(k);writes++;storage.data.set(k,v)},clock:()=>now,send:async()=>assert.fail('no scheduled report')}
 let monitor=await createMonitor(options);monitor.sample('x','X','ok','old');await monitor.flush();now+=1000;monitor.sample('x','X','ok','new');await monitor.flush()
 monitor=await createMonitor(options);assert.equal(monitor.snapshot().parts.x.detail,'new')
 monitor.sample('x','X','error','failed');await monitor.flush();monitor=await createMonitor(options);assert.equal(monitor.snapshot().incidents.at(-1).detail,'failed')
 await monitor.flush();const prior=writes;await monitor.flush();assert.equal(writes,prior,'unchanged snapshot does not write again')
})
test('monitor orders concurrent checkpoints and preserves mutations during a pending write',async()=>{
 const data=new Map();let release,hold=false
 const monitor=await createMonitor({store:async([op,k,v])=>{if(op==='GET')return null;if(hold){hold=false;await new Promise(r=>release=r)}data.set(k,v)},send:async()=>{},clock:()=>date})
 await monitor.flush();monitor.sample('x','X','ok','first');hold=true;const pending=monitor.flush();monitor.sample('x','X','error','second');const pending2=monitor.flush();release();await Promise.all([pending,pending2])
 assert.equal(JSON.parse(data.get('tg-alerts:monitor:v1')).parts.x.detail,'second')
})
test('Cloudflare configuration and served assets contain no Render endpoints',()=>{
 for(const file of ['cloudflare/worker.mjs','cloudflare/core.mjs'])assert.doesNotMatch(readFileSync(new URL('../'+file,import.meta.url),'utf8'),/onrender\.com|RENDER_EXTERNAL_URL/)
})
