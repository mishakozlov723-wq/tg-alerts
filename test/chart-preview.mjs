// Local browser fixture: actual core auth/storage/alert CRUD, simulated OANDA only.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'
const db=new DatabaseSync(':memory:'),store=createLocalStore({sql:{exec:(q,...a)=>db.prepare(q).all(...a)},transactionSync:fn=>fn()});store.initialize({main:{...emptyMain(),owned:{'12345':['DXY','GER40','XAUUSD','XAGUSD']}}})
const secret='local-artificial-chart-key',payload=Buffer.from(JSON.stringify({sub:'12345',project:'alerts',exp:Date.now()+86400000})).toString('base64url'),token=payload+'.'+createHmac('sha256',secret).update(payload).digest('hex')
let stale=false
const source=async input=>{
 const u=new URL(input)
 if(u.pathname.endsWith('/session'))return Response.json({}, {headers:{cst:'fixture','x-security-token':'fixture'}})
 if(u.searchParams.has('searchTerm'))return Response.json({markets:[{epic:'DXY_FIXTURE',instrumentName:'US Dollar Index'}]})
 if(u.pathname.includes('/prices/')) {
  const step={MINUTE_15:900,HOUR:3600,HOUR_4:14400,DAY:86400}[u.searchParams.get('resolution')],count=Number(u.searchParams.get('max')),end=Math.floor((u.searchParams.has('to')?Date.parse(u.searchParams.get('to')+'Z'):Date.now())/1000/step)*step
  return Response.json({prices:Array.from({length:count},(_,i)=>{const time=end-(count-1-i)*step,p=100+Math.sin(time/step/10)*.2;return {snapshotTimeUTC:new Date(time*1000).toISOString(),...Object.fromEntries([['openPrice',p],['highPrice',p+.08],['lowPrice',p-.06],['closePrice',p+.02]].map(([k,v])=>[k,{bid:v-.01,ask:v+.01}]))}})})
 }
 if(u.pathname.endsWith('/markets'))return Response.json({marketDetails:[{instrument:{epic:'DXY_FIXTURE'},snapshot:{bid:100,offer:100.02,marketStatus:'TRADEABLE',updateTimeUTC:new Date(Date.now()-(stale?120000:0)).toISOString()}}]})
 if(u.pathname.endsWith('/candles')){
  const tf=u.searchParams.get('granularity'),step={M15:900,H1:3600,H4:14400,D:86400}[tf],count=Number(u.searchParams.get('count')),end=Math.floor(Date.now()/1000/step)*step
  return Response.json({instrument:u.pathname.split('/')[3],granularity:tf,candles:Array.from({length:count},(_,i)=>{
   const time=end-(count-1-i)*step,p=1.3+Math.sin(time/step/10)*.002
   return {time:new Date(time*1000).toISOString(),complete:i<count-1,mid:{o:String(p),h:String(p+.0008),l:String(p-.0006),c:String(p+.0002)}}
  })})
 }
 if(u.pathname.endsWith('/pricing'))return Response.json({prices:['GBP_USD','EUR_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF'].map(instrument=>({instrument,time:new Date(Date.now()-(stale?120000:0)).toISOString(),tradeable:!stale,bids:[{price:'1.30000'}],asks:[{price:'1.30020'}]}))})
 throw new Error('No live network permitted in chart fixture')
}
const core=await createEngine({LOCAL_STORE:store,FETCH:source,ACCESS_SIGNING_SECRET:secret,REQUIRE_ACCESS:'true',PRICE_SOURCE:'oanda',OANDA_TOKEN:'artificial',OANDA_ACCOUNT:'artificial',OANDA_SIDE:'mid',CAPITAL_API_KEY:'artificial',CAPITAL_IDENTIFIER:'artificial',CAPITAL_PASSWORD:'artificial',MONITOR_ALERTS:'false'})
const root=new URL('../public/',import.meta.url)
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.cf-test/worker.js',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],durableObjects:{ALERTS:{className:'AlertsEngine',useSQLite:true}},serviceBindings:{ASSETS:async req=>{
 const path=new URL(req.url).pathname,filename=path==='/'?'index.html':path.slice(1)
 if(filename.includes('..')||filename.includes('\\'))return new Response('not found',{status:404})
 try {
 let body=await readFile(new URL(filename,root))
 if(filename==='index.html')body=Buffer.from(body.toString().replace(/<link[^>]*https:\/\/[^>]*>/g,'').replace(/<script src="https:\/\/[^>]*><\/script>/g,'').replace('<body>',`<body><aside style="font:12px system-ui;padding:10px">Искусственные данные · локальный стенд <button onclick="fetch('/fixture/stale').then(()=>tick())">Устаревшие цены</button><button onclick="fetch('/fixture/fresh').then(()=>tick())">Свежие цены</button></aside><script>localStorage.setItem('retocker.access.alerts.v1','${token}')</script>`))
 return new Response(body,{headers:{'content-type':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'}})
 }catch{return new Response('not found',{status:404})}
}},outboundService:()=>{throw new Error('No live network')}}))
await mf.ready
const server=http.createServer(async(req,res)=>{
 try {
 const url=new URL(req.url,'http://local')
 if(url.pathname.startsWith('/fixture/')){stale=url.pathname.endsWith('/stale');await core.refreshQuotes();res.end('ok');return}
 let result
 if(url.pathname.startsWith('/api/')) {
  if(url.pathname==='/api/prices')await core.refreshQuotes()
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  result=await core.http(new Request('https://local'+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}))
 } else result=await mf.dispatchFetch('https://local'+req.url)
 res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()))
 }catch(e){res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'fixture_error'}))}
})
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}`))
async function stop(){server.close();await mf.dispose();db.close();process.exit()}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
