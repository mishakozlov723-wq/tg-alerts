import { DurableObject } from 'cloudflare:workers'
import { AsyncLocalStorage } from 'node:async_hooks'
import { timingSafeEqual } from 'node:crypto'
import { createEngine } from './core.mjs'
import { createLocalStore, emptyMain } from './storage.mjs'
import { verifyAccessToken } from '../shared/access-token.mjs'
const equal=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y)}
const json=(status,value)=>Response.json(value,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}})
export function missing(env){
 const keys=['BOT_TOKEN','ACCESS_SIGNING_SECRET','TELEGRAM_WEBHOOK_SECRET','OANDA_TOKEN'].filter(k=>!env[k])
 if(env.PRICE_SOURCE!=='oanda')keys.push('PRICE_SOURCE_must_be_oanda')
 if(env.OANDA_SIDE&&!['bid','ask','mid'].includes(env.OANDA_SIDE))keys.push('OANDA_SIDE_invalid')
 if(env.OANDA_ENV&&!['practice','live'].includes(env.OANDA_ENV))keys.push('OANDA_ENV_invalid')
 if(env.CAPITAL_SIDE&&!['bid','ask','mid'].includes(env.CAPITAL_SIDE))keys.push('CAPITAL_SIDE_invalid')
 if(env.CAPITAL_ENV&&!['demo','live'].includes(env.CAPITAL_ENV))keys.push('CAPITAL_ENV_invalid')
 const cap=['CAPITAL_API_KEY','CAPITAL_IDENTIFIER','CAPITAL_PASSWORD'].filter(k=>!!env[k]);if(cap.length&&cap.length!==3)keys.push('CAPITAL_credentials_incomplete')
 return keys
}
async function data(req,max=12000){
 let total=0;const chunks=[],reader=req.body?.getReader();if(!reader)return {}
 for(;;){const x=await reader.read();if(x.done)break;total+=x.value.byteLength;if(total>max){await reader.cancel();throw Object.assign(new Error('body_too_large'),{status:413})}chunks.push(x.value)}
 try{const v=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!v||Array.isArray(v)||typeof v!=='object')throw new Error();return v}catch{throw Object.assign(new Error('invalid_json'),{status:400})}
}
async function tg(env,method,payload){
 const r=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000),redirect:'manual'})
 const d=await r.json();if(!r.ok||!d.ok)throw new Error('telegram_request_failed');return d
}
const secretOK=(req,env,header)=>!!env.TELEGRAM_WEBHOOK_SECRET&&equal(req.headers.get(header),env.TELEGRAM_WEBHOOK_SECRET)
const abortError=()=>Object.assign(new Error('window_stopped'),{name:'AbortError'})
async function sleep(ms,signal){if(signal.aborted)return;await new Promise(resolve=>{const done=()=>{clearTimeout(t);signal.removeEventListener('abort',done);resolve()},t=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true})})}
export class AlertsEngine extends DurableObject{
 constructor(ctx,env){
  super(ctx,env);this.ctx=ctx;this.env=env;this.tail=Promise.resolve();this.coreJob=null;this.window=null;this.epoch=0;this.lastSchedulerRun=null;this.enabled=false
  this.local=createLocalStore(ctx.storage);this.context=new AsyncLocalStorage()
  // An invocation has a finite outbound budget. Stop/reconnect before the Free
  // 50-subrequest ceiling; HTTP stream chunks are NOT separate fetches.
  this.runtimeEnv={...env,LOCAL_STORE:this.local,FETCH:async(input,init={})=>{
   const budget=this.context.getStore()
   if(budget){
    if(budget.controller.signal.aborted||budget.calls>=40){budget.controller.abort();throw Object.assign(new Error('outbound_budget_deferred'),{retrySafe:true})}
    budget.calls++
   }
   const r=await fetch(input,{...init,redirect:'manual'});if(r.status>=300&&r.status<400){await r.body?.cancel();throw new Error('unexpected_upstream_redirect')};return r
  }}
 }
 serial(fn){const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p}
 invalidate(){this.epoch++;this.coreJob=null;this.window?.controller.abort()}
 async core(){if(!this.coreJob)this.coreJob=createEngine(this.runtimeEnv).catch(e=>{this.coreJob=null;throw e});return this.coreJob}
 async fetch(req){return this.serial(async()=>{try{return await this.handle(req)}catch(e){if(!e.status||e.storageFailure)this.invalidate();console.error('[alerts] operation failed; credentials/payload omitted');return json(e.status||503,{error:e.status?e.message:'service_or_storage_unavailable'})}})}
 async handle(req){
  const p=new URL(req.url).pathname,env=this.env,storage=this.ctx.storage
  if(p==='/internal/recover'){
   if(await storage.get('enabled')&&!this.window&&await storage.getAlarm()===null)await storage.setAlarm(Date.now()+1000)
   return json(200,{ok:true})
  }
  if(p==='/health'){
   const absent=missing(env);if(absent.length)return json(503,{ok:false,error:'configuration_incomplete',missing:absent})
   if(!this.local.initialized())return json(503,{ok:false,error:'storage_not_initialized',runtime:'cloudflare',storage:'sqlite',enabled:false})
   const core=await this.core();await core.inspect()
   return json(200,{ok:true,runtime:'cloudflare',storage:'sqlite',quoteMode:'stream',displayIntervalMs:1000,enabled:!!await storage.get('enabled'),schedulerActive:!!this.window,windowOutboundRequests:this.window?.calls||0,lastSchedulerRun:this.lastSchedulerRun,feed:core.feedStatus()})
  }
  if(p.startsWith('/admin/')){
   if(req.method!=='POST')return json(405,{error:'method_not_allowed'})
   if(!secretOK(req,env,'x-setup-secret'))return json(403,{error:'forbidden'})
   if(p==='/admin/stop'){this.enabled=false;await storage.put('enabled',false);this.window?.controller.abort();await storage.deleteAlarm();return json(200,{ok:true,stopped:true})}
   const absent=missing(env);if(absent.length)return json(503,{error:'configuration_incomplete',missing:absent})
   if(!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET))return json(503,{error:'webhook_secret_format_invalid'})
   const me=(await tg(env,'getMe',{})).result
   if(me.username==='verifycapp')return json(409,{error:'this_is_the_access_bot_use_the_alerts_bot_token'})
   if(p==='/admin/inspect')return json(200,{ok:true,bot:me.username,initialized:this.local.initialized(),data:this.local.initialized()?await(await this.core()).inspect():null,enabled:!!await storage.get('enabled'),quoteMode:'stream',storage:'sqlite'})
   if(p==='/admin/export'){if(!this.local.initialized())return json(409,{error:'storage_not_initialized'});return json(200,{ok:true,snapshot:this.local.exportSnapshot()})}
   if(p==='/admin/initialize'){
    const b=await data(req,1500000)
    if(b.confirm!=='INITIALIZE_ALERTS_SQLITE')return json(400,{error:'explicit_initialization_confirmation_required'})
    if(!b.snapshot&&b.startEmpty!==true)return json(400,{error:'choose_import_or_confirm_empty_database'})
    let counts;try{counts=this.local.initialize(b.snapshot||{main:emptyMain()})}catch(e){if(e.message.startsWith('invalid_import'))e.status=400;throw e};this.invalidate();return json(200,{ok:true,data:counts})
   }
   if(p!=='/admin/activate')return json(404,{error:'not_found'})
   if(!this.local.initialized())return json(409,{error:'initialize_or_import_database_first'})
   const b=await data(req);if(b.confirmBot!==me.username)return json(400,{error:'confirm_bot_identity_first'})
   const app=new URL(env.WEBAPP_URL||new URL(req.url).origin);if(app.protocol!=='https:')return json(400,{error:'https_required'})
   await(await this.core()).inspect();await(await this.core()).probe()
   await tg(env,'setChatMenuButton',{menu_button:{type:'web_app',text:'Open Alerts',web_app:{url:app.origin}}})
   await tg(env,'setMyCommands',{commands:[{command:'start',description:'Open Alerts'},{command:'alerts',description:'My active alerts'},{command:'quotes',description:'Add a quote'}]})
   await tg(env,'setWebhook',{url:app.origin+'/telegram/webhook',secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false})
   const info=(await tg(env,'getWebhookInfo',{})).result;if(info.url!==app.origin+'/telegram/webhook')return json(503,{error:'webhook_not_confirmed'})
   await storage.put('enabled',true);this.enabled=true;if(!this.window)await storage.setAlarm(Date.now()+1000)
   return json(200,{ok:true,bot:me.username,webhook:info.url,quoteMode:'stream'})
  }
  if(p==='/telegram/webhook'){
   if(req.method!=='POST')return json(405,{error:'method_not_allowed'})
   if(!secretOK(req,env,'x-telegram-bot-api-secret-token'))return json(403,{error:'forbidden'})
   if(!await storage.get('enabled'))return json(503,{error:'not_activated'})
   const u=await data(req);if(!Number.isSafeInteger(u.update_id))return json(400,{error:'invalid_update'})
   const uid=String(u.callback_query?.from?.id||u.message?.from?.id||''),allowed=new Set(String(env.ALLOWED_TELEGRAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))
   if(allowed.size&&!allowed.has(uid))return json(200,{ok:true})
   const key='update:'+u.update_id;if((await storage.get(key))?.status==='done')return json(200,{ok:true})
   await storage.put(key,{status:'processing',at:Date.now()})
   try{await(await this.core()).update(u);await storage.put(key,{status:'done',at:Date.now()})}catch(e){await storage.delete(key);throw e}
   return json(200,{ok:true})
  }
  if(p.startsWith('/api/')){
   if(!await storage.get('enabled'))return json(503,{error:'not_activated'})
   if(!['GET','HEAD'].includes(req.method)){const b=await data(req);req=new Request(req,{body:JSON.stringify(b)})}
   const token=verifyAccessToken(req.headers.get('x-access-token'),'alerts',env.ACCESS_SIGNING_SECRET),allowed=new Set(String(env.ALLOWED_TELEGRAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))
   if(token&&allowed.size&&!allowed.has(String(token.sub)))return json(403,{error:'user_not_allowed'})
   return(await this.core()).http(req)
  }
  return json(404,{error:'not_found'})
 }
 async alarm(){
  if(this.window)return
  const controller=new AbortController(),epoch=this.epoch,budget={controller,calls:0};this.window=budget
  return this.context.run(budget,async()=>{
   let timer,failed=false
   const dispatch=fn=>this.serial(async()=>{if(controller.signal.aborted||epoch!==this.epoch||!this.enabled)throw abortError();return fn()})
   try{
    this.enabled=!!await this.ctx.storage.get('enabled');if(!this.enabled||missing(this.env).length||!this.local.initialized())return
    const seconds=Math.max(1,Math.min(540,Number(this.env.STREAM_WINDOW_SECONDS)||540))
    await this.ctx.storage.setAlarm(Date.now()+(seconds+30)*1000) // crash watchdog; replaced on clean exit
    const core=await this.core();this.lastSchedulerRun=Date.now();timer=setTimeout(()=>controller.abort(),seconds*1000)
    const stream=core.stream(controller.signal,dispatch)
    const reminders=(async()=>{while(!controller.signal.aborted){try{await dispatch(()=>core.housekeeping())}catch(e){if(e.storageFailure)throw e;if(!e.retrySafe&&e.name!=='AbortError')throw e};await sleep(10000,controller.signal)}})()
    const capital=(async()=>{while(!controller.signal.aborted){try{await dispatch(()=>core.capital())}catch(e){if(e.storageFailure)throw e};await sleep(1500,controller.signal)}})()
    const fail=p=>p.catch(e=>{controller.abort();throw e})
    const result=await Promise.allSettled([fail(stream),fail(reminders),fail(capital)])
    if(result.some(r=>r.status==='rejected'&&r.reason?.storageFailure)){failed=true;this.invalidate()}
    if(Date.now()-(await this.ctx.storage.get('lastCleanup')||0)>3600000){
     this.local.cleanup();const entries=await this.ctx.storage.list({prefix:'update:',limit:5000}),expired=[...entries].filter(([,v])=>Date.now()-v.at>7*86400000).map(([k])=>k)
     if(expired.length)await this.ctx.storage.delete(expired);await this.ctx.storage.put('lastCleanup',Date.now())
    }
   }catch{failed=true;this.invalidate();console.error('[alerts] stream window failed; will reconnect with backoff')}
   finally{
    clearTimeout(timer);controller.abort();this.window=null
    const previous=Number(await this.ctx.storage.get('streamFailures')||0),failures=failed?previous+1:0
    if(failures!==previous)await this.ctx.storage.put('streamFailures',failures)
    const delay=failed?Math.min(300000,1000*2**Math.min(failures,8)):100
    if(await this.ctx.storage.get('enabled')&&!missing(this.env).length&&this.local.initialized())await this.ctx.storage.setAlarm(Date.now()+delay)
   }
  })
 }
}
function stub(env){return env.ALERTS.get(env.ALERTS.idFromName('production'))}
const SETUP=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение Alerts</title><style>body{max-width:720px;margin:40px auto;padding:20px;background:#191919;color:#eee;font:16px system-ui;line-height:1.6}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}input[type=checkbox]{width:auto}</style><h1>Подключение TG Alerts</h1><p>Access не меняется. Старый Render Alerts должен оставаться остановленным. Уровни проверяются по потоку OANDA независимо от открытой мини-апп; экран обновляется раз в секунду. У брокера, сети и Telegram возможны задержки и сбои.</p><form id="check"><label>TELEGRAM_WEBHOOK_SECRET именно Alerts<input id="secret" type="password" minlength="32" maxlength="256" autocomplete="off" required></label><button>1. Проверить бота и данные</button></form><pre id="result"></pre><section id="initial" hidden><p><b>В Cloudflare пока нет сохранённых данных Alerts.</b> Старые данные Render НЕ перенесены автоматически. Можно загрузить подготовленную резервную копию, либо явно начать с пустого списка. Ничего не будет перезаписано.</p><label>Резервная копия (JSON)<input id="backup" type="file" accept="application/json,.json"></label><button id="import">Импортировать выбранную копию</button><label><input id="emptyAck" type="checkbox"> Понимаю, что старые алерты, покупки и напоминания не появятся автоматически; согласен начать с пустой базы.</label><button id="empty">Создать пустую базу</button></section><section id="activateBox" hidden><p>Сверьте имя бота и количество данных выше. Следующий шаг переключит указанного настоящего бота на Cloudflare.</p><button id="activate">2. Подключить проверенного бота</button><button id="stop">Остановить фоновые проверки</button><button id="export">Скачать резервную копию</button></section><script>
const $=s=>document.querySelector(s);let bot='';async function call(path,b){const r=await fetch('/admin/'+path,{method:'POST',headers:{'content-type':'application/json','x-setup-secret':$('#secret').value},body:JSON.stringify(b||{})}),j=await r.json();if(!r.ok)throw new Error(j.error+(j.missing?' — '+j.missing.join(', '):''));return j}async function inspect(){const j=await call('inspect');bot=j.bot;$('#result').textContent='Бот: @'+bot+'\\n'+(j.initialized?'Сохранённые данные: '+JSON.stringify(j.data):'База пока не создана.')+'\\nФоновые проверки: '+(j.enabled?'включены':'выключены');$('#initial').hidden=j.initialized;$('#activateBox').hidden=!j.initialized}async function run(fn){try{await fn()}catch(e){$('#result').textContent='Ошибка: '+e.message}}$('#check').onsubmit=e=>{e.preventDefault();run(inspect)};$('#import').onclick=()=>run(async()=>{const f=$('#backup').files[0];if(!f)throw new Error('Сначала выберите JSON-копию.');const snapshot=JSON.parse(await f.text());await call('initialize',{confirm:'INITIALIZE_ALERTS_SQLITE',snapshot});await inspect()});$('#empty').onclick=()=>run(async()=>{if(!$('#emptyAck').checked)throw new Error('Нужно явное согласие на пустую базу.');await call('initialize',{confirm:'INITIALIZE_ALERTS_SQLITE',startEmpty:true});await inspect()});$('#activate').onclick=()=>run(async()=>{if(!confirm('Переключить @'+bot+' на Cloudflare?'))return;const j=await call('activate',{confirmBot:bot});$('#result').textContent='Подключён @'+j.bot+'. Отправьте /start и откройте новую кнопку. Вход — по коду Alerts из Access.\\n'+j.webhook});$('#stop').onclick=()=>run(async()=>{await call('stop');await inspect()});$('#export').onclick=()=>run(async()=>{const j=await call('export'),u=URL.createObjectURL(new Blob([JSON.stringify(j.snapshot,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='tg-alerts-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)});
</script></html>`
async function handle(req,env){
  const p=new URL(req.url).pathname
  if(p==='/setup'||p==='/setup.html')return new Response(SETUP,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'}})
  if(p==='/health'||p.startsWith('/admin/')||p==='/telegram/webhook'||p.startsWith('/api/')){
    if(p.startsWith('/admin/')&&!secretOK(req,env,'x-setup-secret'))return json(403,{error:'forbidden'})
    if(p==='/telegram/webhook'&&!secretOK(req,env,'x-telegram-bot-api-secret-token'))return json(403,{error:'forbidden'})
    if(p==='/api/access/redeem'){
      if(req.method!=='POST')return json(405,{error:'method_not_allowed'})
      if(missing(env).length)return json(503,{error:'configuration_incomplete'})
      const b=await data(req)
      if(!/^\d{6}$/.test(String(b.code||'')))return json(400,{error:'invalid_code'})
      const url=new URL('/api/verify-code',env.AUTH_API_URL||'https://retocker-access.retocker.workers.dev')
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:'alerts',code:b.code}),signal:AbortSignal.timeout(10000)})
      const j=await r.json()
      if(j.token&&!verifyAccessToken(j.token,'alerts',env.ACCESS_SIGNING_SECRET))return json(503,{error:'access_signing_secret_mismatch'})
      return json(r.status,j)
    }
    return stub(env).fetch(req)
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'method_not_allowed'})
  const assetRequest=new Request(req);assetRequest.headers.delete('if-none-match');assetRequest.headers.delete('if-modified-since')
  const asset=await env.ASSETS.fetch(assetRequest),headers=new Headers(asset.headers)
  headers.set('referrer-policy','no-referrer');headers.set('cache-control','no-store')
  if((p==='/'||p==='/index.html')&&asset.ok&&req.method!=='HEAD'){
    headers.delete('content-length');headers.delete('content-encoding');headers.delete('etag');headers.delete('last-modified')
    let html=await asset.text()
    html=html.replace("renderTiles(); renderPrice(); renderChips(); requestAnimationFrame(frame)","cfg = await api('/api/config'); renderTiles(); renderPrice(); renderChips(); requestAnimationFrame(frame)")
    html=html.replace('if (shown[k] == null) continue','if (shown[k] == null || !cfg.symbols[k]) continue')
    html=html.replace("fetch(authApi.replace(/\\/$/, '') + '/api/verify-code'", "fetch('/api/access/redeem'")
    html=html.replace("setInterval(() => tick().catch(() => {}), 400)", "setInterval(() => {if (!document.hidden) tick().catch(() => {})}, 1000)")
    html=html.replace("sym + ' · live'", "sym + ' · streaming'")
    html=html.replace('<div class="psub" id="psub">&nbsp;</div>', '<div class="psub" id="psub">&nbsp;</div><p style="font-size:11px;color:#aaa;margin:-24px 0 24px">OANDA streaming quotes. Display refreshes every second. Broker and Telegram delays still apply.</p>')
    html=html.replace(/\/\/ smooth glide of displayed prices[\s\S]*?(?=async function tick\(\))/, `// Display actual snapshots only, never animated intermediate prices or stale quotes.
function frame() {
  for (const k in shown) if (!prices[k] || !cfg.symbols[k] || !prices[k].tradeable || Date.now() - prices[k].observedAt > 30000) delete shown[k]
  for (const k in prices) if (cfg.symbols[k] && prices[k].tradeable && Date.now() - prices[k].observedAt <= 30000) shown[k] = prices[k].price
  $('#price').textContent = fmt(sym, shown[sym])
  $('#psub').textContent = sym + (shown[sym] == null ? ' · waiting for fresh quote' : ' · streaming')
  document.querySelectorAll('.asset').forEach(t => { t.querySelector('span').textContent = fmt(t.dataset.s, shown[t.dataset.s]) })
  requestAnimationFrame(frame)
}

`)
    html=html.replace('Run <b>node server.js</b> in the project folder,<br>then open <b>http://localhost:3000</b>', 'Check /health and complete /setup.html before using Alerts. If setup is complete, retry shortly.')
    return new Response(html,{status:asset.status,headers})
  }
  return new Response(asset.body,{status:asset.status,headers})
}
export default {
 async fetch(req,env){try{return await handle(req,env)}catch(e){return json(e.status||503,{error:e.status?e.message:'service_unavailable'})}},
 async scheduled(_event,env,ctx){ctx.waitUntil(stub(env).fetch('https://internal/internal/recover'))},
}
