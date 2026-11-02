// The whole database is one stored value; records never read again are pruned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

function local(main) {
  const db = new DatabaseSync(':memory:')
  const store = createLocalStore({ sql: { exec: (q, ...a) => db.prepare(q).all(...a) }, transactionSync: fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } })
  store.initialize({ main: { ...emptyMain(), ...main } })
  return { db, store }
}

test('housekeeping prunes old news reminders and abandoned payment requests only', async () => {
  const clock = Date.now, now = Date.parse('2026-10-28T12:00:00Z'); Date.now = () => now
  const day = 86400000, iso = t => new Date(t).toISOString().replace('.000Z', '-04:00')
  const sentNews = {
    [`1|USD|Non-Farm Payrolls|${iso(now - 8 * day)}|15`]: 1,
    [`1|USD|CPI m/m|${iso(now - 6 * day)}|5`]: 1,
    [`2|EUR|Rate | Decision|${iso(now - 30 * day)}|5`]: 1,
    [`2|EUR|Future|${iso(now + day)}|15`]: 1,
    ['3|mock|Test|5|15']: 1,
  }
  const orders = {
    10: { id: 10, userId: '1', symbol: 'METALS', status: 'new', ts: now - 31 * day },
    11: { id: 11, userId: '1', symbol: 'INDICES', status: 'new', ts: now - 2 * day },
    12: { id: 12, userId: '2', symbol: 'METALS', status: 'paid', ts: now - 90 * day },
    13: { id: 13, userId: '3', symbol: 'METALS', status: 'approved', ts: now - 90 * day },
    14: { id: 14, userId: '4', symbol: 'METALS', status: 'declined', ts: now - 90 * day },
    15: { id: 15, userId: '5', symbol: 'METALS', status: 'new' },
  }
  const alerts = [{ id: 1, userId: '1', symbol: 'EURUSD', dir: 'above', level: 2, status: 'fired', firedAt: now - 400 * day },
    { id: 2, userId: '1', symbol: 'EURUSD', dir: 'reach', level: 3, status: 'active' }]
  const { db, store } = local({ sentNews, orders, alerts, seq: 20 })
  try {
    const core = await createEngine({ LOCAL_STORE: store, PRICE_SOURCE: 'mock', NEWS_SOURCE: 'mock', MONITOR_ALERTS: 'false', FETCH: async () => { throw new Error('No network') } })
    await core.housekeeping()
    const d = JSON.parse(await store.command(['GET', 'tg-alerts-db']))
    assert.deepEqual(Object.keys(d.sentNews).sort(), [`1|USD|CPI m/m|${iso(now - 6 * day)}|5`, `2|EUR|Future|${iso(now + day)}|15`, '3|mock|Test|5|15'].sort())
    assert.deepEqual(Object.keys(d.orders).sort(), ['11', '12', '13', '14', '15'])
    assert.deepEqual(d.alerts.map(a => a.id), [2], 'old fired alerts are purged once, active kept')
    assert.ok(d.firedPurgedV1, 'one-time purge is recorded')
  } finally { Date.now = clock; db.close() }
})

test('status reports the database size and warns near the single-value limit', async () => {
  const clock = Date.now, now = Date.parse('2026-10-28T12:00:00Z'); Date.now = () => now
  const big = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`${i}|USD|${'x'.repeat(150)}|2026-10-29T08:30:00-04:00|15`, 1]))
  for (const [main, level] of [[{}, 'ok'], [{ sentNews: big }, 'warn']]) {
    const { db, store } = local(main), sent = []
    try {
      const core = await createEngine({ LOCAL_STORE: store, PRICE_SOURCE: 'mock', NEWS_SOURCE: 'mock', BOT_TOKEN: 'artificial', ADMIN_CHAT_ID: '99999', MONITOR_ALERTS: 'false', AUTH_API_URL: '',
        FETCH: async (input, init) => { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } }) } })
      await core.update({ callback_query: { id: 'q', from: { id: 99999 }, data: 'status:all', message: { chat: { id: 99999, type: 'private' } } } })
      const state = JSON.parse(await store.command(['GET', 'tg-alerts:monitor:v1']))
      assert.equal(state.parts.storage.level, level)
      assert.match(state.parts.storage.detail, /Размер базы: \d+\.\d\d МБ/)
    } finally { db.close() }
  }
  Date.now = clock
})
