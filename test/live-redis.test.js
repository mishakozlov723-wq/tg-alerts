import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import net from 'node:net'
import {setTimeout as wait} from 'node:timers/promises'
import {createLiveStore,LiveConflict} from '../live-store.js'
import {createLiveRunner,newReminder} from '../live.js'
const binary=process.env.REDIS_SERVER||'redis-server'
const available=spawnSync(binary,['--version']).status===0
// Minimal RESP client for isolated tests, no production dependencies.
function decode(buf,start=0){
  const end=buf.indexOf('\r\n',start);if(end<0)return null
  const type=String.fromCharCode(buf[start]),s=buf.toString('utf8',start+1,end);let pos=end+2
  if(type==='+')return {value:s,pos}
  if(type==='-')throw new Error(s)
  if(type===':')return {value:Number(s),pos}
  if(type==='$') {const n=Number(s);if(n===-1)return {value:null,pos};if(buf.length<pos+n+2)return null;return {value:buf.toString('utf8',pos,pos+n),pos:pos+n+2}}
  if(type==='*'){const n=Number(s),value=[];if(n===-1)return {value:null,pos};for(let i=0;i<n;i++){const r=decode(buf,pos);if(!r)return null;value.push(r.value);pos=r.pos}return {value,pos}}
  throw new Error('Unexpected RESP type')
}
function command(port,cmd){return new Promise((resolve,reject)=>{
  const socket=net.createConnection({port,host:'127.0.0.1'});let buffer=Buffer.alloc(0)
  socket.setTimeout(3000,()=>socket.destroy(new Error('Redis test timeout')))
  socket.on('error',reject)
  socket.on('connect',()=>socket.write('*'+cmd.length+'\r\n'+cmd.map((v)=>{const s=String(v);return '$'+Buffer.byteLength(s)+'\r\n'+s+'\r\n'}).join('')))
  socket.on('data',(c)=>{buffer=Buffer.concat([buffer,c]);try{const r=decode(buffer);if(r){socket.end();resolve(r.value)}}catch(e){socket.destroy();reject(e)}})
})}
test('real Redis Lua: atomic delivery dedup, edits/deletes, limits and overlapping deployments',{skip:!available,timeout:15000},async()=>{
  const port=await new Promise((resolve)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
  const child=spawn(binary,['--port',String(port),'--bind','127.0.0.1','--save','','--appendonly','no'],{stdio:'ignore'})
  try{
    for(let i=0;i<100;i++){try{if(await command(port,['PING'])==='PONG')break}catch{}await wait(30)}
    const redis=(cmd)=>command(port,cmd),a=await createLiveStore({redis})
    const now=Date.parse('2026-03-01T00:00Z'),id='12345678-1234-4234-8234-123456789abc'
    const row=newReminder('123',id,{text:'test',date:'2026-03-02',times:['09:00'],timezone:'UTC',repeat:'once',count:1},now)
    await a.cas('123',id,null,row,true)
    const b=await createLiveStore({redis});let sends=0
    const runner=(store)=>createLiveRunner({store,clock:()=>row.deliveries[0].at,deliver:async()=>{sends++}})
    await Promise.all([runner(a)(),runner(b)()]);assert.equal(sends,1)
    await assert.rejects(b.cas('123',id,row,{...row,enabled:false}),LiveConflict)
    const sent=await a.read('123',id);assert.equal(sent.deliveries[0].status,'sent')
    await a.cas('123',id,sent,null);assert.equal(await b.read('123',id),null)
    for(let i=0;i<100;i++)await a.cas('123',String(i),null,{...row,id:String(i)},true)
    await assert.rejects(b.cas('123','extra',null,row,true),/limit/)
    await b.cas('456',id,null,{...row,userId:'456'},true)
    await b.refresh();assert.equal(b.list('123').length,100);assert.equal(b.list('456').length,1)
  }finally{child.kill();await new Promise((r)=>child.once('exit',r))}
})
