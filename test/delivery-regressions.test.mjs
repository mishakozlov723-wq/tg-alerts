import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

const uid = '12345', admin = '99999'
function fixture(main, now) {
  const db = new DatabaseSync(':memory:')
  const store = createLocalStore({ sql: { exec: (q, ...a) => db.prepare(q).all(...a) }, transactionSync: fn => {
    db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e }
  } })
  store.initialize({ main: { ...emptyMain(), ...main } })
  let response = 'ok', retry = 5, failMethod = '', articles = []
  const calls = []
  const env = { LOCAL_STORE: store, BOT_TOKEN: 'artificial-token', ADMIN_CHAT_ID: admin, PRICE_SOURCE: 'mock', FETCH: async (input, options) => {
    const url = new URL(input)
    if (url.hostname === 'api.telegram.org') {
      const method = url.pathname.split('/').at(-1), payload = JSON.parse(options.body)
      calls.push({ method, payload })
      if (method === failMethod) throw new Error('artificial callback failure')
      if (method === 'sendMessage') {
        if (response === 'timeout') throw new Error('ambiguous timeout')
        if (response !== 'ok') return Response.json({ ok: false, error_code: Number(response), parameters: { retry_after: retry } }, { status: Number(response) })
      }
      return Response.json({ ok: true, result: true })
    }
    if (url.hostname === 'demo-api-capital.backend-capital.com') {
      if (url.pathname.endsWith('/session')) return Response.json({}, { headers: { cst: 'fixture', 'x-security-token': 'fixture' } })
      return Response.json({ marketDetails: ['GOLD', 'DE40', 'SILVER'].map(epic => ({ instrument: { epic }, snapshot: { bid: 100, offer: 101, marketStatus: 'TRADEABLE' } })) })
    }
    if (url.hostname.includes('faireconomy')) return Response.json(articles)
    throw new Error('No live network: ' + url.hostname)
  } }
  return { db, store, env, calls, main: async () => JSON.parse(await store.command(['GET', 'tg-alerts-db'])),
    setResponse: v => { response = v }, failMethod: v => { failMethod = v }, articles: v => { articles = v } }
}
test('price crossing queues a rejected notification and never fires it twice', async () => {
  const clock = Date.now; let now = clock(); Date.now = () => now
  const f = fixture({ alerts: [{ id: 1, userId: uid, symbol: 'XAUUSD', dir: 'above', level: 99, status: 'active' }], owned: { [uid]: ['XAUUSD'] }, seq: 2 })
  const env = { ...f.env, CAPITAL_API_KEY: 'fixture', CAPITAL_IDENTIFIER: 'fixture', CAPITAL_PASSWORD: 'fixture' }
  try {
    f.setResponse('429'); const engine = await createEngine(env); await engine.capital()
    let d = await f.main(); assert.equal(d.alerts[0].status, 'fired'); assert.equal(d.events[0].delivery, 'pending')
    await engine.capital(); assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1)
    now += 6000; f.setResponse('ok'); const restarted = await createEngine(env); await restarted.housekeeping(); await restarted.capital()
    d = await f.main(); assert.equal(d.events[0].delivery, 'sent'); assert.equal(d.events.length, 1)
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 2)
  } finally { Date.now = clock; f.db.close() }
})
const pending = () => ({ events: [{ id: 1, userId: uid, text: 'artificial alert', delivery: 'pending' }], seq: 2 })
for (const code of ['429', '502']) test(`Telegram ${code} stays pending, respects delay and survives restart`, async () => {
  const clock = Date.now; let now = clock(); Date.now = () => now
  const f = fixture(pending())
  try {
    f.setResponse(code)
    await (await createEngine(f.env)).housekeeping()
    assert.equal((await f.main()).events[0].delivery, 'pending')
    assert.equal((await f.main()).events[0].retryAt, now + 5000)
    const before = f.calls.length
    await (await createEngine(f.env)).housekeeping()
    assert.equal(f.calls.length, before)
    now += 5001; f.setResponse('ok')
    await (await createEngine(f.env)).housekeeping()
    assert.equal((await f.main()).events[0].delivery, 'sent')
    const count = f.calls.length
    await (await createEngine(f.env)).housekeeping()
    assert.equal(f.calls.length, count)
  } finally { Date.now = clock; f.db.close() }
})
for (const [response, expected] of [['timeout', 'unknown'], ['403', 'failed']]) test(`${response} is not blindly retried`, async () => {
  const f = fixture(pending())
  try {
    f.setResponse(response); await (await createEngine(f.env)).housekeeping()
    assert.equal((await f.main()).events[0].delivery, expected)
    const count = f.calls.length
    await (await createEngine(f.env)).housekeeping(); assert.equal(f.calls.length, count)
  } finally { f.db.close() }
})
function payment() { return { orders: { 1: { id: 1, userId: uid, symbol: 'METALS', status: 'new' } }, seq: 2 } }
const paid = () => ({ callback_query: { id: 'fake', from: { id: Number(uid) }, data: 'paid:1', message: { chat: { id: Number(uid) }, message_id: 10 } } })
for (const method of ['answerCallbackQuery', 'editMessageText']) test(`payment reaches admin despite ${method} failure; repeat is deduplicated`, async () => {
  const f = fixture(payment())
  try {
    f.failMethod(method); await assert.rejects((await createEngine(f.env)).update(paid()))
    const d = await f.main(); assert.equal(d.orders[1].status, 'paid'); assert.equal(d.events[0].delivery, 'sent')
    assert.equal(f.calls[0].method, 'sendMessage'); assert.equal(f.calls[0].payload.chat_id, admin)
    assert.equal(f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'ok:1')
    f.failMethod(''); await (await createEngine(f.env)).update(paid())
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1)
  } finally { f.db.close() }
})
test('payment queued on 429 retries with approval buttons after restart', async () => {
  const clock = Date.now; let now = clock(); Date.now = () => now; const f = fixture(payment())
  try {
    f.setResponse('429'); await (await createEngine(f.env)).update(paid())
    assert.equal((await f.main()).events[0].delivery, 'pending')
    now += 6000; f.setResponse('ok'); await (await createEngine(f.env)).housekeeping()
    assert.equal((await f.main()).events[0].delivery, 'sent')
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').at(-1).payload.reply_markup.inline_keyboard[0][1].callback_data, 'no:1')
  } finally { Date.now = clock; f.db.close() }
})
test('news catches up beyond 90 seconds, coalesces leads, never sends past events or duplicates', async () => {
  const now = Date.now(), f = fixture({ settings: { [uid]: { lead: [15, 5], currencies: ['USD'] } } })
  f.articles([{ impact: 'High', country: 'USD', title: 'Delayed news', date: new Date(now + 2 * 60000).toISOString() }, { impact: 'High', country: 'USD', title: 'Past news', date: new Date(now - 60000).toISOString() }])
  try {
    await (await createEngine(f.env)).housekeeping()
    const sends = f.calls.filter(c => c.method === 'sendMessage')
    assert.equal(sends.length, 1); assert.match(sends[0].payload.text, /Delayed news\nIn 2 min/)
    assert.equal(Object.keys((await f.main()).sentNews).length, 2)
    await (await createEngine(f.env)).housekeeping()
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1)
  } finally { f.db.close() }
})
test('queued news expires instead of sending after release time', async () => {
  const f = fixture({ events: [{ id: 1, userId: uid, text: 'Old news', delivery: 'pending', expiresAt: Date.now() - 1 }], seq: 2 })
  try { await (await createEngine(f.env)).housekeeping(); assert.equal((await f.main()).events[0].delivery, 'expired'); assert.equal(f.calls.length, 0) } finally { f.db.close() }
})
