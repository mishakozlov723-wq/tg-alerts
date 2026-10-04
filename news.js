// Красные новости из открытого календаря Forex Factory (JSON-фид faireconomy).
// Берём эту и следующую неделю. Кэш 30 минут; при ошибке держим старые данные и пробуем снова через 5 минут.
const URL_THIS = process.env.NEWS_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const URL_NEXT = URL_THIS.replace('thisweek', 'nextweek')
const TTL = 30 * 60e3
const RETRY = 5 * 60e3
let cache = { ts: 0, failedAt: 0, items: [] }

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} (${url})`)
  return r.json()
}

export function parseNews(raw) {
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

export async function getNews() {
  if (process.env.NEWS_SOURCE === 'mock') return mockNews()
  const now = Date.now()
  if (cache.ts && now - cache.ts < TTL) return cache.items
  if (cache.failedAt && now - cache.failedAt < RETRY) return cache.items
  try {
    const [thisWeek, nextWeek] = await Promise.allSettled([fetchJson(URL_THIS), fetchJson(URL_NEXT)])
    if (thisWeek.status === 'rejected') throw thisWeek.reason
    const raw = [...thisWeek.value, ...(nextWeek.status === 'fulfilled' && Array.isArray(nextWeek.value) ? nextWeek.value : [])]
    cache = { ts: now, failedAt: 0, items: parseNews(raw) }
    console.log(`[news] загружено красных новостей: ${cache.items.length}`)
  } catch (e) {
    cache.failedAt = now
    console.error('[news]', e.message, '— повтор через 5 минут')
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
