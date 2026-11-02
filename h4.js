// OANDA H4 reminders. No fixed UTC schedule and no dependency on price ticks.
// https://developer.oanda.com/rest-live-v20/instrument-ep/
// https://developer.oanda.com/rest-live-v20/instrument-df/
export const H4_ASSETS = {
  EURUSD: { label: 'EUR/USD', instrument: 'EUR_USD' },
  GBPUSD: { label: 'GBP/USD', instrument: 'GBP_USD' },
  XAUUSD: { label: 'Gold', instrument: 'XAU_USD' },
  GER40: { label: 'GER40', instrument: 'DE30_EUR' },
}
export const H4_LEADS = [30, 15, 10, 5, 1]
export const H4_ZONE = 'America/New_York'
export const H4_ALIGNMENT = 17
export const DELIVERY_WINDOW = 120000
export const defaultH4Settings = () => ({ enabled: false, symbols: ['EURUSD', 'GBPUSD'], lead: [5], atClose: true })
export function normalizeH4Settings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.enabled !== 'boolean' || typeof input.atClose !== 'boolean' ||
      !Array.isArray(input.symbols) || !Array.isArray(input.lead) ||
      input.symbols.some((s) => !Object.hasOwn(H4_ASSETS, s)) ||
      input.lead.some((m) => !H4_LEADS.includes(m))) throw new Error('Invalid H4 settings')
  const symbols = [...new Set(input.symbols)]
  const lead = H4_LEADS.filter((m) => input.lead.includes(m))
  if (input.enabled && (!symbols.length || (!lead.length && !input.atClose))) throw new Error('Select an asset and a notification time')
  return { enabled: input.enabled, symbols, lead, atClose: input.atClose }
}
const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: H4_ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
// Find the NEXT broker-local grid boundary. Iterating UTC minutes avoids ambiguous
// or nonexistent local times at DST transitions and uses the runtime IANA tzdb.
export function nextH4Boundary(start) {
  if (!Number.isFinite(start)) throw new Error('Invalid candle time')
  let t = Math.floor(start / 60000) * 60000 + 60000
  for (let i = 0; i < 6 * 60; i++, t += 60000) {
    const p = Object.fromEntries(formatter.formatToParts(t).map((v) => [v.type, v.value]))
    if (+p.minute === 0 && ((+p.hour - H4_ALIGNMENT + 24) % 4 === 0)) return t
  }
  throw new Error('No H4 boundary found')
}
function parseTime(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) return Number(value) * 1000
  return typeof value === 'string' ? Date.parse(value) : NaN
}
export function candleSnapshot(candles, now) {
  if (!Array.isArray(candles)) throw new Error('Invalid OANDA candles')
  const list = candles.map((c) => {
    const start = parseTime(c.time)
    if (!Number.isFinite(start) || typeof c.complete !== 'boolean' || !(c.volume > 0)) return null
    return { start, close: nextH4Boundary(start), complete: c.complete }
  }).filter(Boolean).sort((a, b) => a.start - b.start)
  const active = list.findLast((c) => !c.complete && c.start <= now && now < c.close) || null
  // A timer reaching zero does NOT mean the candle is confirmed complete.
  const closed = list.filter((c) => c.complete && c.close <= now && now - c.close <= DELIVERY_WINDOW)
  return { active, closed }
}
export function createOandaH4({ env = process.env, fetcher = fetch, clock = Date.now, onError = console.error } = {}) {
  const configured = Boolean(env.OANDA_TOKEN) && (env.PRICE_SOURCE || 'mock') !== 'mock'
  const host = env.OANDA_ENV === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com'
  const cache = new Map(), pending = new Map()
  let account = env.OANDA_ACCOUNT, accountJob = null
  async function getJson(path) {
    const r = await fetcher(host + path, { headers: { authorization: `Bearer ${env.OANDA_TOKEN}` }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`OANDA H4 HTTP ${r.status}`)
    return r.json()
  }
  async function getAccount() {
    if (account) return account
    if (!accountJob) accountJob = getJson('/v3/accounts').then((d) => {
      account = d.accounts?.[0]?.id
      if (!account) throw new Error('OANDA H4 account unavailable')
      return account
    }).finally(() => { accountJob = null })
    return accountJob
  }
  function instrumentFor(symbol) {
    return symbol === 'XAUUSD' ? (env.OANDA_XAUUSD || 'XAU_USD') : symbol === 'GER40' ? (env.OANDA_GER40 || 'DE30_EUR') : H4_ASSETS[symbol]?.instrument
  }
  async function refresh(symbol) {
    const instrument = instrumentFor(symbol)
    if (!instrument || !configured) return null
    const cached = cache.get(instrument)
    const now = clock()
    const nearClose = cached?.snapshot?.active && Math.abs(cached.snapshot.active.close - now) < 3 * 60000
    const ttl = cached?.error ? 30000 : nearClose || cached?.snapshot?.closed?.length ? 10000 : 30000
    if (cached && now - cached.checkedAt < ttl) return cached
    if (pending.has(instrument)) return pending.get(instrument)
    const job = (async () => {
      try {
        const q = new URLSearchParams({ granularity: 'H4', price: 'M', count: '4', dailyAlignment: String(H4_ALIGNMENT), alignmentTimezone: H4_ZONE })
        const [data, pricing] = await Promise.all([
          getJson(`/v3/instruments/${encodeURIComponent(instrument)}/candles?${q}`),
          getAccount().then((id) => getJson(`/v3/accounts/${encodeURIComponent(id)}/pricing?instruments=${encodeURIComponent(instrument)}`)),
        ])
        if (data.granularity !== 'H4' || data.instrument !== instrument) throw new Error('OANDA H4 response mismatch')
        const snapshot = candleSnapshot(data.candles, clock())
        const quote = pricing.prices?.find((p) => p.instrument === instrument)
        if (!quote || typeof quote.tradeable !== 'boolean') throw new Error('OANDA H4 market status unavailable')
        // Holidays and CFD session breaks are broker data, not fixed weekday hours.
        if (!quote.tradeable) snapshot.active = null
        const entry = { checkedAt: clock(), snapshot }
        cache.set(instrument, entry)
        return entry
      } catch (e) {
        // Never substitute Capital.com/Dukascopy or stale candles on an API error.
        const entry = { checkedAt: clock(), error: true, snapshot: null }
        cache.set(instrument, entry)
        onError(`[h4] ${instrument}: ${e.message}`)
        return entry
      } finally { pending.delete(instrument) }
    })()
    pending.set(instrument, job)
    return job
  }
  async function get(symbols) {
    await Promise.all([...new Set(symbols)].map(refresh))
    const now = clock()
    return Object.fromEntries(symbols.filter((s) => Object.hasOwn(H4_ASSETS, s)).map((s) => {
      const entry = cache.get(instrumentFor(s))
      const fresh = entry && !entry.error && now - entry.checkedAt <= 90000
      const snapshot = fresh ? candleSnapshotFromEntry(entry, now) : { active: null, closed: [] }
      return [s, { ...H4_ASSETS[s], instrument: instrumentFor(s), status: !configured ? 'unconfigured' : !fresh ? 'unavailable' : snapshot.active ? 'live' : 'waiting', checkedAt: entry?.checkedAt || null, ...snapshot }]
    }))
  }
  return { get, configured }
}
// Monitor view of H4 states. A call for a subset (one user's status page)
// merges into it instead of replacing the runner's results for other symbols;
// symbols nobody has requested for ttlMs drop out.
export function createH4StatusBoard({ ttlMs = 10 * 60000, clock = Date.now } = {}) {
  const seen = new Map()
  return {
    record(states) {
      const now = clock()
      for (const [s, v] of Object.entries(states)) seen.set(s, { status: v.status, at: now })
      return states
    },
    current() {
      const now = clock()
      for (const [s, v] of seen) if (now - v.at > ttlMs) seen.delete(s)
      return Object.fromEntries([...seen].map(([s, v]) => [s, v.status]))
    },
  }
}
function candleSnapshotFromEntry(entry, now) {
  return {
    active: entry.snapshot.active && now < entry.snapshot.active.close ? entry.snapshot.active : null,
    closed: entry.snapshot.closed.filter((c) => now - c.close <= DELIVERY_WINDOW),
  }
}
export function dueH4Notifications(settings, states, now) {
  if (!settings?.enabled) return []
  const due = []
  for (const symbol of settings.symbols) {
    if (!Object.hasOwn(H4_ASSETS, symbol)) continue // Ignore legacy DXY selections.
    const state = states[symbol]
    if (!state || !['live', 'waiting'].includes(state.status)) continue
    const { active, closed = [] } = state
    if (active && active.close > now) {
      for (const lead of settings.lead) {
        const at = active.close - lead * 60000
        // No backfill of reminders missed before enabling or during downtime.
        if (at >= settings.since && now >= at && now - at < 60000) due.push({ symbol, start: active.start, close: active.close, lead, at, reference: state.reference })
      }
    }
    if (settings.atClose) for (const c of closed) {
      if (c.close >= settings.since && now >= c.close && now - c.close < DELIVERY_WINDOW) due.push({ symbol, start: c.start, close: c.close, lead: 0, at: c.close, reference: state.reference })
    }
  }
  return due
}
export function h4Message(event) {
  const label = H4_ASSETS[event.symbol].label
  const time = new Date(event.close).toISOString().slice(11, 16) + ' UTC'
  const source = 'OANDA'
  if (event.lead) return `⏱ ${label} · H4\nCandle closes at ${time} (${event.lead} min reminder).\n${source}`
  return `🔔 ${label} · H4\nCandle closed at ${time}.\n${source}`
}
export function createH4Runner({ getSettings, source, allowed, claim, deliver, commit = null, clock = Date.now, onError = console.error }) {
  let busy = false
  return async function run() {
    if (busy) return
    busy = true
    try {
      const entries = Object.entries(getSettings()).filter(([, s]) => s.enabled)
      const wanted = [...new Set(entries.flatMap(([uid, s]) => s.symbols.filter((sym) => allowed(uid, sym))))]
      if (!wanted.length) return
      const states = await source.get(wanted)
      for (const [uid] of entries) {
        // Re-read after await: disabled/revoked settings must take effect immediately.
        const s = getSettings()[uid]
        for (const event of dueH4Notifications(s, states, clock())) {
          if (!allowed(uid, event.symbol)) continue
          const key = `${uid}|${event.symbol}|${event.start}|${event.lead}`
          try {
          if (!commit && !(await claim(key, clock(), { uid, settings: s }))) continue
          const current = getSettings()[uid]
          if (!current?.enabled || current.since !== s.since || !allowed(uid, event.symbol)) continue
          if (states[event.symbol].checkedAt && clock() - states[event.symbol].checkedAt > 90000) continue
          // A slow earlier delivery must not turn a pre-close reminder into an after-close one.
          if (clock() - event.at >= (event.lead ? 60000 : DELIVERY_WINDOW)) continue
          if (commit) await commit(key, uid, h4Message(event), { event, settings: s })
          else await deliver(uid, h4Message(event), { event, settings: s })
          } catch (e) { onError(`[h4] ${e.message}`) }
        }
      }
    } catch (e) { onError(`[h4] ${e.message}`) }
    finally { busy = false }
  }
}
