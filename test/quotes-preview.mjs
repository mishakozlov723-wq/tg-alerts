// Isolated browser fixture. Uses the built Cloudflare HTML transformation,
// artificial API prices only, no credentials and no live upstream requests.
import http from 'node:http'
import {readFile} from 'node:fs/promises'
import {Miniflare,convertV4MiniflareOptions} from 'miniflare'
const root=new URL('../public/',import.meta.url)
const assets={'/':'index.html','/index.html':'index.html','/intro.js':'intro.js','/h4-settings.js':'h4-settings.js','/live-reminders.js':'live-reminders.js','/live-time.js':'live-time.js'}
const symbols={EURUSD:{digits:5,pip:.0001},GBPUSD:{digits:5,pip:.0001},DXY:{digits:3,pip:.01}}
let mode='fresh',count=0
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.cf-test/worker.js',compatibilityDate:'2026-10-22',compatibilityFlags:['nodejs_compat'],durableObjects:{ALERTS:{className:'AlertsEngine',useSQLite:true}},serviceBindings:{ASSETS:async req=>{
 const p=new URL(req.url).pathname;if(!assets[p])return new Response('not found',{status:404})
 let body=await readFile(new URL(assets[p],root),'utf8')
 if(p==='/'||p==='/index.html'){
  body=body.replace(/<link[^>]*https:\/\/[^>]*>/g,'').replace(/<script src="https:\/\/[^>]*><\/script>/g,'')
  body=body.replace('<body>','<body><aside style="padding:12px;font:12px system-ui">Local quote fixture — artificial data only <button onclick="fixtureMode(\'fresh\')">Fresh</button> <button onclick="fixtureMode(\'partial\')">Partial</button> <button onclick="fixtureMode(\'stale\')">Stale</button> <button onclick="fixtureMode(\'outage\')">Outage</button> <button onclick="fetch(\'/fixture/mode?value=slow\').then(()=>location.reload())">Reopen with slow network</button></aside><script>async function fixtureMode(mode){await fetch(\'/fixture/mode?value=\'+mode);await tick().catch(()=>{})}</script>')
 }
 return new Response(body,{headers:{'content-type':p.endsWith('.js')?'text/javascript':'text/html'}})
}},outboundService:()=>{throw new Error('Live network forbidden in fixture')}}))
await mf.ready
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://fixture');res.setHeader('cache-control','no-store')
  if(url.pathname==='/fixture/mode'){mode=url.searchParams.get('value');res.end('ok');return}
  if(url.pathname.startsWith('/api/')){
   res.setHeader('content-type','application/json');let body={}
   if(url.pathname==='/api/config')body={authRequired:false,symbols,mock:false}
   if(url.pathname==='/api/prices'){
    if(mode==='slow') await new Promise(resolve=>setTimeout(resolve,6000))
    if(mode==='outage'){res.writeHead(503);res.end('{"error":"artificial_outage"}');return}
    const old=mode==='stale',now=Date.now()-(old?120000:0);count++
    body=Object.fromEntries(Object.keys(symbols).filter(s=>mode!=='partial'||s==='EURUSD').map(s=>[s,{price:s==='DXY'?104.125:s==='GBPUSD'?1.30025:1.10025+(count%10)*.00001,dataTs:now,observedAt:now,tradeable:!old,stale:old}]))
   }
   if(url.pathname==='/api/events'||url.pathname==='/api/live')body=[]
   if(url.pathname==='/api/h4/settings')body={enabled:false,symbols:[],lead:[],atClose:true}
   res.end(JSON.stringify(body));return
  }
  const r=await mf.dispatchFetch('https://fixture'+req.url);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()))
 }catch{res.writeHead(500);res.end('Fixture failed')}
})
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}`))
async function stop(){server.close();await mf.dispose();process.exit()}
process.on('SIGINT',stop);process.on('SIGTERM',stop)
