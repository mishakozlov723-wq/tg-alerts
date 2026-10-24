// Operational metadata only: never store upstream messages, tokens or user content.
const KEY = 'tg-alerts:monitor:v1'
const DAY_MS = 86400000
const REPORT_INTERVAL_MS = 2 * DAY_MS
// Europe/Moscow is UTC+03:00: 08:20 local = 05:20 UTC.
function firstReportAt(now) {
  const today = Math.floor(now / DAY_MS) * DAY_MS + (5 * 60 + 20) * 60000
  return today >= now ? today : today + DAY_MS
}
export const ICON = { ok: '✅', warn: '⚠️', error: '🔴', idle: '➖', unknown: '❔' }
export async function createMonitor({ store, send, clock = Date.now }) {
  let state
  try { state = JSON.parse(await store(['GET', KEY]) || 'null') } catch (e) { if (e.storageFailure) throw e }
  if (!state || state.version !== 1) state = { version: 1, parts: {}, incidents: [], notices: {}, checkedAt: 0 }
  // Clear legacy incident pushes; retain incidents for manual diagnostics.
  state.notices = []
  state.lastNotice = {}
  if (state.reportScheduleVersion !== 1 || !Number.isFinite(state.nextReportAt)) {
    state.reportScheduleVersion = 1
    state.nextReportAt = firstReportAt(clock())
    state.reportRetryAt = 0
  }
  state.startedAt ||= clock()
  let dirty = true, savedAt = 0, notifying = false
  function progress(at = clock()) {
    // A completed recovery must survive an immediate restart, not wait for throttle.
    if (at && (state.schedulerFailed || state.parts.scheduler?.level === 'error')) savedAt = 0
    state.housekeepingAt = at; state.schedulerFailed = !at; dirty = true
  }
  async function flush(force = false) {
    if (!dirty || !force && clock() - savedAt < 60000) return
    await store(['SET', KEY, JSON.stringify(state)])
    dirty = false; savedAt = clock()
  }
  function sample(key, label, level, detail) {
    const now = clock(), old = state.parts[key]
    state.parts[key] = { label, level, detail, checkedAt: now, since: old?.level === level ? old.since : now }
    state.checkedAt = now; dirty = true
    if (old?.level === level) return false
    // Initial healthy/idle samples are not incidents or notifications.
    const bad = ['warn', 'error'].includes(level), recovered = old && ['warn', 'error'].includes(old.level)
    if (bad || recovered) {
      const incident = { at: now, key, label, level, detail }
      state.incidents.push(incident); state.incidents = state.incidents.slice(-50)

    }
    return true
  }
  async function notify() {
    if (notifying) return
    notifying = true
    try {
      const now = clock()
      if (now < state.nextReportAt || now < (state.reportRetryAt || 0)) {
        await flush()
        return
      }
      const scheduledAt = state.nextReportAt
      // Reserve before Telegram: ambiguous outcomes/restarts must not cause
      // duplicate reports. Skip missed slots, retaining the Moscow 08:20 phase.
      state.nextReportAt = scheduledAt + (Math.floor((now - scheduledAt) / REPORT_INTERVAL_MS) + 1) * REPORT_INTERVAL_MS
      state.reportRetryAt = 0
      state.lastReportAttemptAt = now
      dirty = true
      await flush(true)
      try {
        await send(('🕗 Плановая сводка Alerts · раз в 2 дня, 08:20 МСК\n\n' + render('all')).slice(0, 4000))
        state.lastReportSentAt = clock(); dirty = true
        await flush(true)
      } catch (e) {
        if (e.storageFailure) throw e
        // Retry only a definite rejection of an unsent report, never an
        // incident push. An ambiguous result waits until the next report slot.
        if (e.retrySafe) {
          state.nextReportAt = scheduledAt
          state.reportRetryAt = clock() + Math.max(300000, Number(e.retryAfterMs) || 0)
          dirty = true
          await flush(true)
        }
      }
    } finally { notifying = false }
  }
  function render(section = 'summary') {
    const parts = Object.entries(state.parts), bad = parts.some(([,p]) => ['warn','error'].includes(p.level))
    const unknown = !parts.length || parts.some(([,p]) => p.level === 'unknown')
    let text = bad ? '⚠️ Alerts: есть проблемы' : unknown ? '❔ Alerts: проверка ещё не завершена' : '✅ Alerts: проверенные подсистемы в норме'
    text += `\nПроверка: ${state.checkedAt ? new Date(state.checkedAt).toISOString() : 'ещё не выполнялась'}`
    if (section === 'logs') {
      text += '\n\nПоследние инциденты (UTC):\n' + (state.incidents.slice(-12).map(i => `${new Date(i.at).toISOString()} ${ICON[i.level]} ${i.label}: ${i.detail}`).join('\n') || 'Инцидентов пока нет.')
    } else {
      const selected = section === 'summary' || section === 'all' ? parts : parts.filter(([k]) => k === section)
      for (const [, p] of selected) text += `\n\n${ICON[p.level]} ${p.label}${section === 'summary' ? '' : `\n${p.detail}\nПроверено: ${new Date(p.checkedAt).toISOString()}`}`
    }
    text += '\n\nЭто внутренняя диагностика, не гарантия доставки. Полное падение требует внешнего мониторинга.'
    return text.slice(0, 4000)
  }
  return { sample, progress, flush, notify, render, snapshot: () => structuredClone(state) }
}

export function statusKeyboard() {
  return { inline_keyboard: [
    [{ text: 'Обновить', callback_data: 'status:summary' }, { text: 'Все детали', callback_data: 'status:all' }],
    [{ text: 'Котировки', callback_data: 'status:quotes' }, { text: 'Новости', callback_data: 'status:news' }],
    [{ text: 'Доставка', callback_data: 'status:delivery' }, { text: 'H4', callback_data: 'status:h4' }, { text: 'Live', callback_data: 'status:live' }],
    [{ text: 'Фоновые задачи', callback_data: 'status:scheduler' }, { text: 'Access', callback_data: 'status:access' }],
    [{ text: 'Журнал инцидентов', callback_data: 'status:logs' }],
  ] }
}
