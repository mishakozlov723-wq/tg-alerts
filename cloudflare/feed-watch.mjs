// Notification hysteresis is separate from the strict 30s trading freshness gate.
// Mutations are committed with the outbox by the caller before any network send.
export const FEED_WARNING_DELAY_MS = 3 * 60 * 1000

export function sampleFeedWatch(state, { now, open, recipients }) {
  const messages = []
  const before = JSON.stringify(state)
  for (const uid of new Set([...Object.keys(state), ...Object.keys(recipients)])) {
    const symbols = recipients[uid]
    const s = state[uid] ||= { lastWarning: 0 }
    if (!symbols || !Object.keys(symbols).length) {
      delete s.badSince; delete s.goodSince; delete s.announced; delete s.symbols
      // Keep only the cooldown, and eventually prune departed recipients.
      if (now - s.lastWarning >= 3600000) delete state[uid]
      continue
    }
    // A scheduled closure is not evidence of either failure or recovery.
    if (!open) { delete s.badSince; delete s.goodSince; continue }
    const stale = Object.keys(symbols).filter(symbol => !symbols[symbol]).sort()
    if (stale.length) {
      delete s.goodSince
      s.badSince ??= now
      if (!s.announced && now - s.badSince >= FEED_WARNING_DELAY_MS && (!s.lastWarning || now - s.lastWarning >= 3600000)) {
        s.announced = true; s.lastWarning = now; s.symbols = stale
        messages.push({ userId: uid, kind: 'warning', text: `⚠️ Fresh quotes unavailable for ${stale.join(', ')} for at least 3 minutes. Alerts on these instruments wait for fresh quotes; other instruments continue normally.` })
      }
    } else {
      delete s.badSince
      if (!s.announced) { delete s.goodSince; continue }
      s.goodSince ??= now
      if (now - s.goodSince >= 30000) {
        messages.push({ userId: uid, kind: 'recovery', text: `✅ Fresh quotes restored for ${s.symbols.join(', ')}. Price alerts on your active instruments are operating again.` })
        delete s.announced; delete s.goodSince; delete s.symbols
      }
    }
  }
  return { messages, changed: before !== JSON.stringify(state) }
}
