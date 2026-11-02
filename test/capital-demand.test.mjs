// Capital is polled per symbol: every cycle only while in demand and tradeable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createQuoteFeed } from '../cloudflare/quotes.mjs'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

const credentials = { CAPITAL_API_KEY: 'fixture', CAPITAL_IDENTIFIER: 'fixture', CAPITAL_PASSWORD: 'fixture', CAPITAL_EPIC_DXY: 'DXFIXTURE' }
const epics = { DXY: 'DXFIXTURE', GER40: 'DE40', XAUUSD: 'GOLD', XAGUSD: 'SILVER' }
function broker(status = {}) {
  const searches = []
  const FETCH = async input => {
    const u = new URL(input)
    if (u.pathname.endsWith('/session')) return Response.json({}, { headers: { cst: 'fixture', 'x-security-token': 'fixture' } })
    if (u.hostname.includes('capital')) {
      const term = u.searchParams.get('searchTerm'); searches.push(term)
      return Response.json({ markets: Object.entries(epics).map(([s, epic]) => ({ epic, bid: 100, offer: 101, marketStatus: status[s] || 'TRADEABLE', updateTimeUTC: new Date(Date.now()).toISOString() })) })
    }
    throw new Error('Unexpected network: ' + u.hostname)
  }
  const symbolOf = term => ({ 'Dollar Index': 'DXY', 'Germany 40': 'GER40', GOLD: 'XAUUSD', SILVER: 'XAGUSD' })[term]
  return { FETCH, searches, polled: () => searches.map(symbolOf) }
}
const count = (list, s) => list.filter(x => x === s).length

test('Capital polls hot symbols every cycle, cold ones every 60 s, closed ones every 30/300 s', async () => {
  const clock = Date.now; let now = Date.parse('2026-10-21T12:00:00Z'); Date.now = () => now
  try {
    const b = broker({ XAGUSD: 'CLOSED', GER40: 'CLOSED' }), feed = createQuoteFeed({ ...credentials, FETCH: b.FETCH })
    const demand = new Set(['XAUUSD', 'GER40'])
    await feed.capital(null, undefined, demand) // the first cycle seeds every symbol
    assert.deepEqual([...b.polled()].sort(), ['DXY', 'GER40', 'XAGUSD', 'XAUUSD'])
    b.searches.length = 0
    for (let i = 0; i < 10; i++) { now += 1500; await feed.capital(null, undefined, demand) } // 15 s
    assert.deepEqual(b.polled(), Array(10).fill('XAUUSD'), 'only the hot tradeable symbol is polled every cycle')
    b.searches.length = 0
    for (let i = 0; i < 40; i++) { now += 1500; await feed.capital(null, undefined, demand) } // 75 s total
    const p = b.polled()
    assert.equal(count(p, 'XAUUSD'), 40)
    assert.equal(count(p, 'DXY'), 1, 'cold tradeable symbol: once per minute')
    assert.equal(count(p, 'GER40'), 2, 'hot but closed symbol: every 30 s')
    assert.equal(count(p, 'XAGUSD'), 0, 'cold closed symbol: every 5 minutes')
    now += 300000; b.searches.length = 0; await feed.capital(null, undefined, demand)
    assert.deepEqual([...b.polled()].sort(), ['DXY', 'GER40', 'XAGUSD', 'XAUUSD'])
    // Diagnostics keep the last result of symbols that were not polled this cycle.
    now += 1500; await feed.capital(null, undefined, demand)
    const d = feed.status().capitalDiagnostics
    assert.deepEqual(Object.keys(d.quotes).sort(), ['DXY', 'GER40', 'XAGUSD', 'XAUUSD'])
    assert.equal(d.quotes.XAGUSD.marketStatus, 'CLOSED'); assert.equal(d.quotes.DXY.reason, 'fresh')
    assert.equal(feed.status().capitalSchedule.coldOpenMs, 60000)
    // Without a demand set (probe, direct callers) every symbol is polled at once.
    b.searches.length = 0; await feed.capital(null)
    assert.equal(b.searches.length, 4)
  } finally { Date.now = clock }
})

test('nothing due means no Capital request and no diagnostic churn', async () => {
  const clock = Date.now; let now = Date.parse('2026-10-21T12:00:00Z'); Date.now = () => now
  try {
    const b = broker(), feed = createQuoteFeed({ ...credentials, FETCH: b.FETCH })
    await feed.capital(null, undefined, new Set())
    const attempt = feed.status().capitalDiagnostics.lastAttemptAt
    b.searches.length = 0; now += 1500
    await feed.capital(null, undefined, new Set())
    assert.equal(b.searches.length, 0); assert.equal(feed.status().capitalDiagnostics.lastAttemptAt, attempt)
    assert.equal(feed.status().capitalDiagnostics.stage, 'ok')
  } finally { Date.now = clock }
})

test('OANDA REST reconciliation slows down while the FX session is closed', async () => {
  const clock = Date.now; let now = Date.parse('2026-10-24T12:00:00Z'), pricing = 0; Date.now = () => now // Saturday
  try {
    const feed = createQuoteFeed({ OANDA_TOKEN: 'fixture', OANDA_ACCOUNT: 'fixture', FETCH: async url => {
      if (url.endsWith('/instruments')) return Response.json({ instruments: [] })
      if (url.includes('/pricing?')) { pricing++; return Response.json({ prices: [] }) }
      throw new Error('Unexpected network')
    } })
    await feed.refresh(); assert.equal(pricing, 1)
    now += 21000; await feed.refresh(); assert.equal(pricing, 1)
    now += 100000; await feed.refresh(); assert.equal(pricing, 2)
    now = Date.parse('2026-10-26T12:00:00Z'); await feed.refresh(); assert.equal(pricing, 3) // Monday
    now += 21000; await feed.refresh(); assert.equal(pricing, 4)
  } finally { Date.now = clock }
})

const SECRET = 'artificial-signing-secret', uid = '12345'
const sign = user => { const b = Buffer.from(JSON.stringify({ sub: user, project: 'alerts', iat: Date.now(), exp: Date.now() + 600000 })).toString('base64url'); return b + '.' + createHmac('sha256', SECRET).update(b).digest('hex') }
function local(main) {
  const db = new DatabaseSync(':memory:')
  const store = createLocalStore({ sql: { exec: (q, ...a) => db.prepare(q).all(...a) }, transactionSync: fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } })
  store.initialize({ main: { ...emptyMain(), ...main } })
  return { db, store }
}

test('engine demand: active alerts and open screens make Capital symbols hot; monitor ignores cold ones', async () => {
  const clock = Date.now; let now = Date.parse('2026-10-28T12:00:00Z'); Date.now = () => now
  const { db, store } = local({ owned: { [uid]: ['XAUUSD', 'XAGUSD', 'GER40', 'DXY'] }, alerts: [{ id: 1, userId: uid, symbol: 'GER40', dir: 'above', level: 1000, status: 'active' }], seq: 2 })
  try {
    const b = broker(), sent = []
    const FETCH = async (input, init) => {
      const u = new URL(input)
      if (u.hostname === 'api.telegram.org') { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } }) }
      return b.FETCH(input, init)
    }
    const core = await createEngine({ ...credentials, LOCAL_STORE: store, FETCH, ACCESS_SIGNING_SECRET: SECRET, PRICE_SOURCE: 'oanda', BOT_TOKEN: 'artificial', ADMIN_CHAT_ID: '99999', MONITOR_ALERTS: 'false', AUTH_API_URL: '' })
    await core.capital()
    b.searches.length = 0; now += 1500; await core.capital()
    assert.deepEqual(b.polled(), ['GER40'], 'the alert symbol stays hot')
    const r = await core.http(new Request('https://local/api/prices', { headers: { 'x-access-token': sign(uid) } }))
    assert.equal(r.status, 200)
    b.searches.length = 0; now += 1500; await core.capital()
    assert.deepEqual([...b.polled()].sort(), ['DXY', 'GER40', 'XAGUSD', 'XAUUSD'], 'an open screen makes every shown symbol hot')
    now += 31000; b.searches.length = 0; await core.capital()
    assert.deepEqual(b.polled(), ['GER40'], 'the screen demand expires')
    // The status page does not report cold, rarely polled symbols as an outage.
    await core.update({ callback_query: { id: 'q', from: { id: 99999 }, data: 'status:quotes', message: { chat: { id: 99999, type: 'private' } } } })
    const text = sent.map(x => x.text || '').join('\n')
    assert.match(text, /XAUUSD: .*опрашивается реже/)
    assert.doesNotMatch(text, /GER40: .*опрашивается реже/)
  } finally { Date.now = clock; db.close() }
})
