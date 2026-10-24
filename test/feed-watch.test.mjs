import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { sampleFeedWatch } from '../cloudflare/feed-watch.mjs'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

function watcher() {
 let state = {}, now = 100000
 return {
  sample(fresh, open = true) { return sampleFeedWatch(state, {now, open, recipients: {'1': {EURUSD: fresh, GBPUSD: true}}}).messages },
  advance(ms) { now += ms },
  restart() { state = JSON.parse(JSON.stringify(state)) },
 }
}
test('short stale episodes are silent; durable outage and sustained recovery produce one pair', () => {
 const w = watcher()
 assert.deepEqual(w.sample(false), [])
 w.advance(10000); assert.deepEqual(w.sample(true), [])
 w.advance(10000); assert.deepEqual(w.sample(false), [])
 w.advance(59000); assert.deepEqual(w.sample(false), [])
 w.advance(1000); const warnings = w.sample(false)
 assert.equal(warnings.length, 1); assert.match(warnings[0].text, /EURUSD/)
 assert.doesNotMatch(warnings[0].text, /GBPUSD/)
 w.restart(); w.advance(10000); assert.deepEqual(w.sample(false), [])
 assert.deepEqual(w.sample(true), [])
 w.advance(29000); assert.deepEqual(w.sample(true), [])
 w.advance(1000); assert.equal(w.sample(true)[0].kind, 'recovery')
 assert.deepEqual(w.sample(true), [])
 // Repeated pairs are bounded across engine recreation, not just admin pushes.
 w.restart(); w.advance(1000); w.sample(false)
 w.advance(61000); assert.deepEqual(w.sample(false), [])
 w.advance(3600000); assert.equal(w.sample(false)[0].kind, 'warning')
})
test('recovery must stay fresh; closure and removed alerts do not pretend to be recovery', () => {
 const w = watcher(); w.sample(false); w.advance(60000); w.sample(false)
 w.sample(true); w.advance(20000); w.sample(false)
 w.advance(20000); assert.deepEqual(w.sample(true), [])
 w.advance(20000); assert.deepEqual(w.sample(true, false), [])
 w.advance(60000); assert.deepEqual(w.sample(true), [])
 w.advance(30000); assert.equal(w.sample(true)[0].kind, 'recovery')
 const state = {'1': {announced: true, symbols: ['EURUSD'], lastWarning: 100000}}
 assert.deepEqual(sampleFeedWatch(state, {now: 200000, open: true, recipients: {}}).messages, [])
 assert.equal(state['1'].announced, undefined)
})

async function fixture() {
 const clock = Date.now; let now = Date.parse('2026-10-21T12:00:00Z')
 Date.now = () => now
 const db = new DatabaseSync(':memory:')
 const store = createLocalStore({sql: {exec: (q,...a) => db.prepare(q).all(...a)}, transactionSync: fn => fn()})
 const main = emptyMain()
 main.alerts = [{id:1, userId:'1', symbol:'GBPUSD', level:2, dir:'reach', status:'active'}]; main.seq = 2
 store.initialize({main})
 let core, reject = false
 const sent = []
 const env = {LOCAL_STORE:store, PRICE_SOURCE:'oanda', OANDA_TOKEN:'artificial', OANDA_ACCOUNT:'fixture', BOT_TOKEN:'artificial', ADMIN_CHAT_ID:'1', MONITOR_ALERTS:'false', NEWS_SOURCE:'mock', FETCH:async (url, init) => {
  if (url.endsWith('/instruments')) return Response.json({instruments:[]})
  if (url.includes('/pricing?')) return Response.json({prices:[{instrument:'GBP_USD', time:new Date(now).toISOString(), tradeable:true, bids:[{price:'1.3'}], asks:[{price:'1.3'}]}]})
  if (url.includes('/sendMessage')) {
   if (reject) return Response.json({ok:false, error_code:429, parameters:{retry_after:60}}, {status:429})
   sent.push(JSON.parse(init.body)); return Response.json({ok:true})
  }
  throw new Error('Unexpected test request')
 }}
 core = await createEngine(env)
 return {
  sent, advance(ms) {now += ms}, set reject(v) {reject=v},
  async refresh() {await core.refreshQuotes()}, async check() {await core.housekeeping()},
  async flush() {await core.flushEvents()},
  async restart() {core = await createEngine(env)},
  async main() {return JSON.parse(await store.command(['GET','tg-alerts-db']))},
  close() {Date.now = clock; db.close()},
 }
}
test('real core/outbox deduplicates owner, persists cooldown, and leaves strict trading freshness unchanged', async () => {
 const f = await fixture()
 try {
  await f.refresh(); f.advance(31000); await f.check(); assert.equal(f.sent.length,0)
  f.advance(60000); await f.check(); assert.equal(f.sent.length,1)
  assert.match(f.sent[0].text,/⚠️.*GBPUSD/)
  assert.equal((await f.main()).alerts[0].status,'active')
  await f.restart(); f.advance(21000); await f.refresh(); await f.check()
  f.advance(30000); await f.refresh(); await f.check(); assert.equal(f.sent.length,2)
  assert.match(f.sent[1].text,/✅/)
  f.advance(31000); await f.check(); f.advance(60000); await f.check()
  assert.equal(f.sent.length,2)
 } finally {f.close()}
})
test('independent delivery cancels a warning after fresh quotes, without housekeeping', async () => {
 const f = await fixture()
 try {
  f.advance(31000); await f.check(); f.reject = true
  f.advance(60000); await f.check()
  assert.equal((await f.main()).events[0].delivery, 'pending')
  f.reject = false; f.advance(60000); await f.refresh(); await f.flush()
  assert.equal(f.sent.length, 0)
  assert.equal((await f.main()).events[0].delivery, 'expired')
 } finally {f.close()}
})
test('independent delivery cancels recovery when quotes go stale again', async () => {
 const f = await fixture()
 try {
  f.advance(31000); await f.check(); f.advance(60000); await f.check()
  assert.equal(f.sent.length, 1)
  await f.refresh(); await f.check()
  f.advance(30000); await f.refresh(); f.reject = true; await f.check()
  assert.equal((await f.main()).events.at(-1).delivery, 'pending')
  f.reject = false; f.advance(60000); await f.flush()
  assert.equal(f.sent.length, 1)
  assert.equal((await f.main()).events.at(-1).delivery, 'expired')
 } finally {f.close()}
})
test('warning rejected by Telegram is cancelled on recovery; no obsolete warning or orphan recovery', async () => {
 const f = await fixture()
 try {
  f.advance(31000); await f.check(); f.reject = true
  f.advance(60000); await f.check(); assert.equal(f.sent.length,0)
  assert.equal((await f.main()).events[0].delivery,'pending')
  f.reject = false; f.advance(21000); await f.refresh(); await f.check()
  assert.equal((await f.main()).events[0].delivery,'expired')
  f.advance(30000); await f.refresh(); await f.check(); assert.equal(f.sent.length,0)
 } finally {f.close()}
})
