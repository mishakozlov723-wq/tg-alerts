// OANDA stream with bounded REST reconciliation and a periodic display cache.
// Cached prices never dispatch alert ticks or acquire new timestamps on restore.
export function dxyFormula(q) {
 return 50.14348112*q.EUR_USD**-.576*q.USD_JPY**.136*q.GBP_USD**-.119*q.USD_CAD**.091*q.USD_SEK**.042*q.USD_CHF**.036
}
const PAIRS=['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF']
const stopped=()=>Object.assign(new Error('stream_stopped'),{name:'AbortError'})
function pause(ms,signal){return new Promise((resolve,reject)=>{if(signal.aborted)return reject(stopped());const finish=()=>{signal.removeEventListener('abort',cancel);resolve()},timer=setTimeout(finish,ms),cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(stopped())};signal.addEventListener('abort',cancel,{once:true})})}
export function createQuoteFeed(env){
 const fetch=env.FETCH||globalThis.fetch
 const SYMBOLS={
  EURUSD:{pip:.0001,digits:5,oanda:'EUR_USD'},GBPUSD:{pip:.0001,digits:5,oanda:'GBP_USD'},DXY:{pip:.01,digits:3,premium:true},
  XAUUSD:{label:'Gold',premium:true,pip:.1,digits:2,oanda:env.OANDA_XAUUSD||'XAU_USD',capital:env.CAPITAL_EPIC_XAUUSD||'GOLD',offset:Number(env.OFFSET_XAUUSD||0)},
  GER40:{label:'GER40',premium:true,pip:1,digits:1,oanda:env.OANDA_GER40||'DE30_EUR',capital:env.CAPITAL_EPIC_GER40||'DE40',offset:Number(env.OFFSET_GER40||0)},
  XAGUSD:{label:'Silver',premium:true,pip:.01,digits:3,capital:env.CAPITAL_EPIC_XAGUSD||'SILVER',offset:Number(env.OFFSET_XAGUSD||0)},
 }
 const prices={},feedStatus={missing:['XAUUSD','GER40','XAGUSD']},trade={},errors={},mids={},times={}
 const capOn=!!(env.CAPITAL_API_KEY&&env.CAPITAL_IDENTIFIER&&env.CAPITAL_PASSWORD)
 // Public health diagnostics: fixed metadata and validated provider error codes only.
 // Never expose response bodies, exception messages, credentials or session headers.
 const capitalDiagnostics={version:1,configured:capOn,environment:env.CAPITAL_ENV==='live'?'live':'demo',stage:capOn?'not_attempted':'unconfigured',httpStatus:null,errorCode:null,lastAttemptAt:null,lastSuccessAt:null}
 async function capitalHttpError(response,stage){
  let code=null
  try{
   const raw=(await response.json())?.errorCode
   const secrets=[env.CAPITAL_API_KEY,env.CAPITAL_IDENTIFIER,env.CAPITAL_PASSWORD,cst,sec].filter(v=>typeof v==='string'&&v.length)
   if(typeof raw==='string'&&/^error\.[a-z0-9_.-]{1,100}$/i.test(raw)&&!secrets.some(v=>raw.includes(v)))code=raw
  }catch{}
  capitalDiagnostics.stage=stage;capitalDiagnostics.httpStatus=response.status;capitalDiagnostics.errorCode=code||'http_error'
  return new Error('Capital_request_failed')
 }
 const host=env.OANDA_ENV==='live'?'https://api-fxtrade.oanda.com':'https://api-fxpractice.oanda.com'
 const streamHost=env.OANDA_ENV==='live'?'https://stream-fxtrade.oanda.com':'https://stream-fxpractice.oanda.com'
 let account=env.OANDA_ACCOUNT,discovered=false,extra=[],cst='',sec='',loginAt=0,capNext=0,capFails=0,lastMessage=0,connected=false,source='unavailable'
 let revision=0,savedRevision=0,nextRefresh=0
 const identity=JSON.stringify([env.OANDA_ENV||'practice',env.OANDA_ACCOUNT||'',env.OANDA_SIDE||'bid',capOn,env.CAPITAL_ENV||'demo',env.CAPITAL_SIDE||'mid',SYMBOLS])
 const fresh=s=>trade[s]===true&&!!prices[s]&&Date.now()-prices[s].observedAt<30000&&Date.now()-prices[s].dataTs<=30000
 function restore(raw){
  try{
   const v=JSON.parse(raw);if(v.version!==1||v.identity!==identity)return
   const valid=q=>q&&Number.isFinite(q.price)&&q.price>0&&Number.isFinite(q.dataTs)&&Number.isFinite(q.observedAt)&&q.dataTs<=Date.now()+60000&&q.observedAt<=Date.now()+60000
   for(const [s,q]of Object.entries(v.prices||{}))if(SYMBOLS[s]&&valid(q)){prices[s]={...q};trade[s]=false}
   for(const s of PAIRS)if(Number.isFinite(v.mids?.[s])&&v.mids[s]>0&&Number.isFinite(v.times?.[s])){mids[s]=v.mids[s];times[s]=v.times[s];trade[s]=false}
  }catch{} // Optional cache corruption must not replace business data.
 }
 async function checkpoint(store){if(revision===savedRevision)return;const n=revision;await store(['SET','tg-alerts:quotes:v1',JSON.stringify({version:1,identity,prices,mids,times})]);savedRevision=n}
 const unavailable=(symbols,list)=>{feedStatus.missing=[...new Set([...feedStatus.missing.filter(s=>!symbols.includes(s)),...list])]}
 const stamp=raw=>typeof raw==='string'&&/^\d+(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)
 const marketOpen=()=>{const d=new Date(Date.now()),day=d.getUTCDay(),h=d.getUTCHours();return day!==6&&!(day===5&&h>=21)&&!(day===0&&h<22)}
 async function get(path){const r=await fetch(host+path,{headers:{authorization:`Bearer ${env.OANDA_TOKEN}`,'accept-datetime-format':'UNIX'},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('OANDA_request_failed');return r.json()}
 async function discover(){
  if(!env.OANDA_TOKEN)throw new Error('OANDA_token_missing')
  if(!account){const d=await get('/v3/accounts');account=d.accounts?.[0]?.id;if(!account)throw new Error('OANDA_account_missing')}
  if(discovered)return
  if(!capOn){const d=await get(`/v3/accounts/${encodeURIComponent(account)}/instruments`),names=new Set((d.instruments||[]).map(x=>x.name)),wanted=Object.entries(SYMBOLS).filter(([,c])=>c.premium&&c.oanda);extra=wanted.filter(([,c])=>names.has(c.oanda)).map(([,c])=>c.oanda);unavailable(wanted.map(([s])=>s),wanted.filter(([,c])=>!names.has(c.oanda)).map(([s])=>s))}
  discovered=true
 }
 async function setPrice(sym,value,onTick,meta={}){
  if(!SYMBOLS[sym]||!Number.isFinite(value)||value<=0)return
  const now=Date.now();prices[sym]={price:Number(value.toFixed(SYMBOLS[sym].digits)),ts:now,observedAt:now,...meta};revision++
  if(onTick)await onTick(sym,prices[sym].price)
 }
 async function ingest(p,onTick){
  const bid=Number(p.bids?.[0]?.price??p.closeoutBid),ask=Number(p.asks?.[0]?.price??p.closeoutAsk),dataTs=stamp(p.time)
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<=0||!Number.isFinite(dataTs)||dataTs>Date.now()+60000||dataTs<(times[p.instrument]||0))return
  const valid=p.tradeable===true&&Date.now()-dataTs<=30000&&dataTs<=Date.now()+60000
  times[p.instrument]=dataTs
  if(PAIRS.includes(p.instrument)){mids[p.instrument]=(bid+ask)/2;trade[p.instrument]=valid}
  const item=Object.entries(SYMBOLS).find(([,c])=>c.oanda===p.instrument)
  if(item&&!(item[1].premium&&capOn)){
   const [s,c]=item;trade[s]=valid;const side=env.OANDA_SIDE||'bid',v=side==='ask'?ask:side==='mid'?(bid+ask)/2:bid
   await setPrice(s,v+(c.offset||0),valid?onTick:null,{dataTs,tradeable:valid,spreadPips:(ask-bid)/c.pip})
  }
  if(PAIRS.includes(p.instrument)&&PAIRS.every(s=>Number.isFinite(mids[s]))){
   const oldest=Math.min(...PAIRS.map(s=>times[s]));trade.DXY=PAIRS.every(s=>trade[s])&&Date.now()-oldest<=30000
   await setPrice('DXY',dxyFormula(mids),trade.DXY?onTick:null,{dataTs:oldest,tradeable:trade.DXY})
  }
 }
 async function pull(onTick,dispatch){
  await discover();const d=await get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent([...PAIRS,...extra].join(','))}`)
  for(const p of d.prices||[])await dispatch(()=>ingest(p,onTick))
 }
 async function refresh(onTick,dispatch=fn=>fn()){
  if(Date.now()<nextRefresh)return
  // Reconcile even a healthy heartbeat-only stream. One request per 20s at most.
  nextRefresh=Date.now()+20000
  try{await pull(onTick,dispatch);errors.oanda=null;if(!connected)source='polling_fallback'}catch(e){if(e.storageFailure||e.retrySafe)throw e;errors.oanda='OANDA_feed_unavailable'}
 }
 async function stream(onTick,signal,dispatch=fn=>fn()){
  await refresh(onTick,dispatch)
  while(!signal.aborted){
   let reader,timer,cancelRead;const controller=new AbortController()
   const stop=()=>controller.abort();signal.addEventListener('abort',stop,{once:true})
   const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),15000)}
   try{
    await discover();if(signal.aborted)break
    const q=encodeURIComponent([...PAIRS,...extra].join(','));arm()
    const r=await fetch(`${streamHost}/v3/accounts/${encodeURIComponent(account)}/pricing/stream?instruments=${q}`,{headers:{authorization:`Bearer ${env.OANDA_TOKEN}`,'accept-datetime-format':'UNIX'},signal:controller.signal})
    if(!r.ok||!r.body)throw new Error('OANDA_stream_unavailable')
    reader=r.body.getReader();const decoder=new TextDecoder();let buffer='';connected=true;source='stream';errors.oanda=null
    const aborted=new Promise((_,reject)=>{cancelRead=()=>reject(stopped());controller.signal.addEventListener('abort',cancelRead,{once:true});if(controller.signal.aborted)cancelRead()})
    // Mark rejection observed even when another awaited operation is still completing.
    aborted.catch(()=>{})
    while(!signal.aborted){
     const {value,done}=await Promise.race([reader.read(),aborted]);if(done)throw new Error('OANDA_stream_closed')
     arm();lastMessage=Date.now();buffer+=decoder.decode(value,{stream:true});if(buffer.length>1048576)throw new Error('OANDA_stream_frame_too_large')
     let i
     while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue};if(m.type==='PRICE')await dispatch(()=>ingest(m,onTick))}
    }
   }catch(e){
    if(e.storageFailure)throw e
    if(signal.aborted)break
    errors.oanda='OANDA_stream_interrupted';source='polling_fallback';connected=false
    await refresh(onTick,dispatch)
    if(!signal.aborted)await pause(1000,signal).catch(()=>{})
   }finally{connected=false;clearTimeout(timer);signal.removeEventListener('abort',stop);if(cancelRead)controller.signal.removeEventListener('abort',cancelRead);controller.abort();if(reader)await reader.cancel().catch(()=>{})}
  }
 }
  async function pollCapital(onTick, dispatch=fn=>fn()) {
    if(!capOn || Date.now()<capNext)return
    const base=env.CAPITAL_ENV==='live'?'https://api-capital.backend-capital.com':'https://demo-api-capital.backend-capital.com'
    capitalDiagnostics.lastAttemptAt=Date.now();capitalDiagnostics.httpStatus=null;capitalDiagnostics.errorCode=null
    try {
      if(!cst || Date.now()-loginAt>8*60000) {
        capitalDiagnostics.stage='login'
        const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{'X-CAP-API-KEY':env.CAPITAL_API_KEY,'content-type':'application/json'},body:JSON.stringify({identifier:env.CAPITAL_IDENTIFIER,password:env.CAPITAL_PASSWORD,encryptedPassword:false}),signal:AbortSignal.timeout(8000)})
        capitalDiagnostics.httpStatus=r.status
        if(!r.ok)throw await capitalHttpError(r,'login')
        cst=r.headers.get('cst')||'';sec=r.headers.get('x-security-token')||'';loginAt=Date.now()
        if(!cst||!sec){capitalDiagnostics.errorCode='session_headers_missing';throw new Error('Capital session unavailable')}
      }
      const items=Object.entries(SYMBOLS).filter(([,c])=>c.capital)
      capitalDiagnostics.stage='markets';capitalDiagnostics.httpStatus=null
      const r=await fetch(base+'/api/v1/markets?epics='+encodeURIComponent(items.map(([,c])=>c.capital).join(',')),{headers:{CST:cst,'X-SECURITY-TOKEN':sec},signal:AbortSignal.timeout(8000)})
      capitalDiagnostics.httpStatus=r.status
      if(r.status===401)cst=''
      if(!r.ok)throw await capitalHttpError(r,'markets')
      capitalDiagnostics.stage='decode_markets'
      const d=await r.json(),seen=[]
      capitalDiagnostics.stage='process_markets'
      for(const m of d.marketDetails||[]) {
        const item=items.find(([,c])=>c.capital===(m.instrument?.epic||m.epic));if(!item)continue
        const [s,c]=item,bid=Number(m.snapshot?.bid),ask=Number(m.snapshot?.offer)
        if(!Number.isFinite(bid)||!Number.isFinite(ask))continue
        const raw=m.snapshot.updateTimeUTC
        // Capital's UTC field has no offset. Never interpret it in the host timezone.
        const dataTs=typeof raw==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(raw)?Date.parse(raw.endsWith('Z')?raw:raw+'Z'):NaN
        seen.push(s)
        const side=env.CAPITAL_SIDE||'mid',v=side==='bid'?bid:side==='ask'?ask:(bid+ask)/2
        await dispatch(async()=>{
          if(!Number.isFinite(dataTs)||dataTs>Date.now()+60000){trade[s]=false;return}
          if(dataTs<(prices[s]?.dataTs||0))return
          const valid=m.snapshot.marketStatus==='TRADEABLE'&&Date.now()-dataTs<=30000
          trade[s]=valid
          await setPrice(s,v+(c.offset||0),valid?onTick:null,{dataTs,tradeable:valid})
        })
      }
      unavailable(items.map(([s])=>s),items.filter(([s])=>!seen.includes(s)).map(([s])=>s))
      capFails=0;errors.capital=null
      capitalDiagnostics.stage='ok';capitalDiagnostics.errorCode=null;capitalDiagnostics.lastSuccessAt=Date.now()
    } catch(e) {
      if(!capitalDiagnostics.errorCode)capitalDiagnostics.errorCode=e.retrySafe?'runtime_deferred':e.storageFailure?'storage_error':['TimeoutError','AbortError'].includes(e.name)?'request_aborted_or_timeout':capitalDiagnostics.stage==='decode_markets'?'invalid_json':capitalDiagnostics.stage==='process_markets'?'processing_error':'network_or_runtime_error'
      capFails++;capNext=Date.now()+Math.min(300000,10000*2**Math.min(capFails,5));errors.capital='Capital feed unavailable';throw e }
  }
 return {SYMBOLS,prices,feedStatus,setPrice,stream,refresh,restore,checkpoint,capital:pollCapital,marketOpen,
  async probe(){await discover();const d=await get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent(PAIRS.join(','))}`);if(!Array.isArray(d.prices)||!['EUR_USD','GBP_USD'].every(s=>d.prices.some(p=>p.instrument===s)))throw new Error('broker_prices_unavailable');await pollCapital(null);if(capOn&&errors.capital)throw new Error('Capital_feed_unavailable');return {oanda:true,capital:capOn}},
  tradeable:s=>trade[s]===true,
  fresh,
  status:()=>({mode:'stream',source,connected,lastMessage,displayIntervalMs:1000,capitalIntervalMs:1500,pricing:{oandaEnvironment:env.OANDA_ENV||'practice',oandaSide:env.OANDA_SIDE||'bid',capitalSide:env.CAPITAL_SIDE||'mid',quotes:Object.fromEntries(['EURUSD','GBPUSD'].filter(s=>prices[s]).map(s=>[s,{receivedAgeMs:Date.now()-prices[s].observedAt,sourceAgeMs:Date.now()-prices[s].dataTs,spreadPips:Number(prices[s].spreadPips?.toFixed(3)),tradeable:prices[s].tradeable}]))},errors:{...errors},capitalDiagnostics:{...capitalDiagnostics,nextRetryAt:capNext,consecutiveFailures:capFails},tradeable:{...trade}}),
 }
}
