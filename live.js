import crypto from 'node:crypto'
import { normalizeLive, LIVE_GRACE_MS } from './public/live-time.js'
import { LiveConflict } from './live-store.js'
const uuid = () => crypto.randomUUID()
export const liveIdValid = (id) => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
export function newReminder(uid, id, input, now = Date.now()) {
  if (!liveIdValid(id)) throw new Error('Invalid reminder ID')
  const { config, schedule } = normalizeLive(input, now)
  return { id, userId: uid, config, enabled: true, createdAt: now, updatedAt: now, revision: uuid(),
    deliveries: schedule.map((at) => ({ at, status: 'pending' })) }
}
export function liveView(row, now = Date.now()) {
  const outcomes = row.deliveries.map((d) => ({ ...d, status: d.status === 'pending' && now - d.at >= LIVE_GRACE_MS ? 'missed' : d.status === 'attempting' && now - d.attemptedAt > 60000 ? 'unknown' : d.status }))
  const next = outcomes.find((d) => d.status === 'pending')?.at || null
  const attempted = outcomes.filter((d) => d.status !== 'pending')
  return { id: row.id, revision: row.revision, ...row.config, enabled: row.enabled, createdAt: row.createdAt,
    next, total: outcomes.length, sent: outcomes.filter((d) => d.status === 'sent').length,
    last: attempted.at(-1) || null, status: !row.enabled && next ? 'paused' : next ? 'active' : outcomes.some((d) => d.status === 'attempting') ? 'sending' : 'done' }
}
export function liveMessage(row, delivery, now) {
  const delayed = now - delivery.at > 60000
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: row.config.timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(delivery.at)
  return `🔔 Live\n${row.config.text}${delayed ? `\nDelayed · ${when} (${row.config.timezone})` : ''}`
}
export function createLiveRunner({ store, deliver, clock = Date.now, onError = console.error }) {
  let busy = false
  // Completion updates merge with a concurrent pause, without reviving edits/deletes.
  async function finish(uid, id, attempt, status, retryAfterMs = 10000) {
    for (let retry = 0; retry < 3; retry++) {
      const row = await store.read(uid, id)
      if (!row) return
      const index = row.deliveries.findIndex((d) => d.attempt === attempt && d.status === 'attempting')
      if (index < 0) return
      const value = structuredClone(row)
      value.deliveries[index].status = status
      if (status === 'pending') value.deliveries[index].retryAt = clock() + Math.max(1000, Number(retryAfterMs) || 10000)
      value.revision = uuid(); value.updatedAt = clock()
      try { await store.cas(uid, id, row, value); return } catch (e) { if (!(e instanceof LiveConflict)) throw e }
    }
    throw new Error('Could not confirm Live delivery status')
  }
  return async function run() {
    if (busy) return
    busy = true
    try {
      await store.refresh()
      for (const snapshot of store.all()) {
        try {
          let row = snapshot
          for (let i = 0; i < row.deliveries.length; i++) {
            const d = row.deliveries[i], now = clock()
            if (d.status === 'attempting' && now - d.attemptedAt > 60000) {
              await finish(row.userId, row.id, d.attempt, 'unknown'); continue
            }
            if (d.status !== 'pending' || d.at > now || (d.retryAt || 0) > now) continue
            if (now - d.at >= LIVE_GRACE_MS || !row.enabled) {
              const value = structuredClone(row); value.deliveries[i].status = 'missed'; value.revision = uuid()
              row = await store.cas(row.userId, row.id, row, value); continue
            }
            // Persist a claim BEFORE contacting Telegram. A timeout/crash is unknown,
            // never blindly retried (Telegram sendMessage has no idempotency key).
            const value = structuredClone(row), attempt = uuid()
            value.deliveries[i] = { ...d, status: 'attempting', attempt, attemptedAt: now }; value.revision = uuid()
            row = await store.cas(row.userId, row.id, row, value)
            const current = await store.read(row.userId, row.id)
            if (!current?.enabled || !current.deliveries.some((x) => x.attempt === attempt && x.status === 'attempting')) {
              await finish(row.userId, row.id, attempt, 'cancelled'); break
            }
            if (clock() - d.at >= LIVE_GRACE_MS) { await finish(row.userId, row.id, attempt, 'missed'); break }
            let status = 'sent', retryAfterMs = 10000
            try { await deliver(row.userId, liveMessage(row, d, clock())) }
            catch (e) {
              status = e.retrySafe ? 'pending' : e.definite ? 'failed' : 'unknown'
              retryAfterMs = e.retryAfterMs || 10000
              onError('[live] Telegram delivery ' + status)
            }
            await finish(row.userId, row.id, attempt, status, retryAfterMs)
            row = await store.read(row.userId, row.id)
            if (!row) break
          }
        } catch (e) { if (!(e instanceof LiveConflict)) onError('[live] ' + e.message) }
      }
    } catch (e) { onError('[live] ' + e.message) }
    finally { busy = false }
  }
}
