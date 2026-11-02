import { normalizeLive, newRequestId } from './live-time.js'
const el = (id) => document.getElementById(id)
const labels = { once: 'Once', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' }
let rows = [], configured = false, busy = false, loading = false, editing = null, createId = null, repeat = 'once', error = '', uncertain = false
let serverTime = Date.now(), receivedAt = performance.now()
const now = () => serverTime + performance.now() - receivedAt
async function request(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { ...H, ...options.headers }, signal: AbortSignal.timeout(15000) })
  if (r.status === 401) recoverAccess()
  const data = await r.json()
  if (!r.ok || data.error) throw new Error(data.error || 'Cannot reach server')
  return data
}
const localDate = (t) => { const d = new Date(t); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-') }
const displayDate = (at, zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
function setStatus(text) { el('liveStatus').textContent = text; el('liveRetry').classList.toggle('hide', !error) }
function controls() {
  el('liveAdd').disabled = busy || loading || !configured || uncertain
  el('liveSave').disabled = busy || uncertain
  el('liveCancel').disabled = busy
  el('liveForm').querySelectorAll('input,textarea,select,button').forEach((e) => { e.disabled = busy || (uncertain && e.id !== 'liveCancel') })
}
function renderList() {
  el('liveList').replaceChildren()
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No reminders yet.'; el('liveList').append(empty)
  }
  for (const r of rows) {
    const item = document.createElement('div'); item.className = 'item'; item.dataset.id = r.id
    const box = document.createElement('div'); box.className = 'live-copy'
    const title = document.createElement('div'); title.className = 't'; title.textContent = r.text
    const detail = document.createElement('small')
    detail.textContent = `${r.next ? displayDate(r.next, r.timezone) + ' · ' : ''}${r.status === 'paused' ? 'Paused' : r.status === 'done' ? 'Finished' : r.status === 'sending' ? 'Sending' : labels[r.repeat]} · ${r.sent}/${r.total} sent`
    const zone = document.createElement('small'); zone.textContent = r.timezone
    box.append(title, detail, zone)
    if (r.last && ['failed', 'unknown', 'missed'].includes(r.last.status)) {
      const last = document.createElement('small')
      last.textContent = ({ failed: 'Delivery failed', unknown: 'Delivery not confirmed', missed: 'Missed' }[r.last.status]) + ' · ' + displayDate(r.last.at, r.timezone)
      box.append(last)
    }
    const actions = document.createElement('div'); actions.className = 'live-controls'
    const add = (text, handler) => { const b = document.createElement('button'); b.className = 'ed'; b.type = 'button'; b.textContent = text; b.dataset.icon = text; b.disabled = busy || uncertain; b.onclick = handler; actions.append(b) }
    if (r.next) add(r.enabled ? 'Pause' : 'Resume', () => mutate(r, 'PATCH', { enabled: !r.enabled }))
    add('Edit', () => open(r))
    add('Delete', () => { if (confirm('Delete this reminder?')) mutate(r, 'DELETE') })
    box.append(actions); item.append(box); el('liveList').append(item)
  }
}
async function load() {
  if (loading || busy) return
  loading = true; controls()
  try {
    const data = await request('/api/live')
    if (uncertain) close()
    rows = data.reminders; configured = data.configured; serverTime = data.serverTime; receivedAt = performance.now(); error = ''; uncertain = false
    // Reload resolves an ambiguous write without ever resubmitting it.
    if (createId && rows.some((r) => r.id === createId)) close()
    setStatus(configured ? '' : 'Telegram delivery unavailable')
    renderList()
  } catch (e) { error = e.message; setStatus(error) }
  finally { loading = false; controls() }
}
function addTime(value = '') {
  if (el('liveTimes').children.length >= 6) return
  const row = document.createElement('div'); row.className = 'live-time'
  const input = document.createElement('input'); input.type = 'time'; input.required = true; input.value = value; input.setAttribute('aria-label', 'Notification time')
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'x'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove time')
  remove.onclick = () => { if (el('liveTimes').children.length > 1) { row.remove(); summary() } }
  input.oninput = summary; row.append(input, remove); el('liveTimes').append(row)
  summary()
}
function repeatControls() {
  el('liveRepeat').replaceChildren(...Object.entries(labels).map(([value, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.classList.toggle('on', repeat === value); b.setAttribute('aria-pressed', String(repeat === value))
    b.onclick = () => { repeat = value; repeatControls(); summary() }; return b
  }))
  el('liveCountField').classList.toggle('hide', repeat === 'once')
  el('liveCountLabel').textContent = repeat === 'weekly' ? 'Weeks (1–90)' : repeat === 'weekdays' ? 'Weekdays (1–90)' : 'Days (1–90)'
}
function input() {
  return { text: el('liveText').value, date: el('liveDate').value, times: [...el('liveTimes').querySelectorAll('input')].map((e) => e.value), timezone: el('liveZone').value, repeat, count: repeat === 'once' ? 1 : Number(el('liveCount').value) }
}
function summary() {
  if (el('liveForm').classList.contains('hide')) return
  try {
    const { schedule } = normalizeLive({ ...input(), text: el('liveText').value || 'Reminder' }, now(), editing)
    el('liveSummary').textContent = `${schedule.length} notification${schedule.length === 1 ? '' : 's'} · until ${displayDate(schedule.at(-1), el('liveZone').value)}`
  } catch (e) { el('liveSummary').textContent = e.message }
  el('liveAddTime').disabled = el('liveTimes').children.length >= 6
}
function fillZones(selected) {
  const zones = [...new Set([selected, 'UTC', ...(Intl.supportedValuesOf?.('timeZone') || [])])]
  el('liveZone').replaceChildren(...zones.map((zone) => { const option = document.createElement('option'); option.value = zone; option.textContent = zone; return option }))
  el('liveZone').value = selected
}
function open(row = null) {
  if (busy || uncertain) return
  editing = row; createId = row ? null : newRequestId(); repeat = row?.repeat || 'once'
  el('liveText').value = row?.text || ''
  const start = new Date(now() + 3600000)
  el('liveDate').value = row?.date || localDate(+start)
  el('liveCount').value = row?.count > 1 ? row.count : 2
  fillZones(row?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  el('liveTimes').replaceChildren()
  for (const time of row?.times || [start.toTimeString().slice(0, 5)]) addTime(time)
  el('liveForm').classList.remove('hide', 'enter'); repeatControls(); summary(); controls()
  el('liveText').focus(); el('liveForm').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function close() { el('liveForm').classList.add('hide'); editing = null; createId = null }
async function mutate(row, method, patch = {}) {
  if (busy || uncertain) return
  busy = true; controls(); renderList()
  try {
    await request('/api/live/' + row.id, { method, body: JSON.stringify({ ...patch, revision: row.revision }) })
    if (editing?.id === row.id) close()
  } catch (e) { error = e.message; uncertain = true; setStatus(error); toast(error) }
  finally { busy = false; if (!uncertain) await load(); controls(); renderList() }
}
el('liveForm').onsubmit = async (event) => {
  event.preventDefault()
  if (busy || uncertain) return
  const values = input()
  try { normalizeLive(values, now(), editing) } catch (e) { el('liveSummary').textContent = e.message; return }
  const id = createId
  busy = true; controls(); renderList()
  try {
    await request(editing ? '/api/live/' + editing.id : '/api/live', { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ ...values, id, revision: editing?.revision }) })
    close(); toast('Saved')
  } catch (e) { error = e.message; uncertain = true; setStatus(error); toast(error) }
  finally { busy = false; if (!uncertain) await load(); controls(); renderList() }
}
el('liveAdd').onclick = () => open()
el('liveAddTime').onclick = () => addTime()
el('liveCancel').onclick = close
el('liveRetry').onclick = load
for (const id of ['liveDate', 'liveCount', 'liveZone']) el(id).oninput = summary
const visible = () => !document.hidden && !el('p-live').classList.contains('hide')
setInterval(() => { if (visible() && el('liveForm').classList.contains('hide')) load() }, 30000)
document.addEventListener('visibilitychange', () => { if (visible() && el('liveForm').classList.contains('hide')) load() })
window.LiveReminders = { load }
