// One bounded, shared history per timeframe; never used to trigger alerts.
export const CHART_SYMBOLS = { GBPUSD: 'GBP_USD', EURUSD: 'EUR_USD' }
export const CHART_FRAMES = { M15: { seconds: 900, limit: 2000 }, H1: { seconds: 3600, limit: 2000 }, H4: { seconds: 14400, limit: 1500 }, D1: { seconds: 86400, limit: 1000 } }
const fail = (message, status) => Object.assign(new Error(message), { status })
export function parseCandles(rows, side) {
  if (!Array.isArray(rows) || !rows.length) throw fail('candles_unavailable', 502)
  const result = new Map()
  for (const row of rows) {
    const time = Math.floor(Date.parse(row.time) / 1000), p = row[side]
    const [open, high, low, close] = ['o', 'h', 'l', 'c'].map(k => Number(p?.[k]))
    if (!Number.isSafeInteger(time) || time <= 0 || time * 1000 > Date.now() + 60000 ||
      ![open, high, low, close].every(n => Number.isFinite(n) && n > 0) ||
      high < Math.max(open, close) || low > Math.min(open, close) || low > high) throw fail('invalid_candles', 502)
    result.set(time, { time, open, high, low, close, complete: row.complete === true })
  }
  return [...result.values()].sort((a, b) => a.time - b.time)
}
export function createCandles(env, store, now = Date.now) {
  const fetcher = env.FETCH || globalThis.fetch, slots = new Map()
  const side = env.OANDA_SIDE || 'bid', component = { bid: 'B', ask: 'A', mid: 'M' }[side]
  const identity = JSON.stringify([env.OANDA_ENV || 'practice', side, env.OANDA_ACCOUNT || ''])
  async function slot(tf, symbol) {
    const key = symbol + ':' + tf
    // Preserve the existing GBP cache; EUR has a separate bounded snapshot.
    const storageKey = 'tg-alerts:chart:v1:' + (symbol === 'GBPUSD' ? tf : key)
    if (!slots.has(key)) slots.set(key, (async () => {
      let snapshot = null
      try {
        const v = JSON.parse(await store(['GET', storageKey]))
        if (v?.identity === identity && Array.isArray(v.candles) && v.candles.length <= CHART_FRAMES[tf].limit &&
          v.candles.every((c, i, a) => Number.isSafeInteger(c.time) && [c.open,c.high,c.low,c.close].every(n => Number.isFinite(n) && n > 0) && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close) && (!i || c.time > a[i-1].time)) && Number.isFinite(v.fetchedAt)) snapshot = v
      } catch (e) { if (e.storageFailure) throw e }
      return { snapshot, storageKey, next: 0, job: null, restored: !!snapshot }
    })().catch(e => { slots.delete(key); throw e }))
    return slots.get(key)
  }
  async function refresh(s, tf, symbol) {
    s.next = now() + 60000 // Global retry backoff, including provider failures.
    if (!component || !env.OANDA_TOKEN) throw fail('chart_source_unconfigured', 503)
    const frame = CHART_FRAMES[tf], previous = s.snapshot
    const full = !previous || now() - previous.fetchedAt > frame.seconds * 7000
    const host = env.OANDA_ENV === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com'
    const url = new URL('/v3/instruments/' + CHART_SYMBOLS[symbol] + '/candles', host)
    url.search = new URLSearchParams({ granularity: tf === 'D1' ? 'D' : tf, price: component,
      count: String(full ? frame.limit : 10), smooth: 'false', dailyAlignment: '17', alignmentTimezone: 'America/New_York' })
    let r, data
    const requestedAt = now()
    try {
      r = await fetcher(url.toString(), { headers: { authorization: 'Bearer ' + env.OANDA_TOKEN }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error()
      data = await r.json()
    } catch { throw fail('candles_unavailable', 502) }
    if (data.instrument !== CHART_SYMBOLS[symbol] || data.granularity !== (tf === 'D1' ? 'D' : tf)) throw fail('invalid_candles', 502)
    const incoming = parseCandles(data.candles, side)
    const merged = new Map((full ? [] : previous.candles).map(c => [c.time, c]))
    for (const c of incoming) merged.set(c.time, c)
    const snapshot = { identity, requestedAt, fetchedAt: now(), candles: [...merged.values()].sort((a,b) => a.time-b.time).slice(-frame.limit) }
    await store(['SET', s.storageKey, JSON.stringify(snapshot)])
    s.snapshot = snapshot; s.restored = false
  }
  return { async get(params) {
    const tf = params.get('timeframe') || 'M15', symbol = params.get('symbol') || 'GBPUSD'
    if (!Object.hasOwn(CHART_SYMBOLS, symbol) || !Object.hasOwn(CHART_FRAMES, tf)) throw fail('unsupported_chart', 400)
    const raw = params.get('before'), before = raw === null ? Infinity : Number(raw)
    if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(before) || before <= 0)) throw fail('invalid_cursor', 400)
    const s = await slot(tf, symbol)
    if (!s.job && now() >= s.next) s.job = refresh(s, tf, symbol).then(() => { s.failed = false }, e => { s.failed = true; throw e }).finally(() => { s.job = null })
    if (s.job) {
      try { await s.job } catch (e) { if (e.storageFailure || !s.snapshot) throw e }
    }
    if (!s.snapshot) throw fail('candles_unavailable', 502)
    const candles = s.snapshot.candles.filter(c => c.time < before), page = candles.slice(-300)
    return { symbol, timeframe: tf, source: 'OANDA', side, timezone: 'America/New_York', dailyAlignment: 17,
      requestedAt: s.snapshot.requestedAt || s.snapshot.fetchedAt, windowStart: s.snapshot.candles[0]?.time,
      fetchedAt: s.snapshot.fetchedAt, stale: !!s.failed || s.restored || now() - s.snapshot.fetchedAt > 90000,
      candles: page, hasMore: candles.length > page.length, limit: CHART_FRAMES[tf].limit }
  } }
}
