import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeLive, localToUtc, LIVE_GRACE_MS } from '../public/live-time.js'
import { createLiveStore, LiveConflict } from '../live-store.js'
import { newReminder, liveView, liveMessage, createLiveRunner } from '../live.js'
const id = '12345678-1234-4234-8234-123456789abc'
const now = Date.parse('2026-03-01T00:00Z')
const config = {text:'Take second phone',date:'2026-03-02',times:['09:00'],timezone:'America/New_York',repeat:'once',count:1}
const iso=(n)=>new Date(n).toISOString()
const create=(c=config)=>newReminder('123',id,c,now)
function local() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-live-'))
  const file=path.join(dir,'live.json')
  return {file,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})}
}
test('schedule validates text, dates, times, timezone, repeat and counts',()=>{
  for(const patch of [{text:''},{text:'a'.repeat(501)},{date:'2026-02-30'},{times:[]},{times:['24:00']},{times:['9:00']},{times:Array(7).fill('10:00')},{timezone:'no/timezone'},{repeat:'hourly'},{count:0},{count:1.5},{count:91},{count:2}]) assert.throws(()=>normalizeLive({...config,...patch},now),JSON.stringify(patch))
  assert.throws(()=>normalizeLive({...config,date:'2026-02-28'},now))
  assert.throws(()=>normalizeLive({...config,date:'2028-01-01'},now))
  assert.throws(()=>normalizeLive(null,now))
  assert.deepEqual(normalizeLive({...config,text:' phone ',times:['10:00','09:00','09:00']},now).config.times,['09:00','10:00'])
})
test('daily reminders preserve wall time across spring DST',()=>{
  const {schedule}=normalizeLive({...config,date:'2026-03-07',repeat:'daily',count:3},now)
  assert.deepEqual(schedule.map(iso),['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z'])
})
test('fall DST repeats the chosen local time once, earlier occurrence',()=>{
  assert.equal(iso(localToUtc('2026-11-01','01:30','America/New_York')),'2026-11-01T05:30:00.000Z')
  assert.equal(iso(localToUtc('2026-11-02','01:30','America/New_York')),'2026-11-02T06:30:00.000Z')
})
test('nonexistent spring wall time rejected, including later recurrences',()=>{
  assert.throws(()=>normalizeLive({...config,date:'2026-03-07',times:['02:30'],repeat:'daily',count:3},now),/does not exist/)
})
test('half-hour timezone offsets and European DST supported',()=>{
  assert.equal(iso(localToUtc('2026-03-02','09:00','Asia/Kolkata')),'2026-03-02T03:30:00.000Z')
  assert.equal(iso(localToUtc('2026-03-29','09:00','Europe/London')),'2026-03-29T08:00:00.000Z')
})
test('weekdays skip weekends; multiple times sorted, count is notification days',()=>{
  const {schedule}=normalizeLive({...config,date:'2026-03-06',times:['18:00','09:00'],repeat:'weekdays',count:2},now)
  assert.deepEqual(schedule.map(iso),['2026-03-06T14:00:00.000Z','2026-03-06T23:00:00.000Z','2026-03-09T13:00:00.000Z','2026-03-09T22:00:00.000Z'])
})
test('weekly schedule; 90-day six-time maximum is finite',()=>{
  const a=normalizeLive({...config,repeat:'weekly',count:2},now)
  assert.equal(a.schedule.length,2);assert.equal(a.schedule[1]-a.schedule[0],167*3600000)
  const b=normalizeLive({...config,times:['08:00','09:00','10:00','11:00','12:00','13:00'],repeat:'daily',count:90},now)
  assert.equal(b.schedule.length,540)
})
test('view exposes only own reminder fields, actual delivery statuses and delayed message',()=>{
  const row=create(),d=row.deliveries[0]
  assert.equal(liveView(row,now).next,d.at);assert.equal(liveView(row,now).userId,undefined)
  assert.equal(liveView(row,d.at+LIVE_GRACE_MS).last.status,'missed')
  assert.equal(liveView({...row,enabled:false},now).status,'paused')
  assert.match(liveMessage(row,d,d.at+120000),/Delayed/)
  assert.equal(liveMessage({...row,config:{...row.config,text:'<b>hello</b>'}},d,d.at),'🔔 Live\n<b>hello</b>') // sent as plain text, never parse_mode
})
test('local records survive restart and isolate users; stale CAS cannot overwrite',async()=>{
  const f=local()
  try {
    const s=await createLiveStore(f),row=create();await s.cas('123',id,null,row,true)
    assert.equal(s.list('456').length,0);assert.equal(s.list('123').length,1)
    const restarted=await createLiveStore(f);assert.deepEqual(await restarted.read('123',id),row)
    await s.cas('123',id,row,{...row,enabled:false})
    await assert.rejects(s.cas('123',id,row,{...row,enabled:true}),LiveConflict)
    assert.equal((await s.read('123',id)).enabled,false)
    await s.cas('123',id,await s.read('123',id),null);assert.equal(s.list('123').length,0)
  }finally{f.cleanup()}
})
test('file write failure never changes memory or allows a send',async()=>{
  const s=await createLiveStore({file:'/no-such-live-dir/live.json'})
  await assert.rejects(s.cas('123',id,null,create(),true));assert.equal(s.all().length,0)
})
test('corrupt local storage and Redis outages fail closed',async()=>{
  const f=local()
  try{fs.writeFileSync(f.file,'{"bad":"not-json"}');await assert.rejects(createLiveStore(f))}finally{f.cleanup()}
  await assert.rejects(createLiveStore({redis:async()=>{throw new Error('offline')}}))
})
// In-memory Redis protocol double executes the CAS semantics. Real Lua is also
// exercised against redis-server in test/live-redis.test.js when available.
function redisDouble() {
  const hash=new Map(),commands=[]
  return {hash,commands,redis:async(cmd)=>{
    commands.push(cmd)
    if(cmd[0]==='HGETALL')return [...hash].flat()
    if(cmd[0]==='HGET')return hash.get(cmd[2])||null
    if(cmd[0]==='EVAL'){
      const [,script,n,key,k,old,next,prefix,isCreate]=cmd
      assert.equal(n,1);assert.match(key,/\{live\}/);assert.match(script,/HGET/)
      if((hash.get(k)||'')!==old)return 0
      if(isCreate==='1'&&[...hash.keys()].filter((k)=>k.startsWith(prefix)).length>=100)return -1
      if(next)hash.set(k,next);else hash.delete(k)
      return 1
    }
    throw new Error('Unexpected Redis command')
  }}
}
test('Redis CAS prevents stale edits, two deployments claim same event only once',async()=>{
  const f=redisDouble(),a=await createLiveStore(f),row=create();await a.cas('123',id,null,row,true)
  const b=await createLiveStore(f);let sends=0
  const run=(store)=>createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>sends++})
  await Promise.all([run(a)(),run(b)()]);assert.equal(sends,1)
  assert.equal((await a.read('123',id)).deliveries[0].status,'sent')
  await assert.rejects(b.cas('123',id,row,{...row,enabled:false}),LiveConflict)
})
test('100 reminder limit checked atomically per user, another user unaffected',async()=>{
  const f=redisDouble(),s=await createLiveStore(f)
  for(let i=0;i<100;i++)await s.cas('123',String(i),null,{...create(),id:String(i)},true)
  await assert.rejects(s.cas('123','extra',null,create(),true),/limit/)
  await s.cas('456',id,null,{...create(),userId:'456'},true)
  assert.equal(s.list('456').length,1)
})
async function runnerFixture(fn) {
  const f=local()
  try {
    const store=await createLiveStore(f),row=create();await store.cas('123',id,null,row,true)
    await fn(store,row,f)
  }finally{f.cleanup()}
}
test('runner non-overlap, durable dedup and restart; Telegram success recorded',()=>runnerFixture(async(store,row,f)=>{
  let sends=0;const run=createLiveRunner({store,clock:()=>row.deliveries[0].at+10000,deliver:async()=>sends++})
  await Promise.all([run(),run()]);await run()
  const restarted=await createLiveStore(f);await createLiveRunner({store:restarted,clock:()=>row.deliveries[0].at+20000,deliver:async()=>sends++})()
  assert.equal(sends,1);assert.equal(liveView(await store.read('123',id)).sent,1)
}))
test('network timeout or rejection not blindly retried; honest status remains',()=>runnerFixture(async(store,row)=>{
  let sends=0;const run=createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>{sends++;throw new Error('timeout')},onError:()=>{}})
  await run();await run();assert.equal(sends,1);assert.equal((await store.read('123',id)).deliveries[0].status,'unknown')
}))
test('definite Telegram rejection marked failed',()=>runnerFixture(async(store,row)=>{
  await createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>{const e=new Error('403');e.definite=true;throw e},onError:()=>{}})()
  assert.equal((await store.read('123',id)).deliveries[0].status,'failed')
}))
test('late recovery sends within grace, never bursts stale reminders',()=>runnerFixture(async(store,row)=>{
  let sends=0
  await createLiveRunner({store,clock:()=>row.deliveries[0].at+LIVE_GRACE_MS,deliver:async()=>sends++})()
  assert.equal(sends,0);assert.equal((await store.read('123',id)).deliveries[0].status,'missed')
}))
test('paused reminder skipped; re-enabled settings cannot replay missed occurrence',()=>runnerFixture(async(store,row)=>{
  await store.cas('123',id,row,{...row,enabled:false});let sends=0
  const run=createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>sends++})
  await run();const paused=await store.read('123',id);await store.cas('123',id,paused,{...paused,enabled:true})
  await run();assert.equal(sends,0)
}))
test('deleted/changed reminder between snapshot and claim never delivered',()=>runnerFixture(async(store,row)=>{
  const cas=store.cas;let deleted=false,sends=0
  store.cas=async(...args)=>{if(!deleted){deleted=true;await cas('123',id,row,null)}return cas(...args)}
  await createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>sends++})()
  assert.equal(sends,0)
}))
test('pause after claim before network request cancels delivery',()=>runnerFixture(async(store,row)=>{
  const read=store.read;let injected=false,sends=0
  store.read=async(...args)=>{const r=await read(...args);if(!injected&&r.deliveries[0].status==='attempting'){injected=true;const paused={...r,enabled:false};await store.cas('123',id,r,paused);return paused}return r}
  await createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>sends++})()
  assert.equal(sends,0);assert.equal((await store.read('123',id)).deliveries[0].status,'cancelled')
}))
test('crashed in-flight claim becomes unknown, never re-sent',()=>runnerFixture(async(store,row)=>{
  const at=row.deliveries[0].at,changed={...row,deliveries:[{at,status:'attempting',attempt:'test',attemptedAt:at}]}
  await store.cas('123',id,row,changed);let sends=0
  await createLiveRunner({store,clock:()=>at+61000,deliver:async()=>sends++})()
  assert.equal(sends,0);assert.equal((await store.read('123',id)).deliveries[0].status,'unknown')
}))
test('failed recipient does not block another user, note text not logged',async()=>{
  const f=local()
  try {
    const store=await createLiveStore(f),a=create(),b={...create(),userId:'456'}
    await store.cas('123',id,null,a,true);await store.cas('456',id,null,b,true)
    const sends=[],errors=[]
    await createLiveRunner({store,clock:()=>a.deliveries[0].at,deliver:async(uid)=>{if(uid==='123')throw new Error(a.config.text);sends.push(uid)},onError:(m)=>errors.push(m)})()
    assert.deepEqual(sends,['456']);assert(errors.every((m)=>!m.includes(a.config.text)))
  }finally{f.cleanup()}
})
