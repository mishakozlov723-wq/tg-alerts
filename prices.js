// Источники цен. PRICE_SOURCE=mock (по умолчанию, для тестов) или dukascopy (реальные).
// Чтобы заменить источник, достаточно изменить/добавить функцию в этом файле.
export const SYMBOLS = {
  EURUSD: { pip: 0.0001, digits: 5, base: 1.085, duka: [process.env.DUKA_EURUSD || 'eurusd'] },
  GBPUSD: { pip: 0.0001, digits: 5, base: 1.265, duka: [process.env.DUKA_GBPUSD || 'gbpusd'] },
  // Названия индекса доллара в Dukascopy бывают разными — пробуем по очереди, рабочее запоминаем.
  DXY: { pip: 0.01, digits: 3, base: 99.5, duka: [process.env.DUKA_DXY, 'dollaridxusd', 'usdidx'].filter(Boolean) },
}

export const prices = {} // { EURUSD: { price, ts, dataTs? } }

export function setPrice(sym, price, onTick) {
  prices[sym] = { price: Number(price.toFixed(SYMBOLS[sym].digits)), ts: Date.now() }
  onTick?.(sym, prices[sym].price)
}

export function startPrices(onTick) {
  const mode = process.env.PRICE_SOURCE || 'mock'
  if (mode === 'oanda') return startOanda(onTick)
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
  console.log('[prices] режим MOCK (тестовые цены)')
}

// Последняя цена инструмента: сначала тики за 10 минут, потом минутки за 2 часа, потом за 4 дня (выходные).
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
    console.error('Не установлен dukascopy-node. Выполни в папке проекта: npm install')
    process.exit(1)
  }
  const working = {} // символ -> название инструмента, которое сработало
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
    if (!working[s] && Date.now() - (lastErr[s] || 0) > 60e3) { console.error(`[dukascopy] ${s}: нет данных (пробовал: ${names.join(', ')})`); lastErr[s] = Date.now() }
  }

  const pull = () => Promise.all(Object.entries(SYMBOLS).map(([s, c]) => pullOne(s, c)))
  await pull()
  setInterval(pull, Number(process.env.DUKA_INTERVAL_MS || 10000))
  console.log('[prices] режим DUKASCOPY (реальные цены)')
}

// ---------- OANDA (v20 REST) ----------
// Токен: личный кабинет OANDA -> Manage API Access. Для демо-счёта OANDA_ENV=practice, для реального live.
// EURUSD/GBPUSD — прямые котировки OANDA. DXY считается по формуле ICE из шести пар (как TVC:DXY).
const OANDA_PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CAD', 'USD_SEK', 'USD_CHF']
export function dxyFormula(q) {
  return 50.14348112 * q.EUR_USD ** -0.576 * q.USD_JPY ** 0.136 * q.GBP_USD ** -0.119 * q.USD_CAD ** 0.091 * q.USD_SEK ** 0.042 * q.USD_CHF ** 0.036
}

async function startOanda(onTick) {
  const token = process.env.OANDA_TOKEN
  if (!token) { console.error('Укажи OANDA_TOKEN в .env'); process.exit(1) }
  const live = (process.env.OANDA_ENV || 'practice') === 'live'
  const host = live ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com'
  const streamHost = live ? 'https://stream-fxtrade.oanda.com' : 'https://stream-fxpractice.oanda.com'
  const side = process.env.OANDA_SIDE || 'bid' // bid | ask | mid — что показывает твой график (TradingView = mid)
  const useStream = process.env.OANDA_STREAM !== '0'
  const headers = { authorization: `Bearer ${token}`, 'accept-datetime-format': 'UNIX' }
  const get = async (p) => {
    const r = await fetch(host + p, { headers, signal: AbortSignal.timeout(8000) })
    if (r.status === 401) throw new Error('OANDA: токен не подходит (401). Проверь OANDA_TOKEN и OANDA_ENV (practice или live)')
    if (!r.ok) throw new Error(`OANDA: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`)
    return r.json()
  }
  let account = process.env.OANDA_ACCOUNT
  if (!account) {
    try {
      const a = await get('/v3/accounts')
      account = a.accounts?.[0]?.id
      if (!account) throw new Error('OANDA: не найден счёт, укажи OANDA_ACCOUNT')
    } catch (e) { console.error('[oanda]', e.message); process.exit(1) }
    console.log('[oanda] счёт', account)
  }

  // Общая логика: каждый тик (из потока или из запасного опроса) обновляет цены
  const mid = {}, pick = {}
  const put = (s, v, t) => {
    if (!Number.isFinite(v)) return
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
    if (inst === 'EUR_USD') put('EURUSD', pick.EUR_USD, t)
    if (inst === 'GBP_USD') put('GBPUSD', pick.GBP_USD, t)
    if (OANDA_PAIRS.every((k) => mid[k])) put('DXY', dxyFormula(mid), t)
  }
  const ingestPrice = (p) => ingest(p.instrument, p.bids?.[0]?.price ?? p.closeoutBid, p.asks?.[0]?.price ?? p.closeoutAsk, p.time)

  let lastErr = 0
  const warn = (msg) => { if (Date.now() - lastErr > 30e3) { console.error('[oanda]', msg); lastErr = Date.now() } }

  // Опрос раз в секунду: первый запрос при старте и запасной режим, если поток молчит
  let lastStream = 0
  const pull = async () => {
    try {
      const d = await get(`/v3/accounts/${account}/pricing?instruments=${OANDA_PAIRS.join(',')}`)
      for (const p of d.prices || []) ingestPrice(p)
    } catch (e) { warn(e.message) }
  }
  await pull()
  setInterval(() => { if (!useStream || Date.now() - lastStream > 10e3) pull() }, Number(process.env.OANDA_INTERVAL_MS || 1000))

  // Поток: OANDA присылает каждое изменение цены (+ heartbeat раз в 5 сек). При обрыве переподключаемся.
  const runStream = async () => {
    let delay = 1000
    for (;;) {
      const ac = new AbortController()
      let wd
      const arm = () => { clearTimeout(wd); wd = setTimeout(() => ac.abort(), 15e3) }
      try {
        arm()
        const r = await fetch(`${streamHost}/v3/accounts/${account}/pricing/stream?instruments=${OANDA_PAIRS.join(',')}`, { headers, signal: ac.signal })
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
        warn('поток закрыт сервером, переподключаюсь')
      } catch (e) { warn(`поток: ${e.name === 'AbortError' ? 'нет данных 15 сек' : e.message}, переподключаюсь`) }
      finally { clearTimeout(wd); ac.abort() }
      await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 15e3)
    }
  }
  if (useStream) runStream()
  console.log(`[prices] режим OANDA (${live ? 'live' : 'practice'}, ${side}, ${useStream ? 'поток тиков' : 'опрос раз в секунду'})`)
}
