// Display only. Never used for alert triggering or broker freshness validation.
(() => {
  let clockMinute = -1, weekend = false
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
  function weeklyClosed(now) {
    const minute = Math.floor(now / 60000)
    if (minute !== clockMinute) {
      clockMinute = minute
      const parts = Object.fromEntries(ny.formatToParts(new Date(now)).map(p => [p.type, p.value]))
      const hour = Number(parts.hour)
      weekend = parts.weekday === 'Sat' || parts.weekday === 'Fri' && hour >= 17 || parts.weekday === 'Sun' && hour < 17
    }
    return weekend
  }
  window.quoteState = (symbol, q, now = Date.now()) => {
    const fresh = q && !q.stale && q.tradeable && Number.isFinite(q.dataTs) && Number.isFinite(q.observedAt) && now - q.dataTs <= 30000 && now - q.observedAt <= 30000
    if (fresh) return 'streaming'
    // Ignore an old cached CLOSED flag after reopening; use the latest broker response.
    if (q?.marketStatus === 'CLOSED' && Number.isFinite(q.observedAt) && now - q.observedAt < 90000) return 'market closed'
    if (['EURUSD','GBPUSD','DXY','XAUUSD','XAGUSD','GER40'].includes(symbol) && weeklyClosed(now)) return 'market closed'
    return q ? 'reconnecting' : 'loading quote'
  }
})()
