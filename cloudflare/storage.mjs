import { createHash } from 'node:crypto'
// Local SQLite compatibility adapter for the few storage operations used by the
// original H4/Live modules. There is NO Redis service or Redis credential here.
export const emptyMain=()=>({alerts:[],settings:{},events:[],sentNews:{},seq:1,owned:{},orders:{}})
export function validateMain(value){
 if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('invalid_import_main')
 const d={...emptyMain(),...value}
 for(const k of ['settings','owned','orders','sentNews'])if(!d[k]||typeof d[k]!=='object'||Array.isArray(d[k]))throw new Error('invalid_import_'+k)
 if(!Array.isArray(d.alerts)||!Array.isArray(d.events)||!Number.isSafeInteger(d.seq)||d.seq<1)throw new Error('invalid_import_main')
 if(d.alerts.some(a=>!a||!Number.isSafeInteger(a.id)||typeof a.userId!=='string'||!['active','fired','paused'].includes(a.status)||!Number.isFinite(a.level)))throw new Error('invalid_import_alerts')
 // One shared sequence serves alerts, events and orders. Repair a stale backup
 // counter, but never silently accept ambiguous alert IDs.
 const alertIds=d.alerts.map(a=>a.id)
 if(new Set(alertIds).size!==alertIds.length)throw new Error('invalid_import_duplicate_alert_ids')
 const occupied=[...alertIds,...d.events.map(e=>e?.id),...Object.values(d.orders).map(o=>o?.id)].filter(Number.isSafeInteger)
 const highest=occupied.reduce((a,b)=>Math.max(a,b),0)
 d.seq=Math.max(d.seq,highest+1)
 if(!Number.isSafeInteger(d.seq)||d.seq>=Number.MAX_SAFE_INTEGER)throw new Error('invalid_import_sequence_exhausted')
 return d
}
export function createLocalStore(storage){
 const sql=storage.sql, all=(q,...args)=>[...sql.exec(q,...args)]
 sql.exec('CREATE TABLE IF NOT EXISTS alerts_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires REAL)')
 sql.exec('CREATE TABLE IF NOT EXISTS alerts_hash (k TEXT NOT NULL, f TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY(k,f))')
 const read=k=>{const r=all('SELECT v,expires FROM alerts_kv WHERE k=?',k)[0];if(!r)return null;if(r.expires&&r.expires<=Date.now()){sql.exec('DELETE FROM alerts_kv WHERE k=?',k);return null}return r.v}
 const write=(k,v,expires=null)=>sql.exec('INSERT INTO alerts_kv(k,v,expires) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,expires=excluded.expires',k,String(v),expires)
 const hget=(k,f)=>all('SELECT v FROM alerts_hash WHERE k=? AND f=?',k,f)[0]?.v??null
 const hset=(k,f,v)=>sql.exec('INSERT INTO alerts_hash(k,f,v) VALUES(?,?,?) ON CONFLICT(k,f) DO UPDATE SET v=excluded.v',k,f,String(v))
 function command(c){
  const [op,k,...a]=c
  if(op==='GET')return read(k)
  if(op==='SET')return storage.transactionSync(()=>{if(a.includes('NX')&&read(k)!==null)return null;const ix=a.indexOf('EX');write(k,a[0],ix>=0?Date.now()+Number(a[ix+1])*1000:null);return 'OK'})
  if(op==='HGETALL')return all('SELECT f,v FROM alerts_hash WHERE k=? ORDER BY f',k).flatMap(x=>[x.f,x.v])
  if(op==='HGET')return hget(k,a[0])
  if(op==='HSET'){hset(k,a[0],a[1]);return 1}
  if(op==='EVAL')return storage.transactionSync(()=>{
   const script=k,n=a[0]
   // Execute ONLY the two known, fixed CAS operations from the original helpers.
   if(n===2&&script.includes("redis.call('SET', KEYS[2]")){
    const [,hash,marker,user,expected]=a
    if(hget(hash,user)!==expected||read(marker)!==null)return null
    write(marker,'1',Date.now()+172800000);return 'OK'
   }
   if(n===1&&script.includes("ARGV[5]=='1'")){
    const [,hash,field,old,next,prefix,isCreate]=a
    if((hget(hash,field)||'')!==old)return 0
    if(isCreate==='1'&&all('SELECT f FROM alerts_hash WHERE k=?',hash).filter(x=>x.f.startsWith(prefix)).length>=100)return -1
    if(next)hset(hash,field,next);else sql.exec('DELETE FROM alerts_hash WHERE k=? AND f=?',hash,field)
    return 1
   }
   throw new Error('unsupported_local_storage_operation')
  })
  throw new Error('unsupported_local_storage_command')
 }
 return {
  async command(c){try{return command(c)}catch(e){e.storageFailure=true;throw e}},
  initialized:()=>read('tg-alerts-db')!==null,
  initialize(snapshot){return storage.transactionSync(()=>{
   if(read('tg-alerts-db')!==null)throw Object.assign(new Error('database_already_initialized'),{status:409})
   const main=validateMain(snapshot.main)
   const h4=snapshot.h4||{},live=snapshot.live||[]
   if(typeof h4!=='object'||Array.isArray(h4)||!Array.isArray(live)||snapshot.h4Markers&&!Array.isArray(snapshot.h4Markers))throw new Error('invalid_import_reminders')
   write('tg-alerts-db',JSON.stringify(main))
   for(const [uid,v] of Object.entries(h4)){
    if(!v||!/^\d+$/.test(uid)||typeof v.enabled!=='boolean'||!Array.isArray(v.symbols)||!Array.isArray(v.lead)||typeof v.atClose!=='boolean')throw new Error('invalid_import_h4')
    hset('tg-alerts:{h4}:settings:v1',uid,JSON.stringify(v))
   }
   for(const v of live){
    if(!v||typeof v.userId!=='string'||!/^\d+$/.test(v.userId)||typeof v.id!=='string'||!Array.isArray(v.deliveries)||!v.config)throw new Error('invalid_import_live')
    hset('tg-alerts:{live}:reminders:v1',v.userId+'|'+v.id,JSON.stringify(v))
   }
   for(const [key,at] of Object.entries(snapshot.h4Sent||{}))if(Number.isFinite(at)&&Date.now()-at<172800000)write('tg-alerts:{h4}:sent:'+createHash('sha256').update(key).digest('hex'),'1',at+172800000)
   for(const marker of snapshot.h4Markers||[]){
    if(!marker||!/^tg-alerts:\{h4\}:sent:[a-f0-9]{64}$/.test(marker.key)||!Number.isFinite(marker.expires))throw new Error('invalid_import_h4_marker')
    if(marker.expires>Date.now())write(marker.key,'1',Math.min(Date.now()+172800000,marker.expires))
   }
   write('cloudflare-initialized-at',String(Date.now()))
   return {alerts:main.alerts.length,purchaseOwners:Object.keys(main.owned).length,h4Users:Object.keys(h4).length,liveReminders:live.length}
  })},
  exportSnapshot(){
   return {formatVersion:1,main:JSON.parse(read('tg-alerts-db')),h4:Object.fromEntries(all('SELECT f,v FROM alerts_hash WHERE k=?','tg-alerts:{h4}:settings:v1').map(r=>[r.f,JSON.parse(r.v)])),live:all('SELECT v FROM alerts_hash WHERE k=?','tg-alerts:{live}:reminders:v1').map(r=>JSON.parse(r.v)),h4Markers:all('SELECT k AS key, expires FROM alerts_kv WHERE k LIKE ? AND expires>?','tg-alerts:{h4}:sent:%',Date.now())}
  },
  cleanup(){sql.exec('DELETE FROM alerts_kv WHERE expires IS NOT NULL AND expires<=?',Date.now())},
 }
}
