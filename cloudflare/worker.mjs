import { DurableObject } from 'cloudflare:workers'
import { timingSafeEqual } from 'node:crypto'
import { createEngine } from './core.mjs'
import { verifyAccessToken } from '../shared/access-token.mjs'
const equal=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y)}
const json=(status,value)=>Response.json(value,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}})
export function missing(env) {
  const keys=['BOT_TOKEN','ACCESS_SIGNING_SECRET','TELEGRAM_WEBHOOK_SECRET','OANDA_TOKEN','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'].filter(k=>!env[k])
  if(env.SNAPSHOT_QUOTES_APPROVED!=='true')keys.push('SNAPSHOT_QUOTES_APPROVED')
  if(env.PRICE_SOURCE!=='oanda')keys.push('PRICE_SOURCE_must_be_oanda')
  if(env.OANDA_SIDE && !['bid','ask','mid'].includes(env.OANDA_SIDE))keys.push('OANDA_SIDE_invalid')
  if(env.OANDA_ENV && !['practice','live'].includes(env.OANDA_ENV))keys.push('OANDA_ENV_invalid')
  return keys
}
async function data(req,max=12000) {
  let total=0;const chunks=[],reader=req.body?.getReader()
  if(!reader)return {}
  for(;;){const x=await reader.read();if(x.done)break;total+=x.value.byteLength;if(total>max){await reader.cancel();const e=new Error('body_too_large');e.status=413;throw e}chunks.push(x.value)}
  try{const v=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!v||Array.isArray(v)||typeof v!=='object')throw new Error();return v}catch{const e=new Error('invalid_json');e.status=400;throw e}
}
async function tg(env,method,payload) {
  const r=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)})
  const d=await r.json();if(!r.ok||!d.ok)throw new Error('telegram_request_failed');return d
}
const secretOK=(req,env,header)=>!!env.TELEGRAM_WEBHOOK_SECRET&&equal(req.headers.get(header),env.TELEGRAM_WEBHOOK_SECRET)
export class AlertsEngine extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.tail=Promise.resolve();this.coreJob=null}
  async core(){if(!this.coreJob)this.coreJob=createEngine(this.env).catch(e=>{this.coreJob=null;throw e});return this.coreJob}
  serial(fn){const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next}
  async fetch(req){return this.serial(async()=>{
    try{return await this.handle(req)}catch(e){this.coreJob=null;console.error('[alerts] operation failed; credentials and payload omitted');return json(e.status||503,{error:e.status?e.message:'service_or_storage_unavailable'})}
  })}
  async handle(req){
    const p=new URL(req.url).pathname,env=this.env,storage=this.ctx.storage
    if(p==='/internal/recover'){
      if(await storage.get('enabled')&&await storage.getAlarm()===null)await storage.setAlarm(Date.now()+1000)
      return json(200,{ok:true})
    }
    if(p==='/health'){
      const absent=missing(env);if(absent.length)return json(503,{ok:false,error:'configuration_incomplete',missing:absent})
      await (await this.core()).inspect()
      return json(200,{ok:true,runtime:'cloudflare',quoteMode:'snapshot',checkIntervalMs:10000,enabled:!!await storage.get('enabled'),lastSchedulerRun:await storage.get('lastSchedulerRun')||null})
    }
    if(p.startsWith('/admin/')){
      if(req.method!=='POST')return json(405,{error:'method_not_allowed'})
      if(!secretOK(req,env,'x-setup-secret'))return json(403,{error:'forbidden'})
      if(p==='/admin/stop'){await storage.put('enabled',false);await storage.deleteAlarm();return json(200,{ok:true,stopped:true})}
      const absent=missing(env);if(absent.length)return json(503,{error:'configuration_incomplete',missing:absent})
      if(!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET))return json(503,{error:'webhook_secret_format_invalid'})
      const me=(await tg(env,'getMe',{})).result
      // Known Access bot must never accidentally be re-pointed to Alerts.
      if(me.username==='verifycapp')return json(409,{error:'this_is_the_access_bot_use_the_alerts_bot_token'})
      const core=await this.core()
      if(p==='/admin/inspect')return json(200,{ok:true,bot:me.username,data:await core.inspect(),quoteMode:'snapshot',checkIntervalMs:10000,enabled:!!await storage.get('enabled')})
      if(p!=='/admin/activate')return json(404,{error:'not_found'})
      const b=await data(req)
      if(b.confirmBot!==me.username||b.acceptSnapshots!==true)return json(400,{error:'confirm_bot_and_accept_snapshot_mode_first'})
      const app=env.WEBAPP_URL||new URL(req.url).origin
      const appURL=new URL(app);if(appURL.protocol!=='https:')return json(400,{error:'https_required'})
      await tg(env,'setChatMenuButton',{menu_button:{type:'web_app',text:'Open Alerts',web_app:{url:appURL.origin}}})
      await tg(env,'setMyCommands',{commands:[{command:'start',description:'Open Alerts'},{command:'alerts',description:'My active alerts'},{command:'quotes',description:'Add a quote'}]})
      await tg(env,'setWebhook',{url:appURL.origin+'/telegram/webhook',secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false})
      const info=(await tg(env,'getWebhookInfo',{})).result
      if(info.url!==appURL.origin+'/telegram/webhook')return json(503,{error:'webhook_not_confirmed'})
      await storage.put('enabled',true);await storage.setAlarm(Date.now()+1000)
      return json(200,{ok:true,bot:me.username,webhook:info.url,quoteMode:'snapshot',checkIntervalMs:10000})
    }
    if(p==='/telegram/webhook'){
      if(req.method!=='POST')return json(405,{error:'method_not_allowed'})
      if(!secretOK(req,env,'x-telegram-bot-api-secret-token'))return json(403,{error:'forbidden'})
      if(!await storage.get('enabled'))return json(503,{error:'not_activated'})
      const u=await data(req)
      if(!Number.isSafeInteger(u.update_id))return json(400,{error:'invalid_update'})
      const uid=String(u.callback_query?.from?.id||u.message?.from?.id||'')
      const allowed=new Set(String(env.ALLOWED_TELEGRAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))
      if(allowed.size&&!allowed.has(uid))return json(200,{ok:true})
      const now=Date.now(),key='update:'+u.update_id,existing=await storage.get(key)
      if(existing?.status==='done')return json(200,{ok:true})
      await storage.put(key,{status:'processing',at:now})
      try {await (await this.core()).update(u);await storage.put(key,{status:'done',at:now})}
      catch(e){await storage.delete(key);throw e}
      return json(200,{ok:true})
    }
    if(p.startsWith('/api/')){
      if(!await storage.get('enabled'))return json(503,{error:'not_activated'})
      if(req.method!=='GET'&&req.method!=='HEAD'){
        const b=await data(req);req=new Request(req,{body:JSON.stringify(b)})
      }
      const token=verifyAccessToken(req.headers.get('x-access-token'),'alerts',env.ACCESS_SIGNING_SECRET)
      const allowed=new Set(String(env.ALLOWED_TELEGRAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))
      if(token && allowed.size&&!allowed.has(String(token.sub)))return json(403,{error:'user_not_allowed'})
      return (await this.core()).http(req)
    }
    return json(404,{error:'not_found'})
  }
  async alarm(){return this.serial(async()=>{
    if(!await this.ctx.storage.get('enabled'))return
    if(missing(this.env).length){await this.ctx.storage.put('enabled',false);await this.ctx.storage.deleteAlarm();return}
    try {await (await this.core()).tick();await this.ctx.storage.put('lastSchedulerRun',Date.now())}
    catch {this.coreJob=null;console.error('[alerts] scheduler failed; will retry without empty-state fallback')}
    finally {if(await this.ctx.storage.get('enabled'))await this.ctx.storage.setAlarm(Date.now()+10000)}
    if(Date.now()-(await this.ctx.storage.get('lastCleanup')||0)>3600000){
      const entries=await this.ctx.storage.list({prefix:'update:',limit:5000})
      const expired=[...entries].filter(([,v])=>Date.now()-v.at>7*86400000).map(([k])=>k)
      if(expired.length)await this.ctx.storage.delete(expired)
      await this.ctx.storage.put('lastCleanup',Date.now())
    }
  })}
}
function stub(env){return env.ALERTS.get(env.ALERTS.idFromName('production'))}
const SETUP=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение TG Alerts</title><style>body{max-width:700px;margin:50px auto;padding:20px;background:#191919;color:#eee;font:16px system-ui;line-height:1.6}input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}input[type=checkbox]{width:auto}</style><h1>Подключение TG Alerts</h1><p>Это отдельный бот, НЕ Retocker Access. Render Alerts должен оставаться остановленным. Рабочий Access не изменяется.</p><p><b>Внимание:</b> эта версия проверяет котировки примерно раз в 10 секунд, НЕ получает все тики. Краткое касание уровня между проверками может быть пропущено. Доставка не гарантируется к точной секунде.</p><form id="form"><label>Новый TELEGRAM_WEBHOOK_SECRET именно для Alerts<input id="secret" type="password" autocomplete="off" minlength="32" maxlength="256" required></label><button>1. Проверить бота и сохранённые данные</button></form><pre id="result"></pre><div id="confirmation" hidden><label><input id="ack" type="checkbox"> Согласен на снимки котировок примерно раз в 10 секунд и риск пропуска кратких касаний.</label><button id="activate">2. Подключить указанного бота и включить проверки</button></div><script>
let checkedBot='';const $=s=>document.querySelector(s);$('#form').onsubmit=async e=>{e.preventDefault();$('#confirmation').hidden=true;try{const r=await fetch('/admin/inspect',{method:'POST',headers:{'x-setup-secret':$('#secret').value}}),j=await r.json();if(!r.ok)throw new Error(j.error+(j.missing?' — '+j.missing.join(', '):''));checkedBot=j.bot;$('#result').textContent='Бот: @'+j.bot+'\\nСохранённые данные: '+JSON.stringify(j.data)+'\\nПроверьте, что это именно бот Alerts.';$('#confirmation').hidden=false}catch(e){$('#result').textContent='Ошибка: '+e.message}};$('#activate').onclick=async()=>{if(!$('#ack').checked)return alert('Нужно согласие на режим снимков.');if(!confirm('Подключить @'+checkedBot+' к Cloudflare и включить реальные уведомления?'))return;$('#activate').disabled=true;try{const r=await fetch('/admin/activate',{method:'POST',headers:{'content-type':'application/json','x-setup-secret':$('#secret').value},body:JSON.stringify({confirmBot:checkedBot,acceptSnapshots:true})}),j=await r.json();if(!r.ok)throw new Error(j.error);$('#result').textContent='Готово. @'+j.bot+'\\n'+j.webhook+'\\nОтправьте /start, откройте свежую кнопку и войдите с кодом из Access.';$('#secret').value='';$('#confirmation').hidden=true}catch(e){$('#result').textContent='Ошибка: '+e.message}finally{$('#activate').disabled=false}};
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
  const asset=await env.ASSETS.fetch(req),headers=new Headers(asset.headers)
  headers.set('referrer-policy','no-referrer');headers.set('cache-control','no-store')
  if((p==='/'||p==='/index.html')&&asset.ok&&req.method!=='HEAD'){
    let html=await asset.text()
    html=html.replace("renderTiles(); renderPrice(); renderChips(); requestAnimationFrame(frame)","cfg = await api('/api/config'); renderTiles(); renderPrice(); renderChips(); requestAnimationFrame(frame)")
    html=html.replace('if (shown[k] == null) continue','if (shown[k] == null || !cfg.symbols[k]) continue')
    html=html.replace("fetch(authApi.replace(/\\/$/, '') + '/api/verify-code'", "fetch('/api/access/redeem'")
    html=html.replace("setInterval(() => tick().catch(() => {}), 400)", "setInterval(() => {if (!document.hidden) tick().catch(() => {})}, 5000)")
    html=html.replace("sym + ' · live'", "sym + ' · snapshots ~10s'")
    html=html.replace('<div class="psub" id="psub">&nbsp;</div>', '<div class="psub" id="psub">&nbsp;</div><p style="font-size:11px;color:#aaa;margin:-24px 0 24px">Snapshots about every 10 seconds. Brief level crossings may be missed. Not guaranteed real-time delivery.</p>')
    html=html.replace(/\/\/ smooth glide of displayed prices[\s\S]*?(?=async function tick\(\))/, `// Display actual snapshots only, never animated intermediate prices or stale quotes.
function frame() {
  for (const k in shown) if (!prices[k] || !cfg.symbols[k] || !prices[k].tradeable || Date.now() - prices[k].observedAt > 30000) delete shown[k]
  for (const k in prices) if (cfg.symbols[k] && prices[k].tradeable && Date.now() - prices[k].observedAt <= 30000) shown[k] = prices[k].price
  $('#price').textContent = fmt(sym, shown[sym])
  $('#psub').textContent = sym + (shown[sym] == null ? ' · waiting for fresh quote' : ' · snapshots ~10s')
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
