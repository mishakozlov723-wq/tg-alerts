export function createNews(env) {
const fetch = env.FETCH || globalThis.fetch
// Красные новости из открытого календаря Forex Factory (JSON-фид faireconomy).
// Источники по порядку: 1) зеркало на GitHub (NEWS_MIRROR_URL), 2) прямой источник.
// Кэш в памяти и локальной SQLite; при ошибке держим старые данные и повторяем с растущей паузой.
const URL_THIS = env.NEWS_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const HOSTS = [URL_THIS, URL_THIS.replace('://nfs.', '://cdn-nfs.')]
const TTL = 30 * 60e3
const RETRY_MIN = 10 * 60e3
const RETRY_MAX = 60 * 60e3
const NEWS_KEY = 'tg-alerts-news'
let cache = { ts: 0, failedAt: 0, fails: 0, items: [], loaded: false }
const redis = cmd => env.LOCAL_STORE.command(cmd)

async function fetchJson(url) {
  let r
  try {
    r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
  } catch (e) {
    throw new Error(`${e.message}${e.cause && e.cause.code ? ' ' + e.cause.code : ''} (${url})`)
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`)
  return r.json()
}

async function fetchWeek(week) {
  const errors = []
  for (const h of HOSTS) {
    try { return await fetchJson(h.replace('thisweek', week)) } catch (e) { errors.push(e.message) }
  }
  throw new Error(errors.join(' | '))
}

async function loadRaw() {
  const errors = []
  const mirror = env.NEWS_MIRROR_URL
  if (mirror) {
    try {
      const j = await fetchJson(mirror)
      if (Array.isArray(j) && j.length) return { raw: j, via: 'зеркало' }
      errors.push('зеркало пустое')
    } catch (e) { errors.push('зеркало: ' + e.message) }
  }
  try {
    const thisWeek = await fetchWeek('thisweek')
    let nextWeek = []
    try { const n = await fetchWeek('nextweek'); if (Array.isArray(n)) nextWeek = n } catch {}
    return { raw: [...thisWeek, ...nextWeek], via: 'прямой источник' }
  } catch (e) { errors.push('прямой: ' + e.message) }
  throw new Error(errors.join(' || '))
}

function parseNews(raw) {
  const seen = new Set()
  return raw
    .filter((x) => x && x.impact === 'High')
    .map((x) => ({
      id: `${x.country}|${x.title}|${x.date}`,
      title: x.title,
      currency: x.country,
      time: Date.parse(x.date),
      forecast: x.forecast || '',
      previous: x.previous || '',
    }))
    .filter((n) => Number.isFinite(n.time) && !seen.has(n.id) && seen.add(n.id))
    .sort((a, b) => a.time - b.time)
}

async function getNews() {
  if (env.NEWS_SOURCE === 'mock') return mockNews()
  const now = Date.now()
  if (!cache.loaded) {
    cache.loaded = true
    try {
      const saved = JSON.parse((await redis(['GET', NEWS_KEY])) || 'null')
      if (saved && Array.isArray(saved.items)) {
        cache.items = saved.items
        cache.ts = saved.ts || 0
        console.log(`[news] из базы: ${cache.items.length}`)
      }
    } catch {}
  }
  if (cache.ts && now - cache.ts < TTL) return cache.items
  if (cache.failedAt && now - cache.failedAt < Math.min(RETRY_MIN * 2 ** (cache.fails - 1), RETRY_MAX)) return cache.items
  try {
    const { raw, via } = await loadRaw()
    const items = parseNews(raw)
    cache = { ts: now, failedAt: 0, fails: 0, items, loaded: true }
    console.log(`[news] загружено красных новостей: ${items.length} (${via})`)
    await redis(['SET', NEWS_KEY, JSON.stringify({ ts: now, items })])
  } catch (e) {
    cache.failedAt = now
    cache.fails = Math.min((cache.fails || 0) + 1, 6)
    const wait = Math.round(Math.min(RETRY_MIN * 2 ** (cache.fails - 1), RETRY_MAX) / 60e3)
    console.error('[news]', e.message, `— повтор через ${wait} мин`)
  }
  return cache.items
}

// Тестовые новости: одна совсем скоро, чтобы проверить уведомления (NEWS_SOURCE=mock).
const MOCK_START = Date.now()
function mockNews() {
  const now = MOCK_START, m = 60000
  const mk = (t, c, min, f, p) => ({ id: `mock|${t}|${min}`, title: t, currency: c, time: now + min * m, forecast: f, previous: p })
  return [
    mk('Core CPI m/m (test)', 'USD', 2, '0.3%', '0.3%'),
    mk('Non-Farm Employment Change (test)', 'USD', 90, '180K', '175K'),
    mk('BoE Gov Bailey Speaks (test)', 'GBP', 300, '', ''),
    mk('ECB Press Conference (test)', 'EUR', 1500, '', ''),
  ]
}

return { getNews, parseNews }
}
