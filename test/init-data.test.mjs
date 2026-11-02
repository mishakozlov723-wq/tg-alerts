// The Telegram initData sign-in is used only without Access (REQUIRE_ACCESS off).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from '../cloudflare/core.mjs'
import { createLocalStore, emptyMain } from '../cloudflare/storage.mjs'

const BOT = '123456:artificial-token'
function initData(fields, token = BOT) {
  const p = new URLSearchParams(fields)
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'))
  return p.toString()
}
test('initData sign-in needs a valid signature and a fresh auth_date', async () => {
  const db = new DatabaseSync(':memory:')
  const store = createLocalStore({ sql: { exec: (q, ...a) => db.prepare(q).all(...a) }, transactionSync: fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } } })
  store.initialize({ main: emptyMain() })
  try {
    const engine = await createEngine({ LOCAL_STORE: store, BOT_TOKEN: BOT, PRICE_SOURCE: 'mock', MONITOR_ALERTS: 'false', ADMIN_CHAT_ID: '99999', FETCH: async () => { throw new Error('No live network') } })
    const check = async init => (await engine.http(new Request('https://local/api/access/check', { headers: { 'x-init-data': init } }))).status
    const now = Math.floor(Date.now() / 1000), user = JSON.stringify({ id: 12345 })
    assert.equal(await check(initData({ auth_date: String(now), user })), 200)
    assert.equal(await check(initData({ auth_date: String(now - 2 * 86400), user })), 401, 'Older than 24 h')
    assert.equal(await check(initData({ auth_date: String(now + 3600), user })), 401, 'From the future')
    assert.equal(await check(initData({ user })), 401, 'No auth_date')
    assert.equal(await check(initData({ auth_date: String(now), user }, '654321:other-bot')), 401, 'Signed for another bot')
    assert.equal(await check(`auth_date=${now}&user=${encodeURIComponent(user)}&hash=not-hex`), 401, 'Malformed hash does not throw')
  } finally { db.close() }
})
