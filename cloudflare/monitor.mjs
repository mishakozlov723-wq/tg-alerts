// Operational metadata only: never store upstream messages, tokens or user content.
const KEY = 'tg-alerts:monitor:v1'
export const ICON = { ok: '✅', warn: '⚠️', error: '🔴', idle: '➖', unknown: '❔' }
export async function createMonitor({ store, send, clock = Date.now }) {
  let state
  try { state = JSON.parse(await store(['GET', KEY]) || 'null') } catch (e) { if (e.storageFailure) throw e }
  if (!state || state.version !== 1) state = { version: 1, parts: {}, incidents: [], notices: {}, checkedAt: 0 }
  if (!Array.isArray(state.notices)) state.notices = Object.values(state.notices || {})
  state.lastNotice ||= {}
  state.startedAt ||= clock()
  let dirty = true, savedAt = 0
  function progress(at = clock()) { state.housekeepingAt = at; state.schedulerFailed = !at; dirty = true }
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
      // Keep the latest transition per component, not stale recovery messages.
      // If an unsent outage already recovered, retain its context in the notice.
      const unsent = state.notices.find(n => n.key === key && n.pending && ['warn', 'error'].includes(n.level))
      state.notices = state.notices.filter(n => n.key !== key)
      state.notices.push({ ...incident, detail: !bad && unsent ? `${detail}\nПредшествующий сбой: ${unsent.detail}` : detail, pending: true, attemptedAt: 0 })
      // Bound operational history even during prolonged Telegram outages.
      state.notices = state.notices.filter(n => n.pending).slice(-50)
    }
    return true
  }
  async function notify() {
    await flush(Object.values(state.notices).some(n => n.pending)) // Commit transitions before Telegram; ordinary samples checkpoint at most once/minute.
    for (const notice of Object.values(state.notices)) {
      if (!notice.pending || notice.attemptedAt && clock() - notice.attemptedAt < 300000) continue
      const last = state.lastNotice[notice.key] || 0
      if (last && clock() - last < 300000) continue
      notice.pending = false; notice.attemptedAt = clock(); state.lastNotice[notice.key] = clock(); dirty = true
      await flush(true) // Ambiguous outcomes must not create a send storm after restart.
      try { await send(`${ICON[notice.level]} [Alerts] ${notice.label}\n${notice.detail}\n/status — диагностика`) }
      catch (e) {
        // Retry only when the request definitely did not reach Telegram or was rejected temporarily.
        if (e.retrySafe) { notice.pending = true; notice.attemptedAt = clock() + Math.max(0, (e.retryAfterMs || 0) - 300000); dirty = true; await flush(true) }
      }
    }
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
