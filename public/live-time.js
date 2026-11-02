// Shared browser/server validation. Recurrences keep LOCAL wall-clock time, not +24h UTC.
export const LIVE_REPEATS = ['once', 'daily', 'weekdays', 'weekly']
export const LIVE_GRACE_MS = 15 * 60000
// Request IDs for idempotent creation. Older Telegram WebViews lack randomUUID;
// fall back to getRandomValues (then Math.random) in the same lowercase v4 format.
export function newRequestId(c = globalThis.crypto) {
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.random() * 256 | 0
  b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const formatters = new Map()
function formatter(zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }))
  return formatters.get(zone)
}
const parts = (at, zone) => Object.fromEntries(formatter(zone).formatToParts(at).map((x) => [x.type, x.value]))
const key = (p) => `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
export function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const d = new Date(date + 'T00:00:00Z')
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === date
}
export function localToUtc(date, time, zone) {
  const target = Date.parse(`${date}T${time}:00Z`), offsets = new Set()
  // Examine both offsets around a DST change. If a clock time occurs twice,
  // use the earlier occurrence exactly once. Nonexistent spring times are rejected.
  for (let h = -48; h <= 48; h += 12) {
    const t = target + h * 3600000, p = parts(t, zone)
    offsets.add(Date.parse(key(p) + ':00Z') - t)
  }
  const candidates = [...offsets].map((o) => target - o).filter((t) => key(parts(t, zone)) === `${date}T${time}`)
  if (!candidates.length) throw new Error(`${date} ${time} does not exist in ${zone}. Choose another time.`)
  return Math.min(...candidates)
}
export const liveScheduleKey = c => JSON.stringify([c.date, c.timezone, c.repeat, c.count, [...new Set(c.times)].sort()])
export function normalizeLive(input, now = Date.now(), previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid reminder')
  const { text, date, times, timezone, repeat, count } = input
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 500) throw new Error('Enter a reminder (up to 500 characters)')
  if (!validDate(date)) throw new Error('Choose a valid date')
  if (typeof timezone !== 'string' || timezone.length > 80) throw new Error('Invalid timezone')
  try { formatter(timezone).format(now) } catch { throw new Error('Invalid timezone') }
  if (!Array.isArray(times) || !times.length || times.length > 6 || times.some((t) => typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('Choose 1–6 valid times')
  if (!LIVE_REPEATS.includes(repeat) || !Number.isInteger(count) || count < 1 || count > 90 || (repeat === 'once' && count !== 1)) throw new Error('Choose 1–90 repeat days or weeks')
  const normalized = { text: text.trim(), date, times: [...new Set(times)].sort(), timezone, repeat, count }
  const keepSchedule = previous && liveScheduleKey(normalized) === liveScheduleKey(previous)
  const schedule = []
  let day = Date.parse(date + 'T00:00:00Z'), included = 0
  if (!keepSchedule && (day > now + 366 * 86400000 || day < now - 2 * 86400000)) throw new Error('Choose a date within the next year')
  while (included < count) {
    const weekday = new Date(day).getUTCDay()
    if (repeat !== 'weekdays' || (weekday !== 0 && weekday !== 6)) {
      const currentDate = new Date(day).toISOString().slice(0, 10)
      for (const time of normalized.times) {
        const at = localToUtc(currentDate, time, timezone)
        if (!keepSchedule && at <= now) throw new Error('All notification times must be in the future')
        schedule.push(at)
      }
      included++
    }
    day += (repeat === 'weekly' ? 7 : 1) * 86400000
  }
  return { config: normalized, schedule: schedule.sort((a, b) => a - b) }
}
