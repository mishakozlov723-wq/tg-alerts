// Cloudflare adapter: API and Telegram business rules retained from server.js.
// Node/Render entrypoint remains untouched. All async mutations are serialized by one DO.
import crypto from 'node:crypto'
import { verifyAccessToken } from '../shared/access-token.mjs'
import { H4_ASSETS, normalizeH4Settings, createOandaH4, createH4Runner } from '../h4.js'
import { createH4Store } from '../h4-store.js'
import { createLiveStore, LiveConflict } from '../live-store.js'
import { newReminder, liveIdValid, liveView, createLiveRunner } from '../live.js'
import { createQuoteFeed } from './quotes.mjs'
import { createNews } from './news.mjs'
import { validateMain } from './storage.mjs'

export async function createEngine(env) {
const fetch = env.FETCH || globalThis.fetch
const engineBornAt=Date.now()
const quoteFeed = createQuoteFeed(env)
const { SYMBOLS, prices, feedStatus, setPrice } = quoteFeed
const { getNews } = createNews(env)
// Silver is a paid quote from Capital.com (epic can be changed with CAPITAL_EPIC_XAGUSD, shift with OFFSET_XAGUSD).
if (!SYMBOLS.XAGUSD) SYMBOLS.XAGUSD = { label: 'Silver', premium: true, pip: 0.01, digits: 3, base: 50, capital: env.CAPITAL_EPIC_XAGUSD || 'SILVER', offset: Number(env.OFFSET_XAGUSD || 0), duka: ['xagusd'] }
// DXY is a paid quote too (only EURUSD and GBPUSD are free). Its price is still computed from the OANDA pairs.
SYMBOLS.DXY.premium = true

const BOT_TOKEN = env.BOT_TOKEN || ''
const ACCESS_SIGNING_SECRET = env.ACCESS_SIGNING_SECRET || ''
const AUTH_API_URL = env.AUTH_API_URL || ''
const REQUIRE_ACCESS = env.REQUIRE_ACCESS === 'true' || Boolean(ACCESS_SIGNING_SECRET)
const MOCK = (env.PRICE_SOURCE || 'mock') === 'mock'
const ADMIN_CHAT_ID = String(env.ADMIN_CHAT_ID || '1011596614')
const PREMIUM_PRICE = Number(env.PREMIUM_PRICE_RUB || 350)
const PAY_DETAILS = env.PAY_DETAILS || ''

// Durable local SQLite. Existing helper storage operations stay atomic locally.
const redis = env.LOCAL_STORE.command
const USE_REDIS = true
const saved = await redis(['GET','tg-alerts-db'])
if (saved === null) throw Object.assign(new Error('storage_not_initialized'), { status: 503 })
let db = validateMain(JSON.parse(saved))
const save = async () => {
  try { await redis(['SET', 'tg-alerts-db', JSON.stringify(db)]) }
  catch { const e = new Error('durable_storage_unavailable'); e.storageFailure = true; throw e }
}
// Reset of all purchases: drops purchases and orders, and the alerts on paid quotes. Alerts on free quotes stay.
async function resetQuotes() {
  const owners = Object.keys(db.owned).filter((u) => (db.owned[u] || []).length).length
  const before = db.alerts.length
  db.owned = {}
  db.orders = {}
  db.alerts = db.alerts.filter((a) => !(SYMBOLS[a.symbol] && SYMBOLS[a.symbol].premium))
  await save()
  return { owners, alerts: before - db.alerts.length }
}
// Existing purchases and paid alerts are preserved during migration.
// Alert limit: 15 for everybody, 50 for users who bought any paid bundle.
const BASE_ALERTS = Number(env.BASE_ALERTS || 15)
const PRO_ALERTS = Number(env.PRO_ALERTS || 50)
const limitFor = (uid) => ((db.owned[uid] || []).length ? PRO_ALERTS : BASE_ALERTS)
const cleanNote = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
const defaultSettings = () => ({ lead: [15, 5], currencies: ['USD', 'EUR', 'GBP'] })

// ---------- quotes: free ones for everybody, paid ones only for buyers ----------
// Paid quotes are sold only in bundles. Free: EURUSD and GBPUSD.
const BUNDLE_PRICE = Number(env.PREMIUM_BUNDLE_RUB || 350)
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
function trimEvents() {
  while(db.events.length>500){const i=db.events.findIndex(e=>!['pending','attempting'].includes(e.delivery));if(i<0)break;db.events.splice(i,1)}
}
async function notify(userId, text) {
  const event = { id: db.seq++, userId, text, ts: Date.now(), delivery: 'attempting' }
  db.events.push(event)
  trimEvents()
  await save()
  if (BOT_TOKEN && /^\d+$/.test(userId)) {
    try { const result = await tg('sendMessage', { chat_id: userId, text }); event.delivery = result.ok ? 'sent' : 'failed' }
    catch (e) { event.delivery = e.retrySafe ? 'pending' : e.definite ? 'failed' : 'unknown' }
  } else event.delivery = 'failed'
  await save()
  return event.delivery
}

// ---------- OANDA H4 reminders (independent from quote alerts/news) ----------
const h4Source = createOandaH4({ env, fetcher: fetch })
let h4Store = null, h4StoreJob = null, h4StoreRetry = 0
async function getH4Store() {
  if (h4Store) return h4Store
  if (h4StoreJob) return h4StoreJob
  if (Date.now() < h4StoreRetry) return null
  h4StoreJob = createH4Store({ redis: USE_REDIS ? redis : null, file: null })
    .then((store) => (h4Store = store))
    .catch((e) => { h4StoreRetry = Date.now() + 30000; console.error('[h4 storage]', e.message); return null })
    .finally(() => { h4StoreJob = null })
  return h4StoreJob
}
const h4Allowed = (uid, symbol) => Boolean(H4_ASSETS[symbol]) && allowedSyms(uid).includes(symbol)
async function deliverH4(uid, text) {
  // Unlike legacy notify(), check Telegram's response and bound the request time.
  if (!BOT_TOKEN || !/^\d+$/.test(uid)) throw new Error('Telegram delivery is not configured for this user')
  let result
  try { result = await tg('sendMessage', { chat_id: uid, text }, 10000) }
  catch(e) { if(e.retrySafe){ db.events.push({id:db.seq++,userId:uid,text,ts:Date.now(),delivery:'pending'}); trimEvents(); await save() }; throw e }
  if (!result.ok) { const e = new Error('Telegram delivery rejected'); e.definite = true; throw e }
  db.events.push({ id: db.seq++, userId: uid, text, ts: Date.now() })
  trimEvents()
  await save()
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
  liveStoreJob = createLiveStore({ redis: USE_REDIS ? redis : null, file: null })
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
async function onTick(sym, price) {
  let changed = false
  for (const a of db.alerts) {
    if (a.status !== 'active' || a.symbol !== sym) continue
    if (isPremium(sym) && !ownsQuote(a.userId, sym)) continue
    if (!quoteFeed.tradeable(sym)) continue
    const hit = a.dir === 'above' ? price >= a.level : price <= a.level
    if (!hit) continue
    a.status = 'fired'; a.firedAt = Date.now(); a.firedPrice = price; changed = true
    const shownPrice = Number(price).toFixed(SYMBOLS[sym].digits)
    await notify(a.userId, a.note ? `🔔 ${sym} · ${shownPrice}\n${a.note}` : `🔔 ${sym} ${a.dir} ${a.level} (price ${shownPrice})`)
  }
  if (changed) await save()
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
        await save()
        const extra = n.forecast || n.previous ? `\nForecast: ${n.forecast || '-'} · Prev: ${n.previous || '-'}` : ''
        await notify(userId, `🔴 ${n.currency} ${n.title}\nIn ${lead} min${extra}`)
      }
    }
  }
}

// ---------- auth: signed access token or Telegram initData ----------
function getUserId(req) {
  const access = verifyAccessToken(req.headers['x-access-token'], 'alerts', ACCESS_SIGNING_SECRET)
  if (access && /^\d+$/.test(String(access.sub)) && Number.isFinite(access.exp) && access.exp > Date.now()) return String(access.sub)
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
  if (!BOT_TOKEN && MOCK && !REQUIRE_ACCESS && !env.RENDER) return String(req.headers['x-user-id'] || 'browser')
  return null
}

// ---------- Telegram bot: persistent keyboard under the input field ----------
const TG_API = env.TG_API || 'https://api.telegram.org'
const WEBAPP_URL = env.WEBAPP_URL || env.RENDER_EXTERNAL_URL || 'https://tg-alerts.retocker.workers.dev'
const WELCOME = `Price alerts for EURUSD and GBPUSD.\n\nUp to ${BASE_ALERTS} alerts for free, ${PRO_ALERTS} with any paid bundle. Streaming OANDA price alerts and red news from Forex Factory, all in one place.\n\nWant Gold, Silver, GER40 or DXY? Tap Add quote.`
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
  const data = await r.json()
  if (!r.ok || !data.ok) { const e = new Error('Telegram delivery rejected'); e.definite = true; throw e }
  return data
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
async function grant(uid, s) {
  const list = BUNDLES[s] ? BUNDLES[s].syms : [s]
  db.owned[uid] = [...new Set([...(db.owned[uid] || []), ...list])]
  await save()
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
    if (db.alerts.length !== before) await save()
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
      db.orders[o.id] = o; await save()
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
    o.status = 'paid'; o.paidAt = Date.now(); await save()
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
    if (o.status === 'new') { delete db.orders[o.id]; await save() }
    await ans('Cancelled')
    return edit('Cancelled.')
  }
  if ((m = data.match(/^(ok|no):(\d+)$/))) {
    if (uid !== ADMIN_CHAT_ID) return ans('Admin only')
    const o = db.orders[m[2]]
    if (!o) return ans('Not found')
    if (o.status !== 'paid' && o.status !== 'new') { await ans('Already handled'); return }
    if (m[1] === 'ok') {
      o.status = 'approved'; await grant(o.userId, o.symbol)
      await ans('Approved')
      await edit(`✅ Approved #${o.id}\n${who(o)}\n${nice(o.symbol)}`)
      await notify(o.userId, `✅ ${nice(o.symbol)} is added. Open Alerts and pick it in the list. Your alert limit is now ${PRO_ALERTS}.`)
    } else {
      o.status = 'declined'; await save()
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
      const r = await resetQuotes()
      await tg('sendMessage', { chat_id: m.chat.id, text: `Done. Purchases cleared for ${r.owners} users, ${r.alerts} alerts on paid quotes deleted.` })
      return
    }
    const g = txt.match(/^\/(grant|revoke)\s+(\d+)\s+(\w+)$/i)
    if (g) {
      const s = g[3].toUpperCase()
      if (!isPremium(s) && !BUNDLES[s]) { await tg('sendMessage', { chat_id: m.chat.id, text: 'Unknown paid quote. Use: ' + [...Object.keys(SYMBOLS).filter(isPremium), ...Object.keys(BUNDLES)].join(', ') }); return }
      if (g[1].toLowerCase() === 'grant') await grant(g[2], s)
      else { const list = BUNDLES[s] ? BUNDLES[s].syms : [s]; db.owned[g[2]] = (db.owned[g[2]] || []).filter((x) => !list.includes(x)); await save() }
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
// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const body = async (req) => {
  const text = await req.text()
  if (text.length > 12000) { const e = new Error('body_too_large'); e.status = 413; throw e }
  try { const v = JSON.parse(text || '{}'); if (!v || Array.isArray(v) || typeof v !== 'object') throw new Error(); return v }
  catch { const e = new Error('invalid_json'); e.status = 400; throw e }
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok') }
  if (p === '/api/config') return json(res, 200, { authRequired: REQUIRE_ACCESS, authApi: AUTH_API_URL, mock: MOCK, symbols: symbolsFor(getUserId(req)), quoteMode: 'stream', displayIntervalMs: 1000 })
  if (p === '/api/feed-status') return json(res, 200, quoteFeed.status())
  if (p === '/api/prices') {
    const uid = getUserId(req)
    if (REQUIRE_ACCESS && !uid) return json(res, 401, { error: 'access_required' })
    const ok = new Set(allowedSyms(uid))
    return json(res, 200, Object.fromEntries(Object.entries(prices).filter(([k,v]) => ok.has(k) && Date.now() - (v.observedAt || v.ts || 0) < 30000)))
  }
  if (p === '/api/news') { const uid = getUserId(req); if (REQUIRE_ACCESS && !uid) return json(res, 401, { error: 'access_required' }); return json(res, 200, await getNews()) }
  if (p === '/api/access/check') { const uid = getUserId(req); return uid ? json(res, 200, { ok: true, userId: uid }) : json(res, 401, { error: 'access_required' }) }

  const uid = getUserId(req)
  if (!uid) return json(res, 401, { error: 'unauthorized' })

  if (p === '/api/alerts' && req.method === 'GET') return json(res, 200, db.alerts.filter((a) => a.userId === uid).reverse())
  if (p === '/api/alerts' && req.method === 'POST') {
    const b = await body(req)
    const level = typeof b.level === 'number' || typeof b.level === 'string' && b.level.trim() ? Number(b.level) : NaN
    if (!SYMBOLS[b.symbol] || !allowedSyms(uid).includes(b.symbol) || !['above', 'below'].includes(b.dir) || !isFinite(level)) return json(res, 400, { error: 'bad input' })
    const max = limitFor(uid)
    if (db.alerts.filter((x) => x.userId === uid && x.status === 'active').length >= max) return json(res, 400, { error: 'limit', max })
    const a = { id: db.seq++, userId: uid, symbol: b.symbol, dir: b.dir, level, note: cleanNote(b.note), status: 'active', createdAt: Date.now() }
    db.alerts.push(a); await save(); return json(res, 200, a)
  }
  const del = p.match(/^\/api\/alerts\/(\d+)$/)
  if (del && req.method === 'PATCH') {
    const a = db.alerts.find((x) => x.id === Number(del[1]) && x.userId === uid)
    if (!a) return json(res, 404, { error: 'not found' })
    const b = await body(req)
    if ('note' in b) a.note = cleanNote(b.note)
    await save(); return json(res, 200, a)
  }
  if (del && req.method === 'DELETE') {
    db.alerts = db.alerts.filter((a) => !(a.id === Number(del[1]) && a.userId === uid)); await save(); return json(res, 200, { ok: true })
  }
  if (p === '/api/settings') {
    if (req.method === 'POST') {
      const b = await body(req)
      if (!Array.isArray(b.lead) || !Array.isArray(b.currencies) || b.lead.some(x => ![1,5,15,30].includes(Number(x))) || b.currencies.some(x => !['USD','EUR','GBP','JPY','CAD','AUD','CHF','NZD'].includes(x))) return json(res, 400, {error:'Invalid news settings'})
      db.settings[uid] = { lead: [...new Set(b.lead.map(Number))], currencies: [...new Set(b.currencies)] }; await save()
    }
    if (!db.settings[uid]) { db.settings[uid] = defaultSettings(); await save() }
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
          try { value = { ...newReminder(uid, id, b), createdAt: current.createdAt } }
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
}

let feedDown = false, downUsers = []

return {
  async http(request) {
    let status = 200, headers = {}, result
    const req = { method: request.method, url: new URL(request.url).pathname + new URL(request.url).search,
      headers: Object.fromEntries(request.headers), text: () => request.text() }
    const res = {
      writeHead(code, values = {}) { status = code; headers = values; return this },
      end(value = '') { result = new Response(value, { status, headers: { ...headers, 'cache-control': 'no-store' } }); return this },
    }
    await handleHttp(req, res)
    return result || Response.json({ error: 'not_found' }, { status: 404 })
  },
  async update(update) { await handleUpdate(update) },
  async probe() { return quoteFeed.probe() },
  feedStatus() { return quoteFeed.status() },
  async stream(signal, dispatch) { return quoteFeed.stream(onTick, signal, dispatch) },
  async capital() { return quoteFeed.capital(onTick) },
  async housekeeping() {
    // No per-second database checkpoint. Only real user mutations/deliveries write.
    for (const event of db.events.filter(e=>e.delivery==='pending')) {
      event.delivery='attempting'; await save()
      try {await tg('sendMessage',{chat_id:event.userId,text:event.text});event.delivery='sent'}
      catch(e){event.delivery=e.retrySafe?'pending':e.definite?'failed':'unknown';await save();if(e.retrySafe)throw e}
      await save()
    }
    await checkLive()
    await checkH4()
    await checkNews()
    await watchFeed()
  },
  async inspect() { const h4 = await getH4Store(), live = await getLiveStore(); if (!h4 || !live) throw new Error('reminder_storage_unavailable'); return { alerts: db.alerts.length, activeAlerts: db.alerts.filter(a=>a.status==='active').length, purchases: Object.keys(db.owned).length, h4Users: Object.keys(h4.all()).length, liveReminders: live.all().length } },
}
async function watchFeed() {
  if(Date.now()-engineBornAt<20000)return // avoid a false outage warning while initial stream connects
  const stale = db.alerts.filter(a => a.status === 'active' && quoteFeed.marketOpen() && !quoteFeed.fresh(a.symbol))
  const users = [...new Set(stale.map(a=>a.userId))]
  if (users.length && !feedDown) {
    feedDown = true; downUsers = users
    await adminNotify('Price feed unavailable. Streaming alerts paused until fresh quotes arrive.', 'feed', 300000)
    for (const uid of users) await notify(uid, '⚠️ Price feed unavailable. Price alerts are paused until fresh quotes arrive.')
  } else if (!users.length && feedDown) {
    feedDown = false
    for (const uid of downUsers) await notify(uid, '✅ Price feed recovered. Streaming alerts are active again.')
    downUsers = []
  }
}
}
