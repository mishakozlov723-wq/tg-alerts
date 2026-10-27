// Notification hysteresis is separate from the strict 30s trading freshness gate.
// Each instrument owns its own timer. State and notices commit with the outbox.
export const FEED_WARNING_DELAY_MS = 3 * 60 * 1000
export function feedNoticeText(kind, symbols) {
  return kind === 'warning'
    ? `⚠️ Fresh quotes unavailable for ${symbols.join(', ')} for at least 3 minutes. Alerts on these instruments wait for fresh quotes; other instruments continue normally.`
    : `✅ Fresh quotes restored for ${symbols.join(', ')}. Price alerts on these instruments are operating again.`
}
export function sampleFeedWatch(state, { now, open, recipients }) {
  const messages = [], before = JSON.stringify(state)
  for (const uid of new Set([...Object.keys(state), ...Object.keys(recipients)])) {
    const symbols = recipients[uid], s = state[uid] ||= { lastWarning: 0 }
    if (!symbols || !Object.keys(symbols).length) {
      for (const k of ['badSince','goodSince','badBySymbol','goodBySymbol','announced','symbols']) delete s[k]
      if (now - s.lastWarning >= 3600000) delete state[uid]
      continue
    }
    // Legacy shared badSince is deliberately NOT assigned to a new instrument.
    delete s.badSince; delete s.goodSince
    s.badBySymbol ||= {}; s.goodBySymbol ||= {}
    s.symbols = (s.symbols || []).filter(symbol => Object.hasOwn(symbols,symbol))
    if (!open) { s.badBySymbol = {}; s.goodBySymbol = {}; continue }
    const stale = Object.keys(symbols).filter(symbol => !symbols[symbol]).sort()
    for (const symbol of Object.keys(s.badBySymbol)) if (!stale.includes(symbol)) delete s.badBySymbol[symbol]
    for (const symbol of stale) s.badBySymbol[symbol] ??= now
    const due = stale.filter(symbol => !s.symbols.includes(symbol) && now - s.badBySymbol[symbol] >= FEED_WARNING_DELAY_MS)
    if (due.length && (!s.lastWarning || now - s.lastWarning >= 3600000)) {
      s.lastWarning = now; s.symbols = [...new Set([...s.symbols,...due])].sort()
      messages.push({ userId: uid, kind: 'warning', symbols: due, text: feedNoticeText('warning',due) })
    }
    const recovered = []
    for (const symbol of s.symbols) {
      if (!symbols[symbol]) { delete s.goodBySymbol[symbol]; continue }
      s.goodBySymbol[symbol] ??= now
      if (now - s.goodBySymbol[symbol] >= 30000) recovered.push(symbol)
    }
    if (recovered.length) {
      messages.push({userId:uid,kind:'recovery',symbols:recovered,text:feedNoticeText('recovery',recovered)})
      s.symbols = s.symbols.filter(symbol => !recovered.includes(symbol))
    }
    for (const symbol of Object.keys(s.goodBySymbol)) if (!s.symbols.includes(symbol)) delete s.goodBySymbol[symbol]
    if (s.symbols.length) s.announced = true
    else { delete s.announced; delete s.symbols }
  }
  return { messages, changed: before !== JSON.stringify(state) }
}
