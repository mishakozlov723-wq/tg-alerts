// OANDA upstream HTTP stream; prices are memory-only. Never checkpoint each tick.
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
 const host=env.OANDA_ENV==='live'?'https://api-fxtrade.oanda.com':'https://api-fxpractice.oanda.com'
 const streamHost=env.OANDA_ENV==='live'?'https://stream-fxtrade.oanda.com':'https://stream-fxpractice.oanda.com'
 let account=env.OANDA_ACCOUNT,discovered=false,extra=[],cst='',sec='',loginAt=0,capNext=0,capFails=0,lastMessage=0,connected=false,source='unavailable'
 const unavailable=(symbols,list)=>{feedStatus.missing=[...new Set([...feedStatus.missing.filter(s=>!symbols.includes(s)),...list])]}
 const stamp=raw=>typeof raw==='string'&&/^\d+(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)
 const marketOpen=()=>{const d=new Date(),day=d.getUTCDay(),h=d.getUTCHours();return day!==6&&!(day===5&&h>=21)&&!(day===0&&h<22)}
 async function get(path){const r=await fetch(host+path,{headers:{authorization:`Bearer ${env.OANDA_TOKEN}`,'accept-datetime-format':'UNIX'},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('OANDA_request_failed');return r.json()}
 async function discover(){
  if(!env.OANDA_TOKEN)throw new Error('OANDA_token_missing')
  if(!account){const d=await get('/v3/accounts');account=d.accounts?.[0]?.id;if(!account)throw new Error('OANDA_account_missing')}
  if(discovered)return
  if(!capOn){const d=await get(`/v3/accounts/${encodeURIComponent(account)}/instruments`),names=new Set((d.instruments||[]).map(x=>x.name)),wanted=Object.entries(SYMBOLS).filter(([,c])=>c.premium&&c.oanda);extra=wanted.filter(([,c])=>names.has(c.oanda)).map(([,c])=>c.oanda);unavailable(wanted.map(([s])=>s),wanted.filter(([,c])=>!names.has(c.oanda)).map(([s])=>s))}
  discovered=true
 }
 async function setPrice(sym,value,onTick,meta={}){
  if(!SYMBOLS[sym]||!Number.isFinite(value))return
  const now=Date.now();prices[sym]={price:Number(value.toFixed(SYMBOLS[sym].digits)),ts:now,observedAt:now,...meta}
  if(onTick)await onTick(sym,prices[sym].price)
 }
 async function ingest(p,onTick){
  const bid=Number(p.bids?.[0]?.price??p.closeoutBid),ask=Number(p.asks?.[0]?.price??p.closeoutAsk),dataTs=stamp(p.time)
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||!Number.isFinite(dataTs)||dataTs<(times[p.instrument]||0))return
  const valid=p.tradeable===true&&Date.now()-dataTs<=30000&&dataTs<=Date.now()+60000
  times[p.instrument]=dataTs
  if(PAIRS.includes(p.instrument)){mids[p.instrument]=(bid+ask)/2;trade[p.instrument]=valid}
  const item=Object.entries(SYMBOLS).find(([,c])=>c.oanda===p.instrument)
  if(item&&!(item[1].premium&&capOn)){
   const [s,c]=item;trade[s]=valid;const side=env.OANDA_SIDE||'bid',v=side==='ask'?ask:side==='mid'?(bid+ask)/2:bid
   await setPrice(s,v+(c.offset||0),valid?onTick:null,{dataTs,tradeable:valid})
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
 async function stream(onTick,signal,dispatch=fn=>fn()){
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
    try{await pull(onTick,dispatch)}catch(x){if(x.storageFailure)throw x;errors.oanda='OANDA_feed_unavailable'}
    if(!signal.aborted)await pause(1000,signal).catch(()=>{})
   }finally{connected=false;clearTimeout(timer);signal.removeEventListener('abort',stop);if(cancelRead)controller.signal.removeEventListener('abort',cancelRead);controller.abort();if(reader)await reader.cancel().catch(()=>{})}
  }
 }
  async function pollCapital(onTick) {
    if(!capOn || Date.now()<capNext)return
    const base=env.CAPITAL_ENV==='live'?'https://api-capital.backend-capital.com':'https://demo-api-capital.backend-capital.com'
    try {
      if(!cst || Date.now()-loginAt>8*60000) {
        const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{'X-CAP-API-KEY':env.CAPITAL_API_KEY,'content-type':'application/json'},body:JSON.stringify({identifier:env.CAPITAL_IDENTIFIER,password:env.CAPITAL_PASSWORD,encryptedPassword:false}),signal:AbortSignal.timeout(8000)})
        if(!r.ok)throw new Error(`Capital login HTTP ${r.status}`)
        cst=r.headers.get('cst')||'';sec=r.headers.get('x-security-token')||'';loginAt=Date.now()
        if(!cst||!sec)throw new Error('Capital session unavailable')
      }
      const items=Object.entries(SYMBOLS).filter(([,c])=>c.capital)
      const r=await fetch(base+'/api/v1/markets?epics='+encodeURIComponent(items.map(([,c])=>c.capital).join(',')),{headers:{CST:cst,'X-SECURITY-TOKEN':sec},signal:AbortSignal.timeout(8000)})
      if(r.status===401)cst=''
      if(!r.ok)throw new Error(`Capital markets HTTP ${r.status}`)
      const d=await r.json(),seen=[]
      for(const m of d.marketDetails||[]) {
        const item=items.find(([,c])=>c.capital===(m.instrument?.epic||m.epic));if(!item)continue
        const [s,c]=item,bid=Number(m.snapshot?.bid),ask=Number(m.snapshot?.offer)
        if(!Number.isFinite(bid)||!Number.isFinite(ask))continue
        const valid=m.snapshot.marketStatus==='TRADEABLE';trade[s]=valid;seen.push(s)
        const side=env.CAPITAL_SIDE||'mid',v=side==='bid'?bid:side==='ask'?ask:(bid+ask)/2
        await setPrice(s,v+(c.offset||0),valid?onTick:null,{dataTs:Date.now(),tradeable:valid})
      }
      unavailable(items.map(([s])=>s),items.filter(([s])=>!seen.includes(s)).map(([s])=>s))
      capFails=0;errors.capital=null
    } catch(e) { capFails++;capNext=Date.now()+Math.min(300000,10000*2**Math.min(capFails,5));errors.capital='Capital feed unavailable';throw e }
  }
 return {SYMBOLS,prices,feedStatus,setPrice,stream,capital:pollCapital,marketOpen,
  async probe(){await discover();const d=await get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent(PAIRS.join(','))}`);if(!Array.isArray(d.prices)||!['EUR_USD','GBP_USD'].every(s=>d.prices.some(p=>p.instrument===s)))throw new Error('broker_prices_unavailable');await pollCapital(null);if(capOn&&errors.capital)throw new Error('Capital_feed_unavailable');return {oanda:true,capital:capOn}},
  tradeable:s=>trade[s]===true,
  fresh:s=>trade[s]===true&&!!prices[s]&&Date.now()-prices[s].observedAt<30000,
  status:()=>({mode:'stream',source,connected,lastMessage,displayIntervalMs:1000,capitalIntervalMs:1500,errors:{...errors},tradeable:{...trade}}),
 }
}
