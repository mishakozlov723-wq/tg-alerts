import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as wait} from 'node:timers/promises'
const root=new URL('../',import.meta.url)
test('authenticated API, news/alert regression, real scheduler with stubbed OANDA/Telegram', {timeout:25000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-h4-server-'))
  const port=await new Promise((resolve)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
  const secret='isolated-test-secret-not-a-credential'
  const child=spawn(process.execPath,['--import','./test/fixture-fetch.js','server.js','--legacy'],{cwd:root,env:{PATH:process.env.PATH,PORT:String(port),DB_FILE:path.join(dir,'db.json'),PRICE_SOURCE:'oanda',OANDA_TOKEN:'fixture-token',OANDA_STREAM:'0',BOT_TOKEN:'fixture-token',BOT_POLLING:'off',NEWS_SOURCE:'mock',TG_API:'https://telegram.test.invalid',ACCESS_SIGNING_SECRET:secret,REQUIRE_ACCESS:'true',H4_TEST_DELIVERIES:path.join(dir,'deliveries')}})
  let output='';child.stdout.on('data',(c)=>output+=c);child.stderr.on('data',(c)=>output+=c)
  const base='http://127.0.0.1:'+port
  const headers=(uid)=>{const body=Buffer.from(JSON.stringify({sub:uid,project:'alerts',iat:Date.now(),exp:Date.now()+86400e3})).toString('base64url');return {'content-type':'application/json','x-access-token':body+'.'+crypto.createHmac('sha256',secret).update(body).digest('hex')}}
  async function call(route,{uid='1234',method='GET',body}={}) {
    const r=await fetch(base+route,{method,headers:headers(uid),body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}
  }
  try {
    for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break}catch{};await wait(50)}
    assert.equal((await fetch(base+'/api/h4/settings')).status,401)
    const initial=await call('/api/h4/settings');assert.equal(initial.status,200);assert.equal(initial.data.enabled,false)
    const news=(await call('/api/settings')).data
    const prefs={...initial.data,enabled:true,lead:[10,5]}
    assert.equal((await call('/api/h4/settings',{method:'POST',body:prefs})).status,200)
    assert.deepEqual((await call('/api/settings')).data,news)
    assert.equal((await call('/api/h4/settings',{uid:'5678'})).data.enabled,false)
    assert.equal((await call('/api/h4/settings',{method:'POST',body:{...prefs,symbols:['DXY']}})).status,400)
    assert.equal((await call('/api/h4/settings',{method:'POST',body:{...prefs,lead:['5']}})).status,400)
    const status=(await call('/api/h4/status')).data
    assert.equal(status.assets.EURUSD.status,'live');assert.equal(status.assets.DXY,undefined)
    assert.equal(status.assets.EURUSD.active.close,Date.parse('2026-06-15T17:00Z'))
    const alert=await call('/api/alerts',{method:'POST',body:{symbol:'EURUSD',level:2,dir:'above'}})
    assert.equal(alert.status,200);assert.equal((await call('/api/alerts')).data.length,1)
    await call('/api/alerts/'+alert.data.id,{method:'DELETE'});assert.equal((await call('/api/alerts')).data.length,0)
    const html=await (await fetch(base+'/')).text();assert.match(html,/data-t="settings"/);assert.match(html,/h4-settings.js/)
    // One scheduler cycle, both selected currencies, no real network or account touched.
    await wait(10500)
    const deliveries=fs.readFileSync(path.join(dir,'deliveries'),'utf8').trim().split('\n').map(JSON.parse).filter((x)=>x.chat_id==='1234'&&/min reminder/.test(x.text))
    assert.equal(deliveries.length,2);assert(deliveries.every((x)=>x.text.includes('(5 min reminder)')))
    await call('/api/h4/settings',{method:'POST',body:{...prefs,enabled:false}})
  } catch(e){e.message+='\nSubprocess output:\n'+output;throw e}
  finally { child.kill();await new Promise((r)=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true}) }
})
