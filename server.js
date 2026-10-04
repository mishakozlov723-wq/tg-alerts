import './env.js'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SYMBOLS, prices, startPrices, setPrice } from './prices.js'
import { getNews } from './news.js'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const BOT_TOKEN = process.env.BOT_TOKEN || ''
const MOCK = (process.env.PRICE_SOURCE || 'mock') === 'mock'
const DB_FILE = process.env.DB_FILE || path.join(__dir, 'data.json')

// ---------- простая JSON-база ----------
let db = { alerts: [], settings: {}, events: [], sentNews: {}, seq: 1 }
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) } } catch {}

// Бесплатный хостинг теряет файлы при перезапуске, поэтому алерты можно хранить в Upstash Redis (бесплатно).
// Если UPSTASH_* не заданы, работает обычный файл data.json.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '')
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN)
const REDIS_KEY = 'tg-alerts-db'
const redis = async (cmd) => {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`)
  return (await r.json()).result
}
if (USE_REDIS) {
  try {
    const raw = await redis(['GET', REDIS_KEY])
    if (raw) db = { ...db, ...JSON.parse(raw) }
    console.log('[db] алерты хранятся в Upstash Redis')
  } catch (e) {
    // если не прочитали, не стартуем, чтобы не затереть базу пустой
    console.error('[db] не удалось прочитать базу из Redis:', e.message)
    process.exit(1)
  }
}
let saving = false, dirty = false
const flush = async () => {
  if (saving) return
  saving = true
  while (dirty) {
    dirty = false
    try { await redis(['SET', REDIS_KEY, JSON.stringify(db)]) } catch (e) {
      console.error('[db] запись в Redis не удалась, повторяю:', e.message)
      dirty = true
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  saving = false
}
const save = () => {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)) } catch {}
  if (USE_REDIS) { dirty = true; flush() }
}
const defaultSettings = () => ({ lead: [15, 5], currencies: ['USD', 'EUR', 'GBP'] })

// ---------- уведомления ----------
async function notify(userId, text) {
  db.events.push({ id: db.seq++, userId, text, ts: Date.now() })
  if (db.events.length > 500) db.events.splice(0, db.events.length - 500)
  save()
  console.log(`[notify ${userId}] ${text}`)
  if (BOT_TOKEN && /^\d+$/.test(userId)) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text }),
      })
    } catch (e) { console.error('[telegram]', e.message) }
  }
}

// ---------- проверка алертов на каждый тик ----------
function onTick(sym, price) {
  let changed = false
  for (const a of db.alerts) {
    if (a.status !== 'active' || a.symbol !== sym) continue
    const hit = a.dir === 'above' ? price >= a.level : price <= a.level
    if (!hit) continue
    a.status = 'fired'; a.firedAt = Date.now(); a.firedPrice = price; changed = true
    notify(a.userId, `🔔 ${sym} ${a.dir} ${a.level} (price ${price})`)
  }
  if (changed) save()
}

// ---------- уведомления о новостях ----------
async function checkNews() {
  const items = await getNews()
  const now = Date.now()
  for (const userId of Object.keys(db.settings)) {
    const s = db.settings[userId]
    for (const n of items) {
      if (!s.currencies.includes(n.currency)) continue
      const minsLeft = (n.time - now) / 60000
      for (const lead of s.lead) {
        if (minsLeft > lead || minsLeft <= lead - 1.5) continue
        const key = `${userId}|${n.id}|${lead}`
        if (db.sentNews[key]) continue
        db.sentNews[key] = 1
        const extra = n.forecast || n.previous ? `\nForecast: ${n.forecast || '-'} · Prev: ${n.previous || '-'}` : ''
        await notify(userId, `🔴 ${n.currency} ${n.title}\nIn ${lead} min${extra}`)
      }
    }
  }
}

// ---------- авторизация: Telegram initData или браузер ----------
function getUserId(req) {
  const init = req.headers['x-init-data']
  if (init && BOT_TOKEN) {
    const p = new URLSearchParams(init)
    const hash = p.get('hash'); p.delete('hash')
    const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex')
    if (calc === hash) { try { return String(JSON.parse(p.get('user')).id) } catch {} }
    return null
  }
  // без токена (режим теста в браузере)
  if (!BOT_TOKEN) return String(req.headers['x-user-id'] || 'browser')
  return null
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(JSON.parse(d || '{}')) } catch { ok({}) } }) })
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok') }
  if (!p.startsWith('/api/')) {
    const f = path.join(__dir, 'public', p === '/' ? 'index.html' : p)
    if (!f.startsWith(path.join(__dir, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'text/plain' })
    return res.end(fs.readFileSync(f))
  }

  if (p === '/api/config') return json(res, 200, { mock: MOCK, symbols: Object.fromEntries(Object.entries(SYMBOLS).map(([k, v]) => [k, { pip: v.pip, digits: v.digits }])) })
  if (p === '/api/prices') return json(res, 200, prices)
  if (p === '/api/news') return json(res, 200, await getNews())

  const uid = getUserId(req)
  if (!uid) return json(res, 401, { error: 'unauthorized' })

  if (p === '/api/alerts' && req.method === 'GET') return json(res, 200, db.alerts.filter((a) => a.userId === uid).reverse())
  if (p === '/api/alerts' && req.method === 'POST') {
    const b = await body(req)
    const level = Number(b.level)
    if (!SYMBOLS[b.symbol] || !['above', 'below'].includes(b.dir) || !isFinite(level)) return json(res, 400, { error: 'bad input' })
    const a = { id: db.seq++, userId: uid, symbol: b.symbol, dir: b.dir, level, status: 'active', createdAt: Date.now() }
    db.alerts.push(a); save(); return json(res, 200, a)
  }
  const del = p.match(/^\/api\/alerts\/(\d+)$/)
  if (del && req.method === 'DELETE') {
    db.alerts = db.alerts.filter((a) => !(a.id === Number(del[1]) && a.userId === uid)); save(); return json(res, 200, { ok: true })
  }
  if (p === '/api/settings') {
    if (req.method === 'POST') {
      const b = await body(req)
      db.settings[uid] = { lead: (b.lead || []).map(Number).filter(Boolean), currencies: b.currencies || [] }; save()
    }
    if (!db.settings[uid]) { db.settings[uid] = defaultSettings(); save() }
    return json(res, 200, db.settings[uid])
  }
  if (p === '/api/events') {
    const since = Number(url.searchParams.get('since') || 0)
    return json(res, 200, db.events.filter((e) => e.userId === uid && e.id > since))
  }
  // только в тестовом режиме: двигать цену вручную
  if (p === '/api/debug/move' && MOCK) {
    const b = await body(req)
    const c = SYMBOLS[b.symbol]; if (!c || !prices[b.symbol]) return json(res, 400, { error: 'bad' })
    setPrice(b.symbol, prices[b.symbol].price + Number(b.pips) * c.pip, onTick)
    return json(res, 200, prices[b.symbol])
  }
  json(res, 404, { error: 'not found' })
})

startPrices(onTick)
setInterval(() => checkNews().catch((e) => console.error('[news]', e.message)), 20000)
server.listen(PORT, () => console.log(`Open in browser: http://localhost:${PORT}`))
