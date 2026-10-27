import './env.js'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SYMBOLS, prices, startPrices, setPrice, feedStatus } from './prices.js'
import { getNews } from './news.js'
import { verifyAccessToken } from './shared/access-token.mjs'
import { H4_ASSETS, normalizeH4Settings, createOandaH4, createH4Runner } from './h4.js'
import { createH4Store } from './h4-store.js'
import { createLiveStore, LiveConflict } from './live-store.js'
import { newReminder, editReminder, liveIdValid, liveView, createLiveRunner } from './live.js'

// Silver is a paid quote from Capital.com (epic can be changed with CAPITAL_EPIC_XAGUSD, shift with OFFSET_XAGUSD).
if (!SYMBOLS.XAGUSD) SYMBOLS.XAGUSD = { label: 'Silver', premium: true, pip: 0.01, digits: 3, base: 50, capital: process.env.CAPITAL_EPIC_XAGUSD || 'SILVER', offset: Number(process.env.OFFSET_XAGUSD || 0), duka: ['xagusd'] }
// DXY is a paid quote too (only EURUSD and GBPUSD are free). Its price is still computed from the OANDA pairs.
SYMBOLS.DXY.premium = true

const __dir = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const BOT_TOKEN = process.env.BOT_TOKEN || ''
const ACCESS_SIGNING_SECRET = process.env.ACCESS_SIGNING_SECRET || ''
const AUTH_API_URL = process.env.AUTH_API_URL || ''
const REQUIRE_ACCESS = process.env.REQUIRE_ACCESS === 'true' || Boolean(ACCESS_SIGNING_SECRET)
const MOCK = (process.env.PRICE_SOURCE || 'mock') === 'mock'
const DB_FILE = process.env.DB_FILE || path.join(__dir, 'data.json')
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '1011596614')
const PREMIUM_PRICE = Number(process.env.PREMIUM_PRICE_RUB || 350)
const PAY_DETAILS = process.env.PAY_DETAILS || ''

// ---------- simple JSON db ----------
let db = { alerts: [], settings: {}, events: [], sentNews: {}, seq: 1, owned: {}, orders: {} }
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) } } catch {}

// Free hosting loses files on restart, so alerts can be stored in Upstash Redis (free).
// If UPSTASH_* is not set, the plain data.json file is used.
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
  const reply = await r.json()
  if (reply.error) throw new Error('Redis command failed')
  return reply.result
}
if (USE_REDIS) {
  try {
    const raw = await redis(['GET', REDIS_KEY])
    if (raw) db = { ...db, ...JSON.parse(raw) }
    console.log('[db] alerts are stored in Upstash Redis')
  } catch (e) {
    // if the read failed, do not start so we never overwrite the db with an empty one
    console.error('[db] could not read the database from Redis:', e.message)
    process.exit(1)
  }
}
if (!db.owned) db.owned = {}
if (!db.orders) db.orders = {}
let saving = false, dirty = false
const flush = async () => {
  if (saving) return
  saving = true
  while (dirty) {
    dirty = false
    try { await redis(['SET', REDIS_KEY, JSON.stringify(db)]) } catch (e) {
      console.error('[db] Redis write failed, retrying:', e.message)
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

// Reset of all purchases: drops purchases and orders, and the alerts on paid quotes. Alerts on free quotes stay.
function resetQuotes() {
  const owners = Object.keys(db.owned).filter((u) => (db.owned[u] || []).length).length
  const before = db.alerts.length
  db.owned = {}
  db.orders = {}
  db.alerts = db.alerts.filter((a) => !(SYMBOLS[a.symbol] && SYMBOLS[a.symbol].premium))
  save()
  return { owners, alerts: before - db.alerts.length }
}
// One-time reset (new quote lineup)
if (!db.resetV3) {
  resetQuotes()
  db.resetV3 = Date.now()
  save()
  console.log('[db] purchases reset (v3)')
}
// Alert limit: 15 for everybody, 50 for users who bought any paid bundle.
const BASE_ALERTS = Number(process.env.BASE_ALERTS || 15)
const PRO_ALERTS = Number(process.env.PRO_ALERTS || 50)
const limitFor = (uid) => ((db.owned[uid] || []).length ? PRO_ALERTS : BASE_ALERTS)
const cleanNote = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
const defaultSettings = () => ({ lead: [15, 5], currencies: ['USD', 'EUR', 'GBP'] })

// ---------- quotes: free ones for everybody, paid ones only for buyers ----------
// Paid quotes are sold only in bundles. Free: EURUSD and GBPUSD.
const BUNDLE_PRICE = Number(process.env.PREMIUM_BUNDLE_RUB || 350)
const BUNDLES = {
  METALS: { label: 'Gold + Silver', syms: ['XAUUSD', 'XAGUSD'], price: BUNDLE_PRICE },
  INDICES: { label: 'GER40 + DXY', syms: ['GER40', 'DXY'], price: BUNDLE_PRICE },
}
const isPremium = (s) => Boolean(SYMBOLS[s] && SYMBOLS[s].premium)
const available = (s) => !feedStatus.missing.includes(s)
const inBundle = (s) => Object.values(BUNDLES).some((b) => b.syms.includes(s))
const bundleOk = (k) => Boolean(BUNDLES[k]) && BUNDLES[k].syms.every((s) => isPremium(s) && available(s))
const priceOf = (k) => (BUNDLES[k] ? BUNDLES[k].price : PREMIUM_PRICE)
const nice = (s) => (BUNDLES[s] ? BUNDLES[s].label : SYMBOLS[s].label && SYMBOLS[s].label !== s ? `${SYMBOLS[s].label} (${s})` : s)
const ownsQuote = (uid, s) => Boolean(uid) && (db.owned[uid] || []).includes(s)
const allowedSyms = (uid) => Object.keys(SYMBOLS).filter((s) => !isPremium(s) || (available(s) && ownsQuote(uid, s)))
const symbolsFor = (uid) => Object.fromEntries(allowedSyms(uid).map((s) => [s, { pip: SYMBOLS[s].pip, digits: SYMBOLS[s].digits }]))

// ---------- notifications ----------
async function notify(userId, text) {
  db.events.push({ id: db.seq++, userId, text, ts: Date.now() })
  if (db.events.length > 500) db.events.splice(0, db.events.length - 500)
  save()
  console.log(`[notify ${userId}] ${text}`)
  if (BOT_TOKEN && /^\d+$/.test(userId)) {
    try {
      await fetch(`${process.env.TG_API || 'https://api.telegram.org'}/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text }),
      })
    } catch (e) { console.error('[telegram]', e.message) }
  }
}

// ---------- OANDA H4 reminders (independent from quote alerts/news) ----------
const h4Source = createOandaH4()
let h4Store = null, h4StoreJob = null, h4StoreRetry = 0
async function getH4Store() {
  if (h4Store) return h4Store
  if (h4StoreJob) return h4StoreJob
  if (Date.now() < h4StoreRetry) return null
  h4StoreJob = createH4Store({ redis: USE_REDIS ? redis : null, file: DB_FILE + '.h4.json' })
    .then((store) => (h4Store = store))
    .catch((e) => { h4StoreRetry = Date.now() + 30000; console.error('[h4 storage]', e.message); return null })
    .finally(() => { h4StoreJob = null })
  return h4StoreJob
}
const h4Allowed = (uid, symbol) => Boolean(H4_ASSETS[symbol]) && allowedSyms(uid).includes(symbol)
async function deliverH4(uid, text) {
  // Unlike legacy notify(), check Telegram's response and bound the request time.
  if (!BOT_TOKEN || !/^\d+$/.test(uid)) throw new Error('Telegram delivery is not configured for this user')
  const result = await tg('sendMessage', { chat_id: uid, text }, 10000)
  if (!result.ok) { const e = new Error('Telegram delivery rejected'); e.definite = true; throw e }
  db.events.push({ id: db.seq++, userId: uid, text, ts: Date.now() })
  if (db.events.length > 500) db.events.splice(0, db.events.length - 500)
  save()
}
const runH4 = createH4Runner({
  getSettings: () => h4Store?.all() || {}, source: h4Source,
  allowed: h4Allowed, claim: (key, now, context) => h4Store.claim(key, now, context), deliver: deliverH4,
  onError: (message) => adminNotify(message, 'h4-error', 300000),
})
async function checkH4() {
  if (!h4Source.configured || !BOT_TOKEN) return
  const store = await getH4Store()
  if (!store) return
  await store.refresh()
  await runH4()
}

// ---------- Live personal reminders (no quote purchase/source dependency) ----------
let liveStore = null, liveStoreJob = null, liveRunner = null, liveRetry = 0
async function getLiveStore() {
  if (liveStore) return liveStore
  if (liveStoreJob) return liveStoreJob
  if (Date.now() < liveRetry) return null
  liveStoreJob = createLiveStore({ redis: USE_REDIS ? redis : null, file: DB_FILE + '.live.json' })
    .then((store) => {
      liveStore = store
      liveRunner = createLiveRunner({ store, deliver: deliverH4, onError: (m) => adminNotify(m, 'live-error', 300000) })
      return store
    }).catch((e) => { liveRetry = Date.now() + 30000; console.error('[live storage]', e.message); return null })
    .finally(() => { liveStoreJob = null })
  return liveStoreJob
}
async function checkLive() {
  if (!BOT_TOKEN) return
  if (await getLiveStore()) await liveRunner()
}
const liveConfigured = (uid) => Boolean(BOT_TOKEN) && /^\d+$/.test(uid)
const liveInputKey = (v) => JSON.stringify({ text: typeof v.text === 'string' ? v.text.trim() : v.text, date: v.date,
  times: Array.isArray(v.times) ? [...new Set(v.times)].sort() : v.times, timezone: v.timezone, repeat: v.repeat, count: v.count })

// ---------- check alerts on every tick ----------
function onTick(sym, price) {
  let changed = false
  for (const a of db.alerts) {
    if (a.status !== 'active' || a.symbol !== sym) continue
    if (isPremium(sym) && !ownsQuote(a.userId, sym)) continue
    const hit = a.dir === 'above' ? price >= a.level : price <= a.level
    if (!hit) continue
    a.status = 'fired'; a.firedAt = Date.now(); a.firedPrice = price; changed = true
    const shownPrice = Number(price).toFixed(SYMBOLS[sym].digits)
    notify(a.userId, a.note ? `🔔 ${sym} · ${shownPrice}\n${a.note}` : `🔔 ${sym} ${a.dir} ${a.level} (price ${shownPrice})`)
  }
  if (changed) save()
}

// ---------- news notifications ----------
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

// ---------- auth: signed access token or Telegram initData ----------
function getUserId(req) {
  const access = verifyAccessToken(req.headers['x-access-token'], 'alerts', ACCESS_SIGNING_SECRET)
  if (access) return String(access.sub)
  if (REQUIRE_ACCESS) return null
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
  // local mock mode only (no BOT_TOKEN and nothing configured): never trust a client-supplied id in production
  if (!BOT_TOKEN && MOCK && !REQUIRE_ACCESS && !process.env.RENDER) return String(req.headers['x-user-id'] || 'browser')
  return null
}

// ---------- Telegram bot: persistent keyboard under the input field ----------
const TG_API = process.env.TG_API || 'https://api.telegram.org'
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || 'https://tg-alerts-2khy.onrender.com'
const WELCOME = `Price alerts for EURUSD and GBPUSD.\n\nUp to ${BASE_ALERTS} alerts for free, ${PRO_ALERTS} with any paid bundle. Instant notifications and red news from Forex Factory, all in one place.\n\nWant Gold, Silver, GER40 or DXY? Tap Add quote.`
const MY_ALERTS_TEXT = 'My alerts'
const ADD_TEXT = 'Add quote'
const MYQ_TEXT = 'My quotes'
const KEYBOARD = {
  keyboard: [
    [{ text: 'Open Alerts', web_app: { url: WEBAPP_URL } }, { text: MY_ALERTS_TEXT }],
    [{ text: ADD_TEXT }, { text: MYQ_TEXT }],
  ],
  resize_keyboard: true,
  is_persistent: true,
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tg = async (method, payload, ms = 15000) => {
  const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(ms),
  })
  return r.json()
}

// ---------- admin messages to the owner in Telegram ----------
const lastAdmin = new Map()
async function adminNotify(text, key = text, minGapMs = 0) {
  console.log('[admin]', text)
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return
  const now = Date.now()
  if (minGapMs && now - (lastAdmin.get(key) || 0) < minGapMs) return
  lastAdmin.set(key, now)
  try { await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `[tg-alerts] ${text}` }, 10000) } catch {}
}
process.on('uncaughtException', (e) => { console.error('[fatal]', e); adminNotify(`Error: ${e && e.message}`, 'err', 300000) })
process.on('unhandledRejection', (e) => { console.error('[unhandled]', e); adminNotify(`Error: ${e && e.message}`, 'err', 300000) })

const dirSym = (d) => (d === 'above' ? '▲' : '▼')
function alertsView(uid) {
  const list = db.alerts.filter((a) => a.userId === uid && a.status === 'active')
  const text = list.length
    ? `Your active alerts (${list.length}/${limitFor(uid)}):\n\n` + list.map((a, i) => `${i + 1}. ${a.symbol} ${dirSym(a.dir)} ${a.level}${a.note ? ' · ' + a.note : ''}`).join('\n')
    : 'No active alerts yet.'
  const rows = list.map((a) => [{ text: `✕ ${a.symbol} ${dirSym(a.dir)} ${a.level}`, callback_data: `del:${a.id}` }])
  rows.push([{ text: 'Open Alerts', web_app: { url: WEBAPP_URL } }])
  return { text, reply_markup: { inline_keyboard: rows } }
}

// ----- paid quotes: manual approval -----
const who = (o) => `${o.name || 'user'}${o.username ? ' @' + o.username : ''} (${o.userId})`
function payView(o) {
  if (o.status === 'paid') {
    return { text: `${nice(o.symbol)}\n\nPayment request sent. You will get a message as soon as it is confirmed.`, markup: { inline_keyboard: [] } }
  }
  if (!PAY_DETAILS) {
    return { text: `${nice(o.symbol)}\n\nPayment details are not set up yet. Please contact the admin.`, markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: `cancel:${o.id}` }]] } }
  }
  return {
    text: `${nice(o.symbol)} · forever\nPrice: ${priceOf(o.symbol)} ₽\n\nPay to:\n${PAY_DETAILS}\n\nAfter the transfer tap I paid.`,
    markup: { inline_keyboard: [[{ text: 'I paid', callback_data: `paid:${o.id}` }], [{ text: 'Cancel', callback_data: `cancel:${o.id}` }]] },
  }
}
function buyList(uid) {
  // quotes that are part of a bundle are not sold on their own
  const rows = Object.keys(SYMBOLS)
    .filter((s) => isPremium(s) && available(s) && !ownsQuote(uid, s) && !inBundle(s))
    .map((s) => [{ text: `${nice(s)} · ${priceOf(s)} ₽`, callback_data: `buy:${s}` }])
  for (const k of Object.keys(BUNDLES)) {
    if (bundleOk(k) && BUNDLES[k].syms.some((x) => !ownsQuote(uid, x))) rows.push([{ text: `${nice(k)} · ${priceOf(k)} ₽`, callback_data: `buy:${k}` }])
  }
  if (!rows.length) return { text: 'You already have all available quotes.' }
  return { text: `Add a quote (pay once, keep forever).\nAny bundle also raises your alert limit to ${PRO_ALERTS}.`, reply_markup: { inline_keyboard: rows } }
}
function grant(uid, s) {
  const list = BUNDLES[s] ? BUNDLES[s].syms : [s]
  db.owned[uid] = [...new Set([...(db.owned[uid] || []), ...list])]
  save()
}

async function handleCallback(q) {
  const uid = String(q.from.id), data = q.data || ''
  const chat = q.message && q.message.chat.id, mid = q.message && q.message.message_id
  const ans = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text })
  const edit = (text, markup) => (chat ? tg('editMessageText', { chat_id: chat, message_id: mid, text, reply_markup: markup || { inline_keyboard: [] } }) : null)
  let m
  if ((m = data.match(/^del:(\d+)$/))) {
    const before = db.alerts.length
    db.alerts = db.alerts.filter((a) => !(a.id === Number(m[1]) && a.userId === uid))
    if (db.alerts.length !== before) save()
    await ans('Deleted')
    if (q.message) await tg('editMessageText', { chat_id: chat, message_id: mid, ...alertsView(uid) })
    return
  }
  if ((m = data.match(/^buy:(\w+)$/))) {
    const s = m[1]
    const isBundle = Boolean(BUNDLES[s])
    if (isBundle ? !bundleOk(s) : !isPremium(s) || !available(s) || inBundle(s)) return ans('Not available')
    if (isBundle ? BUNDLES[s].syms.every((x) => ownsQuote(uid, x)) : ownsQuote(uid, s)) return ans('You already have it')
    let o = Object.values(db.orders).find((x) => x.userId === uid && x.symbol === s && (x.status === 'new' || x.status === 'paid'))
    if (!o) {
      o = { id: db.seq++, userId: uid, name: [q.from.first_name, q.from.last_name].filter(Boolean).join(' '), username: q.from.username || '', symbol: s, status: 'new', ts: Date.now() }
      db.orders[o.id] = o; save()
    }
    await ans()
    const v = payView(o)
    return edit(v.text, v.markup)
  }
  if ((m = data.match(/^paid:(\d+)$/))) {
    const o = db.orders[m[1]]
    if (!o || o.userId !== uid) return ans('Not found')
    if (o.status === 'paid') return ans('Already sent, please wait')
    if (o.status !== 'new') return ans('This request is closed')
    o.status = 'paid'; o.paidAt = Date.now(); save()
    await ans('Sent. Waiting for confirmation')
    const v = payView(o)
    await edit(v.text, v.markup)
    await tg('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text: `💰 Payment request #${o.id}\n${who(o)}\n${nice(o.symbol)} · ${priceOf(o.symbol)} ₽`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ok:${o.id}` }, { text: '✕ Decline', callback_data: `no:${o.id}` }]] },
    })
    return
  }
  if ((m = data.match(/^cancel:(\d+)$/))) {
    const o = db.orders[m[1]]
    if (!o || o.userId !== uid) return ans('Not found')
    if (o.status === 'paid') return ans('Already sent, please wait')
    if (o.status === 'new') { delete db.orders[o.id]; save() }
    await ans('Cancelled')
    return edit('Cancelled.')
  }
  if ((m = data.match(/^(ok|no):(\d+)$/))) {
    if (uid !== ADMIN_CHAT_ID) return ans('Admin only')
    const o = db.orders[m[2]]
    if (!o) return ans('Not found')
    if (o.status !== 'paid' && o.status !== 'new') { await ans('Already handled'); return }
    if (m[1] === 'ok') {
      o.status = 'approved'; grant(o.userId, o.symbol)
      await ans('Approved')
      await edit(`✅ Approved #${o.id}\n${who(o)}\n${nice(o.symbol)}`)
      await notify(o.userId, `✅ ${nice(o.symbol)} is added. Open Alerts and pick it in the list. Your alert limit is now ${PRO_ALERTS}.`)
    } else {
      o.status = 'declined'; save()
      await ans('Declined')
      await edit(`✕ Declined #${o.id}\n${who(o)}\n${nice(o.symbol)}`)
      await notify(o.userId, `❌ Payment for ${nice(o.symbol)} was not confirmed. If you did pay, contact the admin.`)
    }
    return
  }
  await ans()
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query)
  const m = u.message
  if (!m || !m.chat || m.chat.type !== 'private' || !m.text) return
  const uid = String(m.from.id), txt = m.text.trim()
  if (uid === ADMIN_CHAT_ID) {
    if (/^\/reset_quotes(@\w+)?(\s+confirm)?$/i.test(txt)) {
      if (!/confirm$/i.test(txt)) {
        await tg('sendMessage', { chat_id: m.chat.id, text: 'This removes ALL purchased quotes and orders for everybody, and deletes alerts on paid quotes (including yours).\n\nTo confirm send:\n/reset_quotes confirm' })
        return
      }
      const r = resetQuotes()
      await tg('sendMessage', { chat_id: m.chat.id, text: `Done. Purchases cleared for ${r.owners} users, ${r.alerts} alerts on paid quotes deleted.` })
      return
    }
    const g = txt.match(/^\/(grant|revoke)\s+(\d+)\s+(\w+)$/i)
    if (g) {
      const s = g[3].toUpperCase()
      if (!isPremium(s) && !BUNDLES[s]) { await tg('sendMessage', { chat_id: m.chat.id, text: 'Unknown paid quote. Use: ' + [...Object.keys(SYMBOLS).filter(isPremium), ...Object.keys(BUNDLES)].join(', ') }); return }
      if (g[1].toLowerCase() === 'grant') grant(g[2], s)
      else { const list = BUNDLES[s] ? BUNDLES[s].syms : [s]; db.owned[g[2]] = (db.owned[g[2]] || []).filter((x) => !list.includes(x)); save() }
      await tg('sendMessage', { chat_id: m.chat.id, text: `Done: ${g[1].toLowerCase()} ${s} for ${g[2]}` })
      return
    }
  }
  if (/^\/alerts(@\w+)?(\s|$)/i.test(txt) || txt === MY_ALERTS_TEXT) {
    await tg('sendMessage', { chat_id: m.chat.id, ...alertsView(uid) })
    return
  }
  if (/^\/quotes(@\w+)?(\s|$)/i.test(txt) || txt === ADD_TEXT) {
    await tg('sendMessage', { chat_id: m.chat.id, ...buyList(uid) })
    return
  }
  if (txt === MYQ_TEXT) {
    const list = allowedSyms(uid).map((s) => `• ${nice(s)}`).join('\n')
    await tg('sendMessage', { chat_id: m.chat.id, text: `Your quotes:\n\n${list}` })
    return
  }
  await tg('sendMessage', { chat_id: m.chat.id, text: WELCOME, reply_markup: KEYBOARD })
}
async function pollTelegram() {
  if (!BOT_TOKEN || process.env.BOT_POLLING === 'off' || (MOCK && process.env.BOT_POLLING !== 'on')) return
  try { await tg('deleteWebhook', {}) } catch {}
  try {
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Open Alerts' }, { command: 'alerts', description: 'My active alerts' }, { command: 'quotes', description: 'Add a quote' }] })
  } catch {}
  console.log('[bot] waiting for Telegram messages')
  let offset = 0
  for (;;) {
    try {
      const j = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000)
      if (!j.ok) { await sleep(j.error_code === 409 ? 5000 : 3000); continue }
      for (const u of j.result) {
        offset = u.update_id + 1
        handleUpdate(u).catch((e) => console.error('[bot]', e.message))
      }
    } catch (e) { await sleep(3000) }
  }
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(JSON.parse(d || '{}')) } catch { ok({}) } }) })
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

// Small on-the-fly fixes for the page: reload the quote list after sign-in and ignore quotes the page does not know yet.
function patchIndex(html) {
  return html
    .replace('renderTiles(); renderPrice(); renderChips(); requestAnimationFrame(frame)', () => "cfg = await api('/api/config'); renderTiles(); renderPrice(); renderChips(); requestAnimationFrame(frame)")
    .replace('if (shown[k] == null) continue', () => 'if (shown[k] == null || !cfg.symbols[k]) continue')
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok') }
  if (!p.startsWith('/api/')) {
    const f = path.join(__dir, 'public', p === '/' ? 'index.html' : p)
    if (!f.startsWith(path.join(__dir, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'text/plain' })
    if (path.basename(f) === 'index.html') return res.end(patchIndex(fs.readFileSync(f, 'utf8')))
    return res.end(fs.readFileSync(f))
  }

  if (p === '/api/config') return json(res, 200, { authRequired: REQUIRE_ACCESS, authApi: AUTH_API_URL, mock: MOCK, symbols: symbolsFor(getUserId(req)) })
  if (p === '/api/prices') {
    const uid = getUserId(req)
    if (REQUIRE_ACCESS && !uid) return json(res, 401, { error: 'access_required' })
    const ok = new Set(allowedSyms(uid))
    return json(res, 200, Object.fromEntries(Object.entries(prices).filter(([k]) => ok.has(k))))
  }
  if (p === '/api/news') { const uid = getUserId(req); if (REQUIRE_ACCESS && !uid) return json(res, 401, { error: 'access_required' }); return json(res, 200, await getNews()) }
  if (p === '/api/access/check') { const uid = getUserId(req); return uid ? json(res, 200, { ok: true, userId: uid }) : json(res, 401, { error: 'access_required' }) }

  const uid = getUserId(req)
  if (!uid) return json(res, 401, { error: 'unauthorized' })

  if (p === '/api/alerts' && req.method === 'GET') return json(res, 200, db.alerts.filter((a) => a.userId === uid).reverse())
  if (p === '/api/alerts' && req.method === 'POST') {
    const b = await body(req)
    const level = Number(b.level)
    if (!SYMBOLS[b.symbol] || !allowedSyms(uid).includes(b.symbol) || !['above', 'below'].includes(b.dir) || !isFinite(level)) return json(res, 400, { error: 'bad input' })
    const max = limitFor(uid)
    if (db.alerts.filter((x) => x.userId === uid && x.status === 'active').length >= max) return json(res, 400, { error: 'limit', max })
    const a = { id: db.seq++, userId: uid, symbol: b.symbol, dir: b.dir, level, note: cleanNote(b.note), status: 'active', createdAt: Date.now() }
    db.alerts.push(a); save(); return json(res, 200, a)
  }
  const del = p.match(/^\/api\/alerts\/(\d+)$/)
  if (del && req.method === 'PATCH') {
    const a = db.alerts.find((x) => x.id === Number(del[1]) && x.userId === uid)
    if (!a) return json(res, 404, { error: 'not found' })
    const b = await body(req)
    if ('note' in b) a.note = cleanNote(b.note)
    save(); return json(res, 200, a)
  }
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
  if (p === '/api/h4/settings') {
    const store = await getH4Store()
    if (!store) return json(res, 503, { error: 'H4 settings storage is unavailable. Please retry.' })
    if (req.method === 'GET') {
      const saved = store.get(uid), symbols = saved.symbols.filter((s) => Object.hasOwn(H4_ASSETS, s))
      return json(res, 200, { ...saved, symbols, enabled: saved.enabled && symbols.length > 0 })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
    let settings
    try { settings = normalizeH4Settings(await body(req)) }
    catch (e) { return json(res, 400, { error: e.message }) }
    // Existing quote ownership remains authoritative both here and at send time.
    if (settings.enabled && settings.symbols.some((s) => !h4Allowed(uid, s))) return json(res, 403, { error: 'Quote access required' })
    if (settings.enabled && (!h4Source.configured || !BOT_TOKEN || !/^\d+$/.test(uid))) return json(res, 503, { error: 'OANDA H4 or Telegram delivery is not configured.' })
    try { return json(res, 200, await store.set(uid, settings)) }
    catch { return json(res, 503, { error: 'Could not confirm saving H4 settings. Reload to verify.' }) }
  }
  if (p === '/api/h4/status' && req.method === 'GET') {
    const permitted = Object.keys(H4_ASSETS).filter((s) => h4Allowed(uid, s))
    const states = await h4Source.get(permitted)
    return json(res, 200, { source: 'OANDA', timezone: 'America/New_York', dailyAlignment: 17,
      configured: h4Source.configured && Boolean(BOT_TOKEN) && /^\d+$/.test(uid), serverTime: Date.now(),
      assets: Object.fromEntries(Object.entries(H4_ASSETS).map(([s, meta]) => [s, states[s] || { ...meta, status: 'locked', active: null }])) })
  }
  const liveRoute = p.match(/^\/api\/live(?:\/([a-f0-9-]+))?$/)
  if (liveRoute) {
    const id = liveRoute[1], store = await getLiveStore()
    if (!store) return json(res, 503, { error: 'Live storage unavailable. Retry.' })
    try {
      if (!id && req.method === 'GET') {
        await store.refresh()
        return json(res, 200, { configured: liveConfigured(uid), serverTime: Date.now(),
          reminders: store.list(uid).map((r) => liveView(r)).sort((a, b) => (a.next || Infinity) - (b.next || Infinity) || b.createdAt - a.createdAt) })
      }
      if (!id && req.method === 'POST') {
        const b = await body(req)
        if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'Invalid reminder' })
        if (!liveIdValid(b.id)) return json(res, 400, { error: 'Invalid reminder ID' })
        const existing = await store.read(uid, b.id)
        if (existing) {
          if (liveInputKey(existing.config) !== liveInputKey(b)) throw new LiveConflict()
          return json(res, 200, liveView(existing)) // safe retry after a lost response
        }
        if (!liveConfigured(uid)) return json(res, 503, { error: 'Telegram delivery unavailable' })
        let value
        try { value = newReminder(uid, b.id, b) } catch (e) { return json(res, 400, { error: e.message }) }
        await store.cas(uid, b.id, null, value, true)
        return json(res, 201, liveView(value))
      }
      if (id && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const b = await body(req)
        if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'Invalid reminder' })
        const current = await store.read(uid, id)
        if (!current) return json(res, 404, { error: 'Reminder not found' })
        if (b.revision !== current.revision) throw new LiveConflict()
        let value = null
        if (req.method === 'PUT') {
          if (current.deliveries.some((d) => d.status === 'attempting')) throw new LiveConflict()
          try { value = editReminder(current, b) }
          catch (e) { return json(res, 400, { error: e.message }) }
        }
        if (req.method === 'PATCH') {
          if (typeof b.enabled !== 'boolean') return json(res, 400, { error: 'Invalid reminder state' })
          value = { ...current, enabled: b.enabled, revision: crypto.randomUUID(), updatedAt: Date.now() }
          // Resuming never replays an occurrence that passed while paused.
          if (b.enabled) value.deliveries = current.deliveries.map((d) => d.status === 'pending' && d.at <= Date.now() ? { ...d, status: 'missed' } : d)
        }
        await store.cas(uid, id, current, value)
        return json(res, 200, value ? liveView(value) : { ok: true })
      }
      return json(res, 405, { error: 'method_not_allowed' })
    } catch (e) {
      // Storage timeouts may have committed. Never report a definite failed write.
      return json(res, e.status || 503, { error: e.status ? e.message : 'Could not confirm saving. Reload to verify.' })
    }
  }
  if (p === '/api/events') {
    const since = Number(url.searchParams.get('since') || 0)
    return json(res, 200, db.events.filter((e) => e.userId === uid && e.id > since))
  }
  // test mode only: move the price by hand
  if (p === '/api/debug/move' && MOCK) {
    const b = await body(req)
    const c = SYMBOLS[b.symbol]; if (!c || !prices[b.symbol]) return json(res, 400, { error: 'bad' })
    setPrice(b.symbol, prices[b.symbol].price + Number(b.pips) * c.pip, onTick)
    return json(res, 200, prices[b.symbol])
  }
  json(res, 404, { error: 'not found' })
})

Promise.resolve(startPrices(onTick))
  .then(() => { if (feedStatus.missing.length) adminNotify('⚠️ Not available on your price feed: ' + feedStatus.missing.join(', '), 'missing') })
  .catch((e) => console.error('[prices]', e && e.message))
pollTelegram()

// ---------- price loss guard: if the feed goes silent while the market is open, tell users with active alerts and the owner ----------
const STALE_MS = Number(process.env.PRICE_STALE_MIN || 10) * 60e3
const BOOT = Date.now()
let feedDown = false
let downUsers = []
function marketOpen(d = new Date()) {
  if (process.env.FORCE_MARKET_OPEN) return true
  const day = d.getUTCDay(), h = d.getUTCHours() // sun=0 ... sat=6
  if (day === 6) return false
  if (day === 5 && h >= 21) return false
  if (day === 0 && h < 22) return false
  return true
}
// per-quote trading hours: gold and silver have a daily break, GER40 trades only on weekdays during the day
function symOpen(s, d = new Date()) {
  if (!marketOpen(d)) return false
  const day = d.getUTCDay(), h = d.getUTCHours(), mi = d.getUTCMinutes()
  if (s === 'XAUUSD' || s === 'XAGUSD') return !(h === 21 || h === 22 || (h === 23 && mi < 5))
  if (s === 'GER40') return day >= 1 && day <= 5 && h >= 7 && h < 21
  return true
}
async function watchPrices() {
  const now = Date.now()
  if (!marketOpen()) { if (feedDown) feedDown = false; return }
  const stale = Object.keys(SYMBOLS).filter((s) => available(s) && symOpen(s) && now - Math.max(prices[s]?.ts || 0, prices[s]?.dataTs || 0, BOOT) > STALE_MS)
  if (stale.length && !feedDown) {
    feedDown = true
    downUsers = [...new Set(db.alerts.filter((a) => a.status === 'active' && stale.includes(a.symbol)).map((a) => a.userId))]
    console.error('[prices] no new prices:', stale.join(', '))
    await adminNotify('⚠️ Price feed lost: ' + stale.join(', '), 'feed')
    for (const u of downUsers) await notify(u, '⚠️ Price feed lost (' + stale.join(', ') + '). Your alerts will not fire until it is back. I will tell you when it recovers.')
  } else if (!stale.length && feedDown) {
    feedDown = false
    console.log('[prices] prices are flowing again')
    await adminNotify('✅ Price feed is back', 'feed')
    for (const u of downUsers) await notify(u, '✅ Price feed is back. Alerts are working again.')
    downUsers = []
  }
}
setInterval(() => watchPrices().catch((e) => console.error('[watch]', e.message)), Number(process.env.WATCHDOG_MS || 30000))
setInterval(() => checkNews().catch((e) => console.error('[news]', e.message)), 20000)
setInterval(() => checkH4().catch((e) => console.error('[h4]', e.message)), 10000)
checkH4().catch((e) => console.error('[h4]', e.message))
setInterval(() => checkLive().catch((e) => console.error('[live]', e.message)), 10000)
checkLive().catch((e) => console.error('[live]', e.message))
server.listen(PORT, () => {
  console.log(`Open in browser: http://localhost:${PORT}`)
  adminNotify('🟢 Service started', 'start', 60000)
})
