import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as wait} from 'node:timers/promises'
const root = new URL('../', import.meta.url)
test('Live API auth, ownership, validation, CRUD, real timer, persistence and no duplicate retry', {timeout:35000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-live-server-')),clock=path.join(dir,'clock'),deliveries=path.join(dir,'deliveries')
  const time=Date.parse('2026-06-15T16:55Z');fs.writeFileSync(clock,String(time))
  fs.writeFileSync(path.join(dir,'db.json.h4.json'),JSON.stringify({settings:{'5678':{enabled:true,symbols:['DXY'],lead:[5],atClose:true,since:time-1000}},sent:{}}))
  const port=await new Promise((resolve)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
  const secret='isolated-live-test-not-a-credential',base='http://127.0.0.1:'+port
  let child,output=''
  function boot(){
    child=spawn(process.execPath,['--import','./test/fixture-fetch.js','server.js'],{cwd:root,env:{PATH:process.env.PATH,PORT:String(port),DB_FILE:path.join(dir,'db.json'),PRICE_SOURCE:'oanda',OANDA_TOKEN:'fixture-token',OANDA_STREAM:'0',BOT_TOKEN:'fixture-token',BOT_POLLING:'off',NEWS_SOURCE:'mock',TG_API:'https://telegram.test.invalid',ACCESS_SIGNING_SECRET:secret,REQUIRE_ACCESS:'true',H4_TEST_DELIVERIES:deliveries,LIVE_TEST_CLOCK:clock}})
    child.stdout.on('data',(c)=>output+=c);child.stderr.on('data',(c)=>output+=c)
  }
  const headers=(uid)=>{const b=Buffer.from(JSON.stringify({sub:uid,project:'alerts',exp:Date.now()+86400e3})).toString('base64url');return {'content-type':'application/json','x-access-token':b+'.'+crypto.createHmac('sha256',secret).update(b).digest('hex')}}
  async function call(route,{uid='1234',method='GET',body}={}){const r=await fetch(base+route,{method,headers:headers(uid),body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
  async function ready(){for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return}catch{}await wait(50)}throw new Error('Server not ready')}
  async function stop(){const c=child;if(!c||c.exitCode!==null)return;c.kill();await new Promise((r)=>c.once('exit',r))}
  const id=crypto.randomUUID(),cfg={id,text:'Take phone <b>literal</b>',date:'2026-06-15',times:['16:56','17:10'],timezone:'UTC',repeat:'once',count:1}
  try{
    boot();await ready()
    assert.equal((await fetch(base+'/api/live')).status,401)
    assert.equal((await call('/api/live')).data.configured,true)
    assert.deepEqual((await call('/api/live')).data.reminders,[])
    const news=(await call('/api/settings')).data
    assert.equal((await call('/api/live',{method:'POST',body:{...cfg,times:['bad']}})).status,400)
    let a=await call('/api/live',{method:'POST',body:cfg});assert.equal(a.status,201);assert.equal(a.data.total,2)
    assert.equal((await call('/api/live',{method:'POST',body:cfg})).status,200)
    assert.equal((await call('/api/live',{method:'POST',body:{...cfg,text:'changed'}})).status,409)
    assert.equal((await call('/api/live')).data.reminders.length,1)
    assert.equal((await call('/api/live',{uid:'5678'})).data.reminders.length,0)
    assert.equal((await call('/api/live/'+id,{uid:'5678',method:'DELETE',body:{revision:a.data.revision}})).status,404)
    assert.equal((await call('/api/live/'+id,{method:'PUT',body:{...cfg,text:'new',revision:'stale'}})).status,409)
    const old=a.data.revision
    a=await call('/api/live/'+id,{method:'PATCH',body:{enabled:false,revision:a.data.revision}});assert.equal(a.data.status,'paused')
    assert.equal((await call('/api/live/'+id,{method:'DELETE',body:{revision:old}})).status,409)
    a=await call('/api/live/'+id,{method:'PATCH',body:{enabled:true,revision:a.data.revision}});assert.equal(a.data.enabled,true)
    assert.deepEqual((await call('/api/settings')).data,news)
    assert.equal((await call('/api/h4/settings')).data.enabled,false)
    // Price DXY still present in source/config policy, while it is absent in H4.
    const h4=(await call('/api/h4/status')).data;assert.equal(h4.assets.DXY,undefined)
    const legacy=(await call('/api/h4/settings',{uid:'5678'})).data;assert.deepEqual(legacy.symbols,[]);assert.equal(legacy.enabled,false)
    const html=await(await fetch(base+'/')).text();assert.match(html,/data-t="live"/);assert(!html.includes('Open the bot and tap'))
    fs.writeFileSync(clock,String(time+70000));await wait(10500)
    let sends=fs.readFileSync(deliveries,'utf8').trim().split('\n').map(JSON.parse).filter((p)=>p.chat_id==='1234'&&p.text.startsWith('🔔 Live'))
    assert.equal(sends.length,1);assert.equal(sends[0].text,'🔔 Live\n'+cfg.text);assert.equal(sends[0].parse_mode,undefined)
    const sent=(await call('/api/live')).data.reminders[0];assert.equal(sent.sent,1)
    await stop();boot();await ready();await wait(500)
    sends=fs.readFileSync(deliveries,'utf8').trim().split('\n').map(JSON.parse).filter((p)=>p.chat_id==='1234'&&p.text.startsWith('🔔 Live'))
    assert.equal(sends.length,1)
    // Idempotent create retry works after its scheduled time has passed.
    assert.equal((await call('/api/live',{method:'POST',body:cfg})).status,200)
    const current=(await call('/api/live')).data.reminders[0]
    const edit=await call('/api/live/'+id,{method:'PUT',body:{...cfg,times:['17:10'],text:'Edited',revision:current.revision}})
    assert.equal(edit.status,200);assert.equal(edit.data.text,'Edited')
    assert.equal((await call('/api/live/'+id,{method:'DELETE',body:{revision:edit.data.revision}})).status,200)
    assert.deepEqual((await call('/api/live')).data.reminders,[])
  }catch(e){e.message+='\nChild output:\n'+output;throw e}
  finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
})
