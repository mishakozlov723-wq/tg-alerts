// Price sources. PRICE_SOURCE=mock (default, for tests), oanda or dukascopy.
// Paid quotes (Gold, GER40) come from Capital.com when CAPITAL_API_KEY is set.
// To change a source, edit or add a function in this file.
export const SYMBOLS = {
  EURUSD: { pip: 0.0001, digits: 5, base: 1.085, oanda: 'EUR_USD', duka: [process.env.DUKA_EURUSD || 'eurusd'] },
  GBPUSD: { pip: 0.0001, digits: 5, base: 1.265, oanda: 'GBP_USD', duka: [process.env.DUKA_GBPUSD || 'gbpusd'] },
  // Dukascopy has several names for the dollar index, try them in turn.
  DXY: { pip: 0.01, digits: 3, base: 99.5, duka: [process.env.DUKA_DXY, 'dollaridxusd', 'usdidx'].filter(Boolean) },
  // Paid quotes: visible only to users who bought them. OFFSET_* shifts the price (in price units) to match your chart.
  // CAPITAL_EPIC_* can override the Capital.com market names.
  XAUUSD: { label: 'Gold', premium: true, pip: 0.1, digits: 2, base: 4000, oanda: process.env.OANDA_XAUUSD || 'XAU_USD', capital: process.env.CAPITAL_EPIC_XAUUSD || 'GOLD', offset: Number(process.env.OFFSET_XAUUSD || 0), duka: [process.env.DUKA_XAUUSD || 'xauusd'] },
  GER40: { label: 'GER40', premium: true, pip: 1, digits: 1, base: 25400, oanda: process.env.OANDA_GER40 || 'DE30_EUR', capital: process.env.CAPITAL_EPIC_GER40 || 'DE40', offset: Number(process.env.OFFSET_GER40 || 0), duka: [process.env.DUKA_GER40 || 'deuidxeur'] },
}

export const prices = {} // { EURUSD: { price, ts, dataTs? } }
// Paid symbols whose feed is not available (filled at startup).
export const feedStatus = { missing: [] }

export function setPrice(sym, price, onTick) {
  prices[sym] = { price: Number(price.toFixed(SYMBOLS[sym].digits)), ts: Date.now() }
  onTick?.(sym, prices[sym].price)
}

const capitalOn = () => !!(process.env.CAPITAL_API_KEY && process.env.CAPITAL_IDENTIFIER && process.env.CAPITAL_PASSWORD)

function tellAdmin(text) {
  console.log('[prices]', text)
  if (!process.env.BOT_TOKEN) return
  fetch(`${process.env.TG_API || 'https://api.telegram.org'}/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.ADMIN_CHAT_ID || '1011596614', text: '[tg-alerts] ' + text }),
  }).catch(() => {})
}

export function startPrices(onTick) {
  const mode = process.env.PRICE_SOURCE || 'mock'
  if (mode === 'oanda') {
    const cap = capitalOn() ? startCapital(onTick).catch((e) => console.error('[capital]', e.message)) : null
    const main = startOanda(onTick)
    return cap ? Promise.all([cap, main]) : main
  }
  if (mode === 'dukascopy') return startDukascopy(onTick)
  return startMock(onTick)
}

function startMock(onTick) {
  for (const [s, c] of Object.entries(SYMBOLS)) setPrice(s, c.base, onTick)
  setInterval(() => {
    for (const [s, c] of Object.entries(SYMBOLS)) {
      const step = (Math.random() - 0.5) * 2 * c.pip * 0.35
      setPrice(s, prices[s].price + step, onTick)
    }
  }, 300)
  console.log('[prices] MOCK mode (test prices)')
}

// ---------- Capital.com (REST, polling) ----------
// Env: CAPITAL_API_KEY, CAPITAL_IDENTIFIER (login email), CAPITAL_PASSWORD (API key password),
// CAPITAL_ENV=demo|live (default demo), CAPITAL_SIDE=bid|ask|mid (default mid), CAPITAL_INTERVAL_MS (default 1500).
async function startCapital(onTick) {
  const key = process.env.CAPITAL_API_KEY, id = process.env.CAPITAL_IDENTIFIER, pw = process.env.CAPITAL_PASSWORD
  const live = (process.env.CAPITAL_ENV || 'demo') === 'live'
  const base = live ? 'https://api-capital.backend-capital.com' : 'https://demo-api-capital.backend-capital.com'
  const side = process.env.CAPITAL_SIDE || 'mid'
  const items = Object.entries(SYMBOLS).filter(([, c]) => c.capital)
  const symOfEpic = {}
  for (const [s, c] of items) symOfEpic[c.capital] = s
  const epics = items.map(([, c]) => c.capital).join(',')
  const symbols = items.map(([s]) => s)
  let cst = '', sec = '', loginAt = 0, lastWarn = 0, busy = false, announced = ''
  const warn = (msg) => { if (Date.now() - lastWarn > 30e3) { console.error('[capital]', msg); lastWarn = Date.now() } }

  const login = async () => {
    const r = await fetch(base + '/api/v1/session', {
      method: 'POST',
      headers: { 'X-CAP-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: id, password: pw, encryptedPassword: false }),
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) throw new Error(`login HTTP ${r.status} ${(await r.text()).slice(0, 150)}`)
    cst = r.headers.get('cst') || ''
    sec = r.headers.get('x-security-token') || ''
    if (!cst || !sec) throw new Error('login: no session tokens in response')
    loginAt = Date.now()
  }

  const setMissing = (list) => {
    feedStatus.missing = feedStatus.missing.filter((s) => !symbols.includes(s)).concat(list)
    const sig = list.join(',')
    if (sig !== announced) {
      announced = sig
      if (list.length) tellAdmin('Capital.com feed not available for: ' + sig)
      else tellAdmin(`Capital.com connected (${live ? 'live' : 'demo'}): ${symbols.join(', ')}`)
    }
  }

  const pull = async () => {
    if (busy) return
    busy = true
    try {
      if (!cst || Date.now() - loginAt > 8 * 60e3) await login()
      const r = await fetch(`${base}/api/v1/markets?epics=${epics}`, {
        headers: { 'X-SECURITY-TOKEN': sec, CST: cst },
        signal: AbortSignal.timeout(8000),
      })
      if (r.status === 401) { cst = ''; throw new Error('session expired, logging in again') }
      if (!r.ok) throw new Error(`markets HTTP ${r.status} ${(await r.text()).slice(0, 150)}`)
      const d = await r.json()
      const seen = new Set()
      for (const m of d.marketDetails || []) {
        const epic = m.instrument?.epic || m.epic
        const s = symOfEpic[epic]
        if (!s) continue
        const bid = Number(m.snapshot?.bid), ofr = Number(m.snapshot?.offer)
        if (!Number.isFinite(bid) || !Number.isFinite(ofr)) continue
        seen.add(s)
        let v = side === 'bid' ? bid : side === 'ask' ? ofr : (bid + ofr) / 2
        v += SYMBOLS[s].offset || 0
        const rounded = Number(v.toFixed(SYMBOLS[s].digits))
        if (prices[s]?.price !== rounded) setPrice(s, v, onTick)
        if (prices[s] && m.snapshot?.marketStatus === 'TRADEABLE') prices[s].dataTs = Date.now()
      }
      setMissing(symbols.filter((s) => !seen.has(s)))
    } catch (e) {
      warn(e.message)
      if (!announced) setMissing(symbols.slice())
      if (/login/.test(e.message)) cst = ''
    } finally { busy = false }
  }

  await pull()
  setInterval(pull, Number(process.env.CAPITAL_INTERVAL_MS || 1500))
  console.log(`[prices] CAPITAL.COM (${live ? 'live' : 'demo'}, ${side}): ${epics}`)
}

// Last price of an instrument: ticks of the last 10 minutes, then 1-minute bars of 2 hours, then 4 days (weekends).
async function lastPrice(getHistoricalRates, instrument) {
  const attempts = [
    { timeframe: 'tick', ms: 10 * 60e3 },
    { timeframe: 'm1', ms: 2 * 3600e3 },
    { timeframe: 'm1', ms: 4 * 86400e3 },
  ]
  for (const a of attempts) {
    const data = await getHistoricalRates({
      instrument,
      dates: { from: new Date(Date.now() - a.ms), to: new Date() },
      timeframe: a.timeframe,
      format: 'json',
      priceType: 'bid',
    })
    const last = data?.[data.length - 1]
    if (!last) continue
    if (a.timeframe === 'tick') {
      const { bidPrice: bid, askPrice: ask } = last
      return { price: bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask), dataTs: last.timestamp }
    }
    return { price: last.close, dataTs: last.timestamp }
  }
  return null
}

async function startDukascopy(onTick) {
  let getHistoricalRates
  try {
    ;({ getHistoricalRates } = await import('dukascopy-node'))
  } catch {
    console.error('dukascopy-node is not installed. Run npm install in the project folder.')
    process.exit(1)
  }
  const working = {} // symbol -> instrument name that worked
  const lastErr = {}

  const pullOne = async (s, c) => {
    const names = working[s] ? [working[s]] : c.duka
    for (const name of names) {
      try {
        const r = await lastPrice(getHistoricalRates, name)
        if (!r || !Number.isFinite(r.price)) continue
        if (working[s] !== name) { working[s] = name; console.log(`[dukascopy] ${s} <- ${name}`) }
        setPrice(s, r.price, onTick)
        prices[s].dataTs = r.dataTs
        lastErr[s] = 0
        return
      } catch (e) {
        if (Date.now() - (lastErr[s] || 0) > 60e3) { console.error(`[dukascopy] ${s} (${name}):`, e.message); lastErr[s] = Date.now() }
      }
    }
    if (!working[s] && Date.now() - (lastErr[s] || 0) > 60e3) { console.error(`[dukascopy] ${s}: no data (tried: ${names.join(', ')})`); lastErr[s] = Date.now() }
  }

  const pull = () => Promise.all(Object.entries(SYMBOLS).map(([s, c]) => pullOne(s, c)))
  await pull()
  setInterval(pull, Number(process.env.DUKA_INTERVAL_MS || 10000))
  console.log('[prices] DUKASCOPY mode (real prices)')
}

// ---------- OANDA (v20 REST) ----------
// Token: OANDA account -> Manage API Access. OANDA_ENV=practice for a demo account, live for a real one.
// Quotes come straight from OANDA. DXY is computed with the ICE formula from six pairs (like TVC:DXY).
const OANDA_PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CAD', 'USD_SEK', 'USD_CHF']
const symOf = {} // OANDA instrument -> our symbol
for (const [s, c] of Object.entries(SYMBOLS)) if (c.oanda) symOf[c.oanda] = s
export function dxyFormula(q) {
  return 50.14348112 * q.EUR_USD ** -0.576 * q.USD_JPY ** 0.136 * q.GBP_USD ** -0.119 * q.USD_CAD ** 0.091 * q.USD_SEK ** 0.042 * q.USD_CHF ** 0.036
}

async function startOanda(onTick) {
  const token = process.env.OANDA_TOKEN
  if (!token) { console.error('Set OANDA_TOKEN in .env'); process.exit(1) }
  const live = (process.env.OANDA_ENV || 'practice') === 'live'
  const host = live ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com'
  const streamHost = live ? 'https://stream-fxtrade.oanda.com' : 'https://stream-fxpractice.oanda.com'
  const side = process.env.OANDA_SIDE || 'bid' // bid | ask | mid, what your chart shows (TradingView = mid)
  const useStream = process.env.OANDA_STREAM !== '0'
  const headers = { authorization: `Bearer ${token}`, 'accept-datetime-format': 'UNIX' }
  const get = async (p) => {
    const r = await fetch(host + p, { headers, signal: AbortSignal.timeout(8000) })
    if (r.status === 401) throw new Error('OANDA: token rejected (401). Check OANDA_TOKEN and OANDA_ENV (practice or live)')
    if (!r.ok) throw new Error(`OANDA: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`)
    return r.json()
  }
  let account = process.env.OANDA_ACCOUNT
  if (!account) {
    try {
      const a = await get('/v3/accounts')
      account = a.accounts?.[0]?.id
      if (!account) throw new Error('OANDA: no account found, set OANDA_ACCOUNT')
    } catch (e) { console.error('[oanda]', e.message); process.exit(1) }
    console.log('[oanda] account', account)
  }

  // Paid instruments come from Capital.com when it is configured. Otherwise try OANDA, but only if the account offers them.
  const extra = []
  const wanted = capitalOn() ? [] : Object.entries(SYMBOLS).filter(([, c]) => c.premium && c.oanda)
  if (wanted.length) {
    try {
      const ins = await get(`/v3/accounts/${account}/instruments`)
      const names = new Set((ins.instruments || []).map((i) => i.name))
      for (const [s, c] of wanted) { if (names.has(c.oanda)) extra.push(c.oanda); else feedStatus.missing.push(s) }
    } catch (e) {
      console.error('[oanda] instrument list:', e.message)
      for (const [s] of wanted) feedStatus.missing.push(s)
    }
  }
  const instrList = [...OANDA_PAIRS, ...extra].join(',')

  // Shared logic: every tick (stream or fallback polling) updates prices
  const mid = {}, pick = {}
  const put = (s, v, t) => {
    if (!Number.isFinite(v)) return
    v += SYMBOLS[s].offset || 0
    const r = Number(v.toFixed(SYMBOLS[s].digits))
    if (prices[s]?.price === r) { prices[s].dataTs = t; return }
    setPrice(s, v, onTick); prices[s].dataTs = t
  }
  const ingest = (inst, bidRaw, askRaw, timeRaw) => {
    const bid = Number(bidRaw), ask = Number(askRaw)
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return
    const t = Number(timeRaw) * 1000 || Date.now()
    mid[inst] = (bid + ask) / 2
    pick[inst] = side === 'ask' ? ask : side === 'mid' ? (bid + ask) / 2 : bid
    const s = symOf[inst]
    if (s && !(SYMBOLS[s].premium && capitalOn())) put(s, pick[inst], t)
    if (OANDA_PAIRS.every((k) => mid[k])) put('DXY', dxyFormula(mid), t)
  }
  const ingestPrice = (p) => ingest(p.instrument, p.bids?.[0]?.price ?? p.closeoutBid, p.asks?.[0]?.price ?? p.closeoutAsk, p.time)

  let lastErr = 0
  const warn = (msg) => { if (Date.now() - lastErr > 30e3) { console.error('[oanda]', msg); lastErr = Date.now() } }

  // Polling once per second: first request at start and fallback when the stream is silent
  let lastStream = 0
  const pull = async () => {
    try {
      const d = await get(`/v3/accounts/${account}/pricing?instruments=${instrList}`)
      for (const p of d.prices || []) ingestPrice(p)
    } catch (e) { warn(e.message) }
  }
  await pull()
  setInterval(() => { if (!useStream || Date.now() - lastStream > 10e3) pull() }, Number(process.env.OANDA_INTERVAL_MS || 1000))

  // Stream: OANDA sends every price change (+ heartbeat every 5 s). Reconnect on drop.
  const runStream = async () => {
    let delay = 1000
    for (;;) {
      const ac = new AbortController()
      let wd
      const arm = () => { clearTimeout(wd); wd = setTimeout(() => ac.abort(), 15e3) }
      try {
        arm()
        const r = await fetch(`${streamHost}/v3/accounts/${account}/pricing/stream?instruments=${instrList}`, { headers, signal: ac.signal })
        if (!r.ok) throw new Error(`stream HTTP ${r.status}`)
        const reader = r.body.getReader(), dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          arm(); lastStream = Date.now(); delay = 1000
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
            if (!line) continue
            let m; try { m = JSON.parse(line) } catch { continue }
            if (m.type === 'PRICE') ingestPrice(m)
          }
        }
        warn('stream closed by server, reconnecting')
      } catch (e) { warn(`stream: ${e.name === 'AbortError' ? 'no data for 15 s' : e.message}, reconnecting`) }
      finally { clearTimeout(wd); ac.abort() }
      await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 15e3)
    }
  }
  if (useStream) runStream()
  console.log(`[prices] OANDA mode (${live ? 'live' : 'practice'}, ${side}, ${useStream ? 'tick stream' : 'polling every second'}); extra: ${extra.join(', ') || 'none'}`)
}
