// Cloudflare adapter: API and Telegram business rules retained from server.js.
// Node/Render entrypoint remains untouched. One DO owns synchronous SQLite commits;
// broker ingestion is serialized, background network waits are independent.
import crypto from 'node:crypto'
import { verifyAccessToken } from '../shared/access-token.mjs'
import { H4_ASSETS, normalizeH4Settings, createOandaH4, createH4Runner } from '../h4.js'
import { createH4Store } from '../h4-store.js'
import { createLiveStore, LiveConflict } from '../live-store.js'
import { newReminder, liveIdValid, liveView, createLiveRunner } from '../live.js'
import { createQuoteFeed } from './quotes.mjs'
import { createCandles } from './candles.mjs'
import { createNews } from './news.mjs'
import { validateMain } from './storage.mjs'
import { createMonitor, statusKeyboard } from './monitor.mjs'
import { sampleFeedWatch } from './feed-watch.mjs'

export async function createEngine(env) {
const fetch = env.FETCH || globalThis.fetch
const engineBornAt=Date.now()
const quoteFeed = createQuoteFeed(env)
const { SYMBOLS, prices, feedStatus, setPrice } = quoteFeed
const newsSource = createNews(env)
const { getNews } = newsSource
// Silver is a paid quote from Capital.com (epic can be changed with CAPITAL_EPIC_XAGUSD, shift with OFFSET_XAGUSD).
if (!SYMBOLS.XAGUSD) SYMBOLS.XAGUSD = { label: 'Silver', premium: true, pip: 0.01, digits: 3, base: 50, capital: env.CAPITAL_EPIC_XAGUSD || 'SILVER', offset: Number(env.OFFSET_XAGUSD || 0), duka: ['xagusd'] }
// DXY stays paid; Capital supplies its price and chart when configured.
SYMBOLS.DXY.premium = true

const BOT_TOKEN = env.BOT_TOKEN || ''
const ACCESS_SIGNING_SECRET = env.ACCESS_SIGNING_SECRET || ''
const AUTH_API_URL = env.AUTH_API_URL || 'https://retocker-access.retocker.workers.dev'
const REQUIRE_ACCESS = env.REQUIRE_ACCESS === 'true' || Boolean(ACCESS_SIGNING_SECRET)
const MOCK = (env.PRICE_SOURCE || 'mock') === 'mock'
const ADMIN_CHAT_ID = String(env.ADMIN_CHAT_ID || '1011596614')
const PREMIUM_PRICE = Number(env.PREMIUM_PRICE_RUB || 350)
const PAY_DETAILS = env.PAY_DETAILS || ''

// Durable local SQLite. Existing helper storage operations stay atomic locally.
const redis = env.LOCAL_STORE.command
const chartCandles = createCandles(env, redis)
const USE_REDIS = true
const saved = await redis(['GET','tg-alerts-db'])
if (saved === null) throw Object.assign(new Error('storage_not_initialized'), { status: 503 })
let db = validateMain(JSON.parse(saved))
quoteFeed.restore(await redis(['GET','tg-alerts:quotes:v1']))
// A source switch must not look like a crossed price level. Rearm existing
// reach alerts on the first fresh tick; preserve IDs, levels and ownership.
if (env.CAPITAL_API_KEY && env.CAPITAL_IDENTIFIER && env.CAPITAL_PASSWORD && db.dxyPriceSource !== 'capital-v1') {
  for (const a of db.alerts) if (a.symbol === 'DXY' && a.status === 'active' && a.dir === 'reach') delete a.referencePrice
  db.dxyPriceSource = 'capital-v1'
  await redis(['SET','tg-alerts-db',JSON.stringify(db)])
}
const save = async () => {
  try { await redis(['SET', 'tg-alerts-db', JSON.stringify(db)]) }
  catch (cause) { if (cause.name === 'AbortError') throw cause; const e = new Error('durable_storage_unavailable'); e.storageFailure = true; throw e }
}
// The monitoring recipient is deliberately explicit; legacy payment fallback is not authorization.
const monitorAdmin = /^\d+$/.test(String(env.ADMIN_CHAT_ID || '')) ? String(env.ADMIN_CHAT_ID) : ''
const monitor = await createMonitor({ store: redis, send: text => {
  if (!monitorAdmin || !BOT_TOKEN) throw new Error('monitor_recipient_unconfigured')
  return tg('sendMessage', { chat_id: monitorAdmin, text, reply_markup: statusKeyboard() }, 10000)
} })
const taskErrors = { h4: false, live: false, news: false }
let lastHousekeeping = monitor.snapshot().housekeepingAt || 0, accessNext = 0
const telegramHealth = { success: 0, failure: 0, code: '' }
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
const allowedSyms = (uid) => Object.keys(SYMBOLS).filter((s) => !isPremium(s) || ownsQuote(uid, s))
const symbolsFor = (uid) => Object.fromEntries(allowedSyms(uid).map((s) => [s, { pip: SYMBOLS[s].pip, digits: SYMBOLS[s].digits }]))

// ---------- notifications ----------
function trimEvents() {
  while(db.events.length>500){const i=db.events.findIndex(e=>!['pending','attempting'].includes(e.delivery));if(i<0)break;db.events.splice(i,1)}
}
function enqueue(userId, text, extra = {}) {
  const event = { id: db.seq++, userId, text, ts: Date.now(), delivery: 'pending', ...extra }
  db.events.push(event)
  trimEvents()
  return event
}
async function deliverEvent(event) {
  if (event.delivery !== 'pending' || (event.retryAt || 0) > Date.now()) return event.delivery
  const h4 = event.h4 && (await getH4Store())?.get(event.userId)
  // Recheck after awaits: a parallel delivery may already own this entry.
  if (event.delivery !== 'pending') return event.delivery
  if (event.expiresAt && event.expiresAt <= Date.now() || event.orderId && db.orders[event.orderId]?.status !== 'paid' ||
      event.h4 && (!h4?.enabled || h4.since !== event.h4.since || !h4.symbols.includes(event.h4.symbol) || !h4Allowed(event.userId, event.h4.symbol)) ||
      event.feedNotice && !feedNoticeCurrent(event, feedRecipients())) {
    event.delivery = 'expired'; await save(); return event.delivery
  }
  event.delivery = 'attempting'
  await save() // Unknown outcomes after this checkpoint must never be blindly retried.
  if (BOT_TOKEN && /^\d+$/.test(event.userId)) {
    try {
      await tg('sendMessage', { chat_id: event.userId, text: event.text, ...(event.reply_markup ? { reply_markup: event.reply_markup } : {}) })
      event.delivery = 'sent'; delete event.retryAt
    } catch (e) {
      event.delivery = e.retrySafe ? 'pending' : e.definite ? 'failed' : 'unknown'
      if (e.retrySafe) event.retryAt = Date.now() + (e.retryAfterMs || 0)
      await save()
      if (e.retrySafe && !e.definite) throw e // Preserve outbound-budget rotation.
      return event.delivery
    }
  } else event.delivery = 'failed'
  await save()
  return event.delivery
}
async function notify(userId, text) {
  const event = enqueue(userId, text)
  await save()
  // Price processing must finish even when the current outbound budget is exhausted.
  try { return await deliverEvent(event) } catch (e) { if (!e.retrySafe) throw e; return event.delivery }
}

// ---------- OANDA H4 reminders (independent from quote alerts/news) ----------
const h4Raw = createOandaH4({ env, fetcher: fetch })
let h4States = {}
const h4Source = { configured: h4Raw.configured, async get(symbols) { const states = await h4Raw.get(symbols); h4States = states; return states } }
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
async function deliverLive(uid, text) {
  if (!BOT_TOKEN || !/^\d+$/.test(uid)) throw new Error('Telegram delivery is not configured for this user')
  // The Live runner owns its claim/retry/status; never create a detached retry.
  await tg('sendMessage', { chat_id: uid, text }, 10000)
  db.events.push({ id: db.seq++, userId: uid, text, ts: Date.now(), delivery: 'sent' })
  trimEvents(); await save()
}
async function deliverH4(uid, text, { event, settings }) {
  // Keep identity, settings version and deadline with the durable outbox entry.
  enqueue(uid, text, { h4: { symbol: event.symbol, since: settings.since },
    expiresAt: event.at + (event.lead ? 60000 : 120000) })
  await save()
}
const runH4 = createH4Runner({
  getSettings: () => h4Store?.all() || {}, source: h4Source,
  allowed: h4Allowed, claim: (key, now, context) => h4Store.claim(key, now, context), deliver: deliverH4,
  onError: () => { taskErrors.h4 = true },
})
async function checkH4() {
  const store = await getH4Store()
  if (!store) return
  await store.refresh()
  if (!h4Source.configured || !BOT_TOKEN) return
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
      liveRunner = createLiveRunner({ store, deliver: deliverLive, onError: () => { taskErrors.live = true } })
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
    // One-shot reach alerts retain their initial fresh baseline across restarts.
    // No per-tick writes: before a hit every observed price stays on that side.
    if (a.dir === 'reach' && !Number.isFinite(a.referencePrice)) {
      a.referencePrice = price; changed = true
    }
    const hit = a.dir === 'reach'
      ? Math.min(a.referencePrice, price) <= a.level && a.level <= Math.max(a.referencePrice, price)
      : a.dir === 'above' ? price >= a.level : price <= a.level
    if (!hit) continue
    a.status = 'fired'; a.firedAt = Date.now(); a.firedPrice = price; changed = true
    const shownPrice = Number(price).toFixed(SYMBOLS[sym].digits)
    enqueue(a.userId, a.note ? `🔔 ${sym} · ${shownPrice}\n${a.note}` : `🔔 ${sym} ${a.dir === 'reach' ? 'reached' : a.dir} ${a.level} (price ${shownPrice})`)
    // Fired state and outbox commit together; Telegram never holds the tick queue.
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
      // Catch up until the event starts; coalesce overdue leads into one message.
      const due = s.lead.filter(lead => minsLeft > 0 && minsLeft <= lead && !db.sentNews[`${userId}|${n.id}|${lead}`])
      if (due.length) {
        for (const lead of due) db.sentNews[`${userId}|${n.id}|${lead}`] = 1
        const extra = n.forecast || n.previous ? `\nForecast: ${n.forecast || '-'} · Prev: ${n.previous || '-'}` : ''
        const event = enqueue(userId, `🔴 ${n.currency} ${n.title}\nIn ${Math.max(1, Math.ceil(minsLeft))} min${extra}`, { expiresAt: n.time })
        await save() // Deduplication markers and queued message commit together.
        await deliverEvent(event)
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
  try {
  const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(ms),
  })
  const data = await r.json()
  if (!r.ok || !data.ok) {
    const e = new Error('Telegram delivery rejected'); e.definite = true; e.telegramCode = Number(data.error_code || r.status)
    // Only a structured rejection proves that sendMessage was not accepted.
    // An unstructured proxy error or a network timeout remains ambiguous.
    e.retrySafe = data.ok === false && (r.status === 429 || data.error_code === 429 || r.status >= 500 || data.error_code >= 500)
    const seconds = Number(data.parameters?.retry_after)
    if (e.retrySafe) e.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, seconds * 1000) : 10000
    throw e
  }
  if (method === 'sendMessage') telegramHealth.success = Date.now()
  return data
  } catch (e) {
    if (method === 'sendMessage' && (e.definite || !e.retrySafe)) {
      telegramHealth.failure = Date.now(); telegramHealth.code = e.telegramCode ? `HTTP ${e.telegramCode}` : 'network_unknown'
    }
    throw e
  }
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
const dirSym = (d) => (d === 'reach' ? '◇' : d === 'above' ? '▲' : '▼')
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

async function refreshDiagnostics() {
  const now = Date.now(), warm = now - engineBornAt < 30000
  await redis(['GET', 'tg-alerts-db']) // Exercise the real storage, not just in-memory objects.
  monitor.sample('storage', 'SQLite', 'ok', 'Основная база доступна; записи подтверждаются при реальных изменениях.')
  const scheduler = env.RUNTIME_STATUS?.()
  const late = lastHousekeeping && now - lastHousekeeping > 90000
  monitor.sample('scheduler', 'Фоновые задачи', scheduler?.enabled === false || late || monitor.snapshot().schedulerFailed ? 'error' : lastHousekeeping ? 'ok' : 'unknown',
    `Последний полный проход: ${lastHousekeeping ? new Date(lastHousekeeping).toISOString() : 'ещё не завершён'}; окно: ${scheduler ? scheduler.active ? 'активно' : 'между запусками' : 'нет runtime-метрики'}; исходящих запросов: ${scheduler?.calls ?? '—'}.`)
  const needed = new Set(['EURUSD', 'GBPUSD', 'DXY', ...Object.values(db.owned).flat(), ...db.alerts.filter(a => a.status === 'active').map(a => a.symbol)])
  const stale = [...needed].filter(s => !quoteFeed.fresh(s)), feed = quoteFeed.status(), open = quoteFeed.marketOpen()
  const lines = [...needed].map(s => { const p = prices[s]; return `${s}: ${!p ? 'нет цены' : `${quoteFeed.fresh(s) ? 'свежая' : 'последняя'}, возраст источника ${Math.max(0, Math.round((now - p.dataTs) / 1000))} с`}` })
  monitor.sample('quotes', 'Котировки', !open ? 'idle' : stale.length ? warm ? 'unknown' : 'error' : feed.connected ? 'ok' : 'warn',
    `${open ? 'Рыночная сессия ожидается' : 'Вне общей Forex-сессии (расписания CFD могут отличаться)'}; источник: ${feed.source}.\n${lines.join('\n')}${feed.errors.capital ? '\nCapital: источник недоступен.' : ''}`)
  const news = newsSource.status()
  monitor.sample('news', 'Новости', news.mock ? 'warn' : news.fails || taskErrors.news ? 'error' : !news.lastSuccess ? 'unknown' : now - news.lastSuccess > 7200000 ? 'warn' : 'ok',
    `Источник: ${news.mock ? 'тестовый' : 'Forex Factory / настроенное зеркало'}; последняя успешная загрузка: ${news.lastSuccess ? new Date(news.lastSuccess).toISOString() : 'нет'}; событий: ${news.items}, будущих: ${news.upcoming}; ошибок подряд: ${news.fails}. Пустой календарь сам по себе не ошибка.`)
  const pending = db.events.filter(e => e.delivery === 'pending'), uncertain = db.events.filter(e => ['failed','unknown','attempting'].includes(e.delivery) && now - (e.ts || 0) < 86400000)
  const overdue = pending.filter(e => now - (e.ts || now) > 120000)
  const recentFailure = telegramHealth.failure > telegramHealth.success && now - telegramHealth.failure < 300000
  monitor.sample('delivery', 'Доставка Telegram', !BOT_TOKEN ? 'error' : overdue.length || uncertain.length || recentFailure ? 'warn' : telegramHealth.success ? 'ok' : 'unknown',
    `В очереди: ${pending.length}, старше 2 мин: ${overdue.length}; failed/unknown/attempting за 24 ч: ${uncertain.length}. Последний подтверждённый sendMessage: ${telegramHealth.success ? new Date(telegramHealth.success).toISOString() : 'пока нет'}; последняя ошибка: ${telegramHealth.code || 'нет в этом запуске'}. Неизвестные доставки не переотправляются вслепую.`)
  const h4Enabled = Object.values(h4Store?.all() || {}).filter(s => s.enabled)
  const h4Bad = Object.values(h4States).some(s => ['unavailable','unconfigured'].includes(s.status))
  monitor.sample('h4', 'H4-напоминания', !h4Store ? 'error' : !h4Enabled.length ? 'idle' : !h4Source.configured || taskErrors.h4 || h4Bad ? 'error' : Object.keys(h4States).length ? 'ok' : 'unknown',
    `Активных настроек: ${h4Enabled.length}; OANDA: ${h4Source.configured ? 'настроен' : 'не настроен'}; ${Object.entries(h4States).map(([s,v]) => `${s}: ${v.status}`).join(', ') || 'запросы свечей ещё не требовались'}. Ошибка прохода: ${taskErrors.h4 ? 'да' : 'нет'}.`)
  const reminders = liveStore?.all() || [], outcomes = reminders.flatMap(r => r.deliveries).filter(d => ['failed','unknown','missed'].includes(d.status) && now - (d.at || 0) < 86400000)
  monitor.sample('live', 'Live-напоминания', !liveStore || taskErrors.live ? 'error' : outcomes.length ? 'warn' : reminders.some(r => r.enabled) ? 'ok' : 'idle',
    `Напоминаний: ${reminders.length}; failed/unknown/missed за 24 ч: ${outcomes.length}; ошибка прохода: ${taskErrors.live ? 'да' : 'нет'}.`)
  if (!AUTH_API_URL) monitor.sample('access', 'Access', REQUIRE_ACCESS ? 'warn' : 'idle', 'AUTH_API_URL не задан; доступность Access не проверена.')
  else if (now >= accessNext) {
    accessNext = now + 300000
    try {
      const url = new URL('/health', AUTH_API_URL)
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
      const d = await r.json()
      monitor.sample('access', 'Access', r.ok && d.ok === true ? 'ok' : 'error', r.ok && d.ok === true ? 'Health доступен. Это не проверка входа, паролей или погашения кода.' : `Health не прошёл проверку (HTTP ${r.status}).`)
    } catch (e) { if (e.retrySafe) { accessNext = 0; throw e }; monitor.sample('access', 'Access', 'error', 'Health недоступен или вернул некорректный ответ; тайм-аут 5 с.') }
  }
  await monitor.flush()
}
async function showStatus(section = 'summary') {
  await refreshDiagnostics()
  return { text: monitor.render(section), reply_markup: statusKeyboard() }
}

async function handleCallback(q) {
  const uid = String(q.from.id), data = q.data || ''
  const chat = q.message && q.message.chat.id, mid = q.message && q.message.message_id
  const ans = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text })
  const edit = (text, markup) => (chat ? tg('editMessageText', { chat_id: chat, message_id: mid, text, reply_markup: markup || { inline_keyboard: [] } }) : null)
  let m
  if ((m = data.match(/^status:(summary|all|quotes|news|delivery|h4|live|scheduler|access|logs)$/))) {
    if (!monitorAdmin || uid !== monitorAdmin || String(chat) !== monitorAdmin || q.message?.chat.type !== 'private') return ans('Admin only')
    await ans()
    // Send a fresh report: avoids Telegram's message-not-modified errors on repeated clicks.
    return tg('sendMessage', { chat_id: chat, ...await showStatus(m[1]) })
  }
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
    if (o.status === 'paid') {
      const event = db.events.find(e => e.id === o.adminEventId)
      if (event?.delivery === 'pending') await deliverEvent(event)
      return ans(event?.delivery === 'pending' ? 'Queued. Waiting for confirmation' : 'Already sent, please wait')
    }
    if (o.status !== 'new') return ans('This request is closed')
    o.status = 'paid'; o.paidAt = Date.now()
    const event = enqueue(ADMIN_CHAT_ID, `💰 Payment request #${o.id}\n${who(o)}\n${nice(o.symbol)} · ${priceOf(o.symbol)} ₽`, {
      orderId: o.id,
      reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ok:${o.id}` }, { text: '✕ Decline', callback_data: `no:${o.id}` }]] },
    })
    o.adminEventId = event.id
    await save() // Persist paid state and admin outbox before any Telegram call.
    await deliverEvent(event)
    await ans(event.delivery === 'pending' ? 'Queued. Waiting for confirmation' : 'Sent. Waiting for confirmation')
    const v = payView(o)
    await edit(v.text, v.markup)
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
    const approved = m[1] === 'ok'
    o.status = approved ? 'approved' : 'declined'
    if (approved) {
      const list = BUNDLES[o.symbol] ? BUNDLES[o.symbol].syms : [o.symbol]
      db.owned[o.userId] = [...new Set([...(db.owned[o.userId] || []), ...list])]
    }
    const event = enqueue(o.userId, approved
      ? `✅ ${nice(o.symbol)} is added. Open Alerts and pick it in the list. Your alert limit is now ${PRO_ALERTS}.`
      : `❌ Payment for ${nice(o.symbol)} was not confirmed. If you did pay, contact the admin.`)
    o.resultEventId = event.id
    // Commit rights, terminal status and buyer outbox before fallible Telegram UI calls.
    await save()
    await ans(approved ? 'Approved' : 'Declined')
    await edit(`${approved ? '✅ Approved' : '✕ Declined'} #${o.id}\n${who(o)}\n${nice(o.symbol)}`)
    await deliverEvent(event)
    return
  }
  await ans()
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query)
  const m = u.message
  if (!m || !m.chat || m.chat.type !== 'private' || !m.text) return
  const uid = String(m.from.id), txt = m.text.trim()
  const statusCommand = txt.match(/^\/status(?:@\w+)?(?:\s+(all|quotes|news|delivery|h4|live|scheduler|access|logs))?$/i)
  if (statusCommand) {
    if (!monitorAdmin || uid !== monitorAdmin || String(m.chat.id) !== monitorAdmin) return
    return tg('sendMessage', { chat_id: monitorAdmin, ...await showStatus((statusCommand[1] || 'summary').toLowerCase()) })
  }
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
    return json(res, 200, Object.fromEntries(Object.entries(prices).filter(([k]) => ok.has(k)).map(([k,v]) => [k,{...v,stale:!quoteFeed.fresh(k)}])))
  }
  if (p === '/api/news') { const uid = getUserId(req); if (REQUIRE_ACCESS && !uid) return json(res, 401, { error: 'access_required' }); return json(res, 200, await getNews()) }
  if (p === '/api/access/check') { const uid = getUserId(req); return uid ? json(res, 200, { ok: true, userId: uid }) : json(res, 401, { error: 'access_required' }) }

  const uid = getUserId(req)
  if (!uid) return json(res, 401, { error: 'unauthorized' })

  if (p === '/api/chart/candles') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' })
    if (!allowedSyms(uid).includes(url.searchParams.get('symbol') || 'GBPUSD')) return json(res, 403, { error: 'quote_access_required' })
    return json(res, 200, await chartCandles.get(url.searchParams))
  }

  if (p === '/api/alerts' && req.method === 'GET') return json(res, 200, db.alerts.filter((a) => a.userId === uid).reverse())
  if (p === '/api/alerts' && req.method === 'POST') {
    const b = await body(req)
    const level = typeof b.level === 'number' || typeof b.level === 'string' && b.level.trim() ? Number(b.level) : NaN
    const dir = b.dir ?? 'reach'
    if (!SYMBOLS[b.symbol] || !allowedSyms(uid).includes(b.symbol) || !['reach', 'above', 'below'].includes(dir) || !isFinite(level) || level <= 0) return json(res, 400, { error: 'bad input' })
    const max = limitFor(uid)
    if (db.alerts.filter((x) => x.userId === uid && x.status === 'active').length >= max) return json(res, 400, { error: 'limit', max })
    const a = { id: db.seq++, userId: uid, symbol: b.symbol, dir, level, note: cleanNote(b.note), status: 'active', createdAt: Date.now() }
    if (dir === 'reach' && quoteFeed.fresh(b.symbol)) a.referencePrice = prices[b.symbol].price
    db.alerts.push(a); await save(); return json(res, 200, a)
  }
  const del = p.match(/^\/api\/alerts\/(\d+)$/)
  if (del && req.method === 'PATCH') {
    const a = db.alerts.find((x) => x.id === Number(del[1]) && x.userId === uid)
    if (!a) return json(res, 404, { error: 'not found' })
    const b = await body(req)
    if ('level' in b) {
      const level = typeof b.level === 'number' || typeof b.level === 'string' && b.level.trim() ? Number(b.level) : NaN
      if (!Number.isFinite(level) || level <= 0) return json(res, 400, { error: 'bad input' })
      if (a.status !== 'active') return json(res, 409, { error: 'alert_not_active' })
      if (!allowedSyms(uid).includes(a.symbol)) return json(res, 403, { error: 'quote_access_required' })
      // Idempotent retries of the same edit must not rearm an alert.
      if (a.level !== level) {
        a.level = level; a.dir = 'reach'; delete a.referencePrice
        if (quoteFeed.fresh(a.symbol)) a.referencePrice = prices[a.symbol].price
      }
    }
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

// Network waits run outside the tick queue. SQLite commands commit synchronously;
// event claims are set before awaits and Live/H4 preferences use atomic CAS.
let deliveryJob = null
function flushEvents() {
  if (deliveryJob) return deliveryJob
  deliveryJob = (async () => {
    for (const event of db.events.filter(e => e.delivery === 'pending')) await deliverEvent(event)
  })().finally(() => { deliveryJob = null })
  return deliveryJob
}
// Persist notification state with the same atomic record as its outbox.
db.feedWatch ||= {}

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
  async update(update) {
    await handleUpdate(update)
    if (monitor.snapshot().parts.requests) monitor.sample('requests', 'Обработчик запросов', 'ok', 'Telegram update обработан успешно.')
  },
  async watchdog() {
    if (!monitorAdmin || env.MONITOR_ALERTS === 'false') return
    const state = monitor.snapshot(), last = state.housekeepingAt || state.startedAt
    if (state.schedulerFailed || Date.now() - last > 120000) {
      monitor.sample('scheduler', 'Фоновые задачи', 'error', 'Recovery cron: успешного фонового прохода нет более 2 минут либо зафиксирован сбой. Проверяется восстановление.')
      await monitor.notify()
    }
  },
  async reportFailure(component = 'scheduler') {
    if (!monitorAdmin || env.MONITOR_ALERTS === 'false') return
    if (component === 'scheduler') monitor.progress(0)
    monitor.sample(component, component === 'scheduler' ? 'Фоновые задачи' : 'Обработчик запросов', 'error', 'Внутренняя ошибка обработки. Выполняется восстановление; payload и секреты не включены.')
    await monitor.notify()
  },
  async probe() { return quoteFeed.probe() },
  feedStatus() { return quoteFeed.status() },
  async stream(signal, dispatch) { return quoteFeed.stream(onTick, signal, dispatch) },
  async capital(dispatch) { return quoteFeed.capital(onTick, dispatch) },
  flushEvents,
  async refreshQuotes(dispatch) { return quoteFeed.refresh(onTick, dispatch) },
  async housekeeping() {
    // Sample before slow background requests can hold up queued price ingestion.
    await watchFeed()
    // Bounded display-cache checkpoint; never write on every market tick.
    await quoteFeed.checkpoint(redis)
    await flushEvents()
    taskErrors.live = false; taskErrors.h4 = false; taskErrors.news = false
    // A failing subsystem must not prevent checks of the others.
    for (const [key, fn] of [['live', checkLive], ['h4', checkH4], ['news', checkNews]]) {
      try { await fn() }
      catch (e) { if (e.storageFailure || e.retrySafe) throw e; if (key in taskErrors) taskErrors[key] = true; monitor.sample(key, key.toUpperCase(), 'error', 'Ошибка фоновой обработки; подробности исключения скрыты.') }
    }
    lastHousekeeping = Date.now()
    monitor.progress(lastHousekeeping)
    if (monitorAdmin && env.MONITOR_ALERTS !== 'false') { await refreshDiagnostics(); await monitor.notify() }
  },
  async inspect() { const h4 = await getH4Store(), live = await getLiveStore(); if (!h4 || !live) throw new Error('reminder_storage_unavailable'); return { alerts: db.alerts.length, activeAlerts: db.alerts.filter(a=>a.status==='active').length, purchases: Object.keys(db.owned).length, h4Users: Object.keys(h4.all()).length, liveReminders: live.all().length } },
}
function feedRecipients() {
  const recipients = {}
  for (const a of db.alerts) {
    if (a.status !== 'active' || isPremium(a.symbol) && !ownsQuote(a.userId, a.symbol)) continue
    ;(recipients[a.userId] ||= {})[a.symbol] = quoteFeed.fresh(a.symbol)
  }
  // The owner receives one report, not both admin and ordinary-user copies.
  if (BOT_TOKEN && ADMIN_CHAT_ID) {
    const all = Object.assign({}, ...Object.values(recipients))
    if (Object.keys(all).length) recipients[ADMIN_CHAT_ID] = all
  }
  return recipients
}
function feedNoticeCurrent(event, recipients) {
  const symbols = recipients[event.userId]
  if (!quoteFeed.marketOpen() || !symbols) return false
  const bad = Object.values(symbols).some(fresh => !fresh)
  return event.feedNotice === 'warning' ? bad : !bad
}
async function watchFeed() {
  if(Date.now()-engineBornAt<20000)return // avoid a false outage warning while initial stream connects
  const recipients = feedRecipients()
  const { messages, changed } = sampleFeedWatch(db.feedWatch, { now: Date.now(), open: quoteFeed.marketOpen(), recipients })
  let cancelled = false
  for (const event of db.events.filter(e => e.feedNotice && e.delivery === 'pending')) {
    if (!feedNoticeCurrent(event, recipients)) {
      event.delivery = 'expired'; cancelled = true
    }
  }
  for (const message of messages) {
    if (message.kind === 'recovery') {
      const warning = db.events.findLast(e => e.userId === message.userId && e.feedNotice === 'warning')
      // Do not announce recovery from a warning that was never delivered.
      if (!warning || !['sent', 'unknown', 'attempting'].includes(warning.delivery)) continue
    }
    enqueue(message.userId, message.text, { feedNotice: message.kind, expiresAt: Date.now() + 120000 })
  }
  // Commit hysteresis/cooldown and pending messages together. Existing delivery
  // handles safe retries and never blindly resends an unknown Telegram outcome.
  if (changed || messages.length || cancelled) await save()
}
}
