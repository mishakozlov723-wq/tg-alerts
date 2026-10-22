// Explicit snapshot feed: NOT a tick stream. Short crossings between snapshots can
// be missed. This mode must be approved before activation; do not call it real-time.
export function dxyFormula(q) {
  return 50.14348112 * q.EUR_USD ** -0.576 * q.USD_JPY ** 0.136 * q.GBP_USD ** -0.119 * q.USD_CAD ** 0.091 * q.USD_SEK ** 0.042 * q.USD_CHF ** 0.036
}
const PAIRS = ['EUR_USD','GBP_USD','USD_JPY','USD_CAD','USD_SEK','USD_CHF']
export function createQuoteFeed(env) {
  const SYMBOLS = {
    EURUSD: { pip: .0001, digits: 5, oanda:'EUR_USD' },
    GBPUSD: { pip: .0001, digits: 5, oanda:'GBP_USD' },
    DXY: { pip:.01,digits:3,premium:true },
    XAUUSD: { label:'Gold',premium:true,pip:.1,digits:2,oanda:env.OANDA_XAUUSD||'XAU_USD',capital:env.CAPITAL_EPIC_XAUUSD||'GOLD',offset:Number(env.OFFSET_XAUUSD||0) },
    GER40: { label:'GER40',premium:true,pip:1,digits:1,oanda:env.OANDA_GER40||'DE30_EUR',capital:env.CAPITAL_EPIC_GER40||'DE40',offset:Number(env.OFFSET_GER40||0) },
    XAGUSD: { label:'Silver',premium:true,pip:.01,digits:3,capital:env.CAPITAL_EPIC_XAGUSD||'SILVER',offset:Number(env.OFFSET_XAGUSD||0) },
  }
  const prices = {}, feedStatus = { missing:['XAUUSD','GER40','XAGUSD'] }, trade = {}, errors = {}
  const capOn = !!(env.CAPITAL_API_KEY && env.CAPITAL_IDENTIFIER && env.CAPITAL_PASSWORD)
  const host = env.OANDA_ENV === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com'
  let account=env.OANDA_ACCOUNT, discovered=false, extra=[], lastPoll=0, cst='',sec='',loginAt=0,capNext=0,capFails=0
  const unavailable = (symbols, unavailable) => { feedStatus.missing = [...new Set([...feedStatus.missing.filter(s=>!symbols.includes(s)),...unavailable])] }
  const stamp = raw => typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) ? Number(raw)*1000 : Date.parse(raw)
  const marketOpen = () => { const d=new Date(),day=d.getUTCDay(),h=d.getUTCHours();return day!==6 && !(day===5&&h>=21) && !(day===0&&h<22) }
  async function get(path) {
    const r=await fetch(host+path,{headers:{authorization:`Bearer ${env.OANDA_TOKEN}`,'accept-datetime-format':'UNIX'},signal:AbortSignal.timeout(8000)})
    if(!r.ok) throw new Error(`OANDA HTTP ${r.status}`)
    return r.json()
  }
  async function setPrice(sym,value,onTick,meta={}) {
    if (!SYMBOLS[sym] || !Number.isFinite(value)) return
    const now=Date.now()
    prices[sym]={price:Number(value.toFixed(SYMBOLS[sym].digits)),ts:now,observedAt:now,...meta}
    if (onTick) await onTick(sym,prices[sym].price)
  }
  async function pollOanda(onTick) {
    if(!env.OANDA_TOKEN) throw new Error('OANDA token missing')
    if(!account) { const a=await get('/v3/accounts');account=a.accounts?.[0]?.id;if(!account)throw new Error('OANDA account unavailable') }
    if(!discovered) {
      if(!capOn) {
        const ins=await get(`/v3/accounts/${encodeURIComponent(account)}/instruments`)
        const names=new Set((ins.instruments||[]).map(x=>x.name))
        const wanted=Object.entries(SYMBOLS).filter(([,c])=>c.premium&&c.oanda)
        extra=wanted.filter(([,c])=>names.has(c.oanda)).map(([,c])=>c.oanda)
        unavailable(wanted.map(([s])=>s),wanted.filter(([,c])=>!names.has(c.oanda)).map(([s])=>s))
      }
      discovered=true
    }
    const d=await get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent([...PAIRS,...extra].join(','))}`)
    const mids={}, tradablePairs=[], times=[]
    for(const p of d.prices||[]) {
      const bid=Number(p.bids?.[0]?.price??p.closeoutBid),ask=Number(p.asks?.[0]?.price??p.closeoutAsk),dataTs=stamp(p.time)
      if(!Number.isFinite(bid)||!Number.isFinite(ask)||!Number.isFinite(dataTs))continue
      // Don't label an old/closed quote fresh merely because the API answered now.
      const valid=p.tradeable===true && Date.now()-dataTs<=30000 && dataTs<=Date.now()+60000
      if(PAIRS.includes(p.instrument)){mids[p.instrument]=(bid+ask)/2;times.push(dataTs);if(valid)tradablePairs.push(p.instrument)}
      const pair=Object.entries(SYMBOLS).find(([,c])=>c.oanda===p.instrument)
      if(pair && !(pair[1].premium&&capOn)) {
        const [s,c]=pair;trade[s]=valid
        const side=env.OANDA_SIDE||'mid',v=side==='bid'?bid:side==='ask'?ask:(bid+ask)/2
        await setPrice(s,v+(c.offset||0),valid?onTick:null,{dataTs,tradeable:valid})
      }
    }
    if(PAIRS.every(s=>Number.isFinite(mids[s]))) {
      trade.DXY=tradablePairs.length===PAIRS.length
      await setPrice('DXY',dxyFormula(mids),trade.DXY?onTick:null,{dataTs:Math.min(...times),tradeable:trade.DXY})
    }
    errors.oanda=null
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
  return {
    SYMBOLS,prices,feedStatus,setPrice,marketOpen,
    tradeable:s=>trade[s]===true,
    fresh:s=>trade[s]===true&&!!prices[s]&&Date.now()-prices[s].observedAt<30000,
    status:()=>({mode:'snapshot',intervalMs:10000,lastPoll,errors,tradeable:{...trade},warning:'Brief level crossings between snapshots may be missed.'}),
    async poll(onTick) {
      lastPoll=Date.now()
      // Failures of one broker cannot suppress another broker or fake a quote.
      let deliveries=Promise.resolve()
      const serialTick=onTick ? (...args)=>(deliveries=deliveries.then(()=>onTick(...args))) : null
      const result=await Promise.allSettled([pollOanda(serialTick),pollCapital(serialTick)])
      for (const r of result) if(r.status==='rejected' && r.reason?.storageFailure) throw r.reason
      if(result[0].status==='rejected')errors.oanda='OANDA feed unavailable'
      return result
    },
  }
}
