import { capitalClient, capitalTime, capitalInstrument, CAPITAL_CHART_SYMBOLS } from './capital.mjs'
const frames = { M15: [900,2000,'MINUTE_15'], H1: [3600,2000,'HOUR'], H4: [14400,1500,'HOUR_4'], D1: [86400,1000,'DAY'] }
const error = message => Object.assign(new Error(message), { status: 502 })
export function createCapitalCandles(env, store, now = Date.now) {
  const client = capitalClient(env), slots = new Map(), side = env.CAPITAL_SIDE || 'mid'
  function parse(rows, seconds, offset = 0) {
    if (!Array.isArray(rows) || !rows.length) throw error('candles_unavailable')
    return rows.map(row => {
      const time = capitalTime(row.snapshotTimeUTC) / 1000
      const values = ['openPrice','highPrice','lowPrice','closePrice'].map(k => {
        const leg = value => {
          if (!['number','string'].includes(typeof value) || typeof value === 'string' && !value.trim()) throw error('invalid_candles')
          const n = Number(value)
          if (!Number.isFinite(n) || n <= 0) throw error('invalid_candles')
          return n
        }
        const bid = side === 'ask' ? null : leg(row[k]?.bid), ask = side === 'bid' ? null : leg(row[k]?.ask)
        if (side === 'mid' && ask < bid) throw error('invalid_candles')
        return (side === 'bid' ? bid : side === 'ask' ? ask : (bid + ask) / 2) + offset
      })
      const [open,high,low,close] = values
      if (!Number.isSafeInteger(time) || time <= 0 || time * 1000 > now() + 60000 || !values.every(v => Number.isFinite(v) && v > 0) || high < Math.max(open,close) || low > Math.min(open,close) || low > high) throw error('invalid_candles')
      return { time, open, high, low, close, complete: (time + seconds) * 1000 <= now() }
    })
  }
  return { async get(params) {
    const tf = params.get('timeframe') || 'M15', frame = Object.hasOwn(frames,tf) ? frames[tf] : null
    const symbol = params.get('symbol') || 'DXY'
    if (!frame || !CAPITAL_CHART_SYMBOLS.includes(symbol)) throw Object.assign(error('unsupported_chart'), { status: 400 })
    const offset = symbol === 'DXY' ? 0 : Number(env['OFFSET_' + symbol] || 0)
    if (!Number.isFinite(offset) || !['bid','ask','mid'].includes(side)) throw error('chart_source_unconfigured')
    const identity = JSON.stringify([env.CAPITAL_ENV || 'demo', side, symbol === 'DXY' ? env.CAPITAL_EPIC_DXY || 'discover' : capitalInstrument(env, symbol), env.CAPITAL_IDENTIFIER || '', offset])
    const slotKey = symbol + ':' + tf
    const raw = params.get('before'), before = raw === null ? Infinity : Number(raw)
    if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(before) || before <= 0)) throw Object.assign(error('invalid_cursor'), { status: 400 })
    const key = 'tg-alerts:chart:capital:v1:' + slotKey
    if (!slots.has(slotKey)) slots.set(slotKey, (async () => {
      let snapshot = null
      try {
        const saved = JSON.parse(await store(['GET',key]))
        if (saved?.identity === identity && Number.isFinite(saved.fetchedAt) && saved.candles?.length <= frame[1]) {
          parse(saved.candles.map(c => ({ snapshotTimeUTC: new Date(c.time*1000).toISOString(), ...Object.fromEntries(['open','high','low','close'].map(k => [k+'Price',{bid:c[k],ask:c[k]}])) })), frame[0])
          snapshot = saved
        }
      } catch(e) { if (e.storageFailure) throw e }
      return { snapshot, next: 0, job: null, restored: !!snapshot }
    })())
    const s = await slots.get(slotKey)
    if (!s.job && now() >= s.next) {
      s.next = now() + 60000
      s.job = (async () => {
        const epic = symbol === 'DXY' ? await client.dxyEpic() : capitalInstrument(env, symbol), requestedAt = now(), all = new Map()
        // Capital caps a response at 1000 candles. Cold history uses at most two pages.
        const full = !s.snapshot || now() - s.snapshot.fetchedAt > frame[0]*7000
        if (!full) for (const c of s.snapshot.candles) all.set(c.time,c)
        let to = '', remaining = full ? frame[1] : 10
        while (remaining > 0) {
          const count = Math.min(1000,remaining)
          const query = new URLSearchParams({ resolution: frame[2], max: String(count) })
          if (to) query.set('to',to)
          const data = await client.get('/prices/' + encodeURIComponent(epic) + '?' + query)
          const rows = parse(data.prices,frame[0],offset).sort((a,b)=>a.time-b.time)
          for (const c of rows) all.set(c.time,c)
          remaining -= count
          if (rows.length < count) break
          to = new Date((rows[0].time-1)*1000).toISOString().replace('.000Z','')
        }
        const snapshot = { identity, epic, requestedAt, fetchedAt: now(), candles: [...all.values()].sort((a,b)=>a.time-b.time).slice(-frame[1]) }
        await store(['SET',key,JSON.stringify(snapshot)])
        s.snapshot = snapshot; s.restored = false; s.failed = false
      })().catch(e => { s.failed = true; throw e }).finally(() => { s.job = null })
    }
    if (s.job) try { await s.job } catch(e) { if (e.storageFailure || !s.snapshot) throw error(e.message) }
    if (!s.snapshot) throw error('candles_unavailable')
    const rows = s.snapshot.candles.filter(c=>c.time < before), candles = rows.slice(-300)
    return { symbol, timeframe:tf, source:'Capital', side, timezone:'UTC', requestedAt:s.snapshot.requestedAt, fetchedAt:s.snapshot.fetchedAt, windowStart:s.snapshot.candles[0]?.time, stale:!!s.failed || s.restored || now()-s.snapshot.fetchedAt > 90000, candles, hasMore:rows.length>candles.length, limit:frame[1] }
  } }
}
