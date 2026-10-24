// Progressive UI only: original form controls remain the source of truth.
// iOS keeps its native pickers. No scheduling, permissions or network code here.
(() => {
  const platform = window.Telegram?.WebApp?.platform
  const ios = platform === 'ios' || /iPad|iPhone|iPod/.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1
  if (ios) return
  const selector = '#chartExisting,#alertFilterStatus,#alertFilterAsset,#liveDate,#liveZone,#liveTimes input[type="time"]'
  const records = new Map(), pad = n => String(n).padStart(2, '0')
  const dateValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const parseDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(value + 'T12:00:00') : new Date()
  const shade = document.createElement('div'); shade.className = 'app-picker-shade'; shade.hidden = true
  const panel = document.createElement('div'); panel.className = 'app-picker'; panel.tabIndex = -1; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'appPickerTitle')
  shade.append(panel); document.body.append(shade)
  let current = null, closeTimer, scrollLock = '', scheduled = false
  function button(text, action, className = '') {
    const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = text; b.onclick = action; return b
  }
  function titleFor(input) {
    return ({ chartExisting: 'Select alert', alertFilterStatus: 'Status', alertFilterAsset: 'Asset', liveDate: 'Start date', liveZone: 'Timezone' })[input.id] || 'Notification time'
  }
  function labelFor(input) {
    if (input.tagName === 'SELECT') return input.selectedOptions[0]?.textContent || 'Select…'
    if (input.type === 'date') return input.value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(parseDate(input.value)) : 'Select date'
    return input.value || 'Select time'
  }
  function sync(record) {
    const { input, trigger, text } = record, value = labelFor(input)
    if (text.textContent !== value) { text.textContent = value; trigger.setAttribute('aria-label', titleFor(input) + ': ' + value) }
    if (trigger.disabled !== input.disabled) trigger.disabled = input.disabled
  }
  function visible(input) { return input.isConnected && !input.closest('.hide,[hidden],[inert]') }
  function close(restore = true) {
    if (!current) return
    const old = current; current = null
    old.trigger.setAttribute('aria-expanded', 'false'); shade.classList.remove('is-open'); panel.inert = true
    document.documentElement.style.overflow = scrollLock
    clearTimeout(closeTimer); closeTimer = setTimeout(() => { if (!current) shade.hidden = true }, 220)
    if (restore && visible(old.input) && !old.trigger.disabled) old.trigger.focus({ preventScroll: true })
  }
  function commit(record, value) {
    if (record.input.disabled || !visible(record.input)) { close(false); return }
    record.input.value = value
    record.input.dispatchEvent(new Event('input', { bubbles: true }))
    record.input.dispatchEvent(new Event('change', { bubbles: true }))
    sync(record); close()
  }
  function position() {
    if (!current || shade.hidden) return
    if (window.matchMedia('(max-width:600px)').matches) { panel.style.left = ''; panel.style.top = ''; panel.style.width = ''; return }
    const r = current.trigger.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight
    const width = Math.min(vw - 24, current.input.tagName === 'SELECT' ? Math.max(290, Math.min(390, r.width)) : 330)
    panel.style.width = `${width}px`
    panel.style.left = `${Math.max(12, Math.min(r.left, vw - width - 12))}px`
    const height = panel.offsetHeight
    const below = vh - r.bottom - 12
    panel.style.top = `${Math.max(12, Math.min(below >= height ? r.bottom + 8 : r.top - height - 8, vh - height - 12))}px`
  }
  function header(title) {
    const row = document.createElement('div'); row.className = 'app-picker-header'
    const h = document.createElement('h2'); h.id = 'appPickerTitle'; h.textContent = title
    const x = button('×', () => close(), 'app-picker-close'); x.setAttribute('aria-label', 'Close picker')
    row.append(h, x); panel.append(row)
  }
  function selectPicker(record) {
    const input = record.input, list = document.createElement('div'); list.className = 'app-picker-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', titleFor(input))
    const options = [...input.options]
    let search
    function render(query = '') {
      list.replaceChildren()
      for (const option of options) {
        if (option.hidden || query && !option.textContent.toLowerCase().includes(query.toLowerCase())) continue
        const row = button('', () => commit(record, option.value), 'app-picker-option'); row.disabled = option.disabled || option.parentElement?.disabled === true
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected))
        const text = document.createElement('span'); text.textContent = option.textContent
        const mark = document.createElement('span'); mark.className = 'app-picker-check'; mark.textContent = option.selected ? '✓' : ''; mark.setAttribute('aria-hidden', 'true')
        row.append(text, mark); list.append(row)
      }
      if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'app-picker-empty'; empty.textContent = 'No matches'; list.append(empty) }
    }
    if (options.length > 12) {
      search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search timezone…'; search.setAttribute('aria-label', 'Search timezone'); search.autocomplete = 'off'; search.spellcheck = false; search.className = 'app-picker-search'
      search.oninput = () => render(search.value.trim()); panel.append(search)
    }
    render(); panel.append(list)
    return () => {
      const chosen = list.querySelector('[aria-selected="true"]')
      if (chosen) list.scrollTop = Math.max(0, chosen.offsetTop - list.offsetTop - list.clientHeight / 2)
      ;(chosen && !chosen.disabled ? chosen : list.querySelector('button:not(:disabled)') || search || panel).focus({ preventScroll: true })
    }
  }
  function datePicker(record) {
    const input = record.input, selected = input.value
    let month = parseDate(selected); month = new Date(month.getFullYear(), month.getMonth(), 1, 12)
    const body = document.createElement('div'); body.className = 'app-calendar'; panel.append(body)
    const allowed = value => (!input.min || value >= input.min) && (!input.max || value <= input.max)
    function render() {
      body.replaceChildren()
      const bar = document.createElement('div'); bar.className = 'app-calendar-heading'
      const move = delta => { const next = new Date(month.getFullYear(), month.getMonth() + delta, 1, 12); if (next.getFullYear() >= 1 && next.getFullYear() <= 9999) { month = next; render(); position() } }
      const prev = button('‹', () => move(-1)), next = button('›', () => move(1)); prev.setAttribute('aria-label', 'Previous month'); next.setAttribute('aria-label', 'Next month')
      const label = document.createElement('b'); label.textContent = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(month)
      bar.append(prev, label, next); body.append(bar)
      const grid = document.createElement('div'); grid.className = 'app-calendar-grid'
      for (const d of ['Mo','Tu','We','Th','Fr','Sa','Su']) { const span = document.createElement('span'); span.className = 'app-calendar-weekday'; span.textContent = d; grid.append(span) }
      const offset = (month.getDay() + 6) % 7, days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
      for (let i = 0; i < offset; i++) grid.append(document.createElement('span'))
      for (let day = 1; day <= days; day++) {
        const date = new Date(month.getFullYear(), month.getMonth(), day, 12), value = dateValue(date)
        const b = button(String(day), () => commit(record, value), 'app-calendar-day')
        b.disabled = !allowed(value); b.dataset.date = value; b.setAttribute('aria-label', new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' }).format(date)); b.setAttribute('aria-pressed', String(value === selected))
        if (value === dateValue(new Date())) b.classList.add('is-today')
        grid.append(b)
      }
      body.append(grid)
      const today = dateValue(new Date()), now = button('Today', () => commit(record, today), 'app-picker-secondary'); now.disabled = !allowed(today); body.append(now)
    }
    render()
    return () => (body.querySelector(`[data-date="${selected}"]:not(:disabled)`) || body.querySelector('.app-calendar-day:not(:disabled)') || panel).focus({ preventScroll: true })
  }
  function timePicker(record) {
    const [h, m] = (record.input.value || '12:00').split(':').map(Number)
    let hour = h, minute = m
    const columns = document.createElement('div'); columns.className = 'app-time-columns'
    const lists = []
    for (const [label, count, selected, change] of [['Hour',24,h,v=>hour=v],['Minute',60,m,v=>minute=v]]) {
      const col = document.createElement('div'), heading = document.createElement('div'); heading.className = 'app-time-label'; heading.textContent = label
      const list = document.createElement('div'); list.className = 'app-time-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label)
      for (let i = 0; i < count; i++) {
        const b = button(pad(i), () => { change(i); for (const row of list.children) row.setAttribute('aria-selected', String(row === b)) }, 'app-picker-option')
        b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(i === selected)); list.append(b)
      }
      col.append(heading, list); columns.append(col); lists.push(list)
    }
    panel.append(columns)
    const apply = button('Apply time', () => commit(record, `${pad(hour)}:${pad(minute)}`), 'app-picker-apply'); panel.append(apply)
    return () => {
      for (const list of lists) { const selected = list.querySelector('[aria-selected="true"]'); if (selected) list.scrollTop = selected.offsetTop - list.offsetTop - list.clientHeight / 2 }
      lists[0].querySelector('[aria-selected="true"]').focus({ preventScroll: true })
    }
  }
  function open(record) {
    if (record.input.disabled || !visible(record.input)) return
    if (current) close(false)
    clearTimeout(closeTimer); current = record; panel.replaceChildren(); panel.inert = false; record.trigger.setAttribute('aria-expanded', 'true')
    header(titleFor(record.input))
    const focus = record.input.tagName === 'SELECT' ? selectPicker(record) : record.input.type === 'date' ? datePicker(record) : timePicker(record)
    scrollLock = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden'
    shade.hidden = false; position()
    requestAnimationFrame(() => { if (current === record) { shade.classList.add('is-open'); focus() } })
  }
  function enhance(input) {
    if (records.has(input)) return
    const trigger = button('', () => open(record), 'app-picker-trigger')
    const text = document.createElement('span'), chevron = document.createElement('span'); chevron.className = 'app-picker-chevron'; chevron.setAttribute('aria-hidden', 'true'); trigger.append(text, chevron)
    trigger.setAttribute('aria-label', titleFor(input)); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false')
    const record = { input, trigger, text }; records.set(input, record)
    input.setAttribute('aria-hidden', 'true'); input.classList.add('app-picker-native'); input.tabIndex = -1; input.insertAdjacentElement('afterend', trigger)
    input.addEventListener('input', () => sync(record)); input.addEventListener('change', () => sync(record))
    input.addEventListener('focus', () => trigger.focus({ preventScroll: true }))
    input.addEventListener('invalid', e => { e.preventDefault(); if (!current) open(record) })
    sync(record)
  }
  function refresh() {
    scheduled = false
    document.querySelectorAll(selector).forEach(enhance)
    for (const [input, record] of records) {
      if (!input.isConnected) { if (current === record) close(false); record.trigger.remove(); records.delete(input) }
      else sync(record)
    }
    if (current && (!visible(current.input) || current.input.disabled)) close(false)
  }
  shade.addEventListener('click', e => { if (e.target === shade) close() })
  document.addEventListener('keydown', e => {
    if (!current) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    const focusable = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(el => el.getClientRects().length)
    if (e.key === 'Tab') {
      const first = focusable[0] || panel, last = focusable.at(-1) || panel
      if (!panel.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    const target = e.target
    if (target.classList.contains('app-picker-option') && ['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
      e.preventDefault(); const rows = [...target.parentElement.querySelectorAll('button:not(:disabled)')], i = rows.indexOf(target)
      rows[e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
    }
  }, true)
  window.addEventListener('resize', position)
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; queueMicrotask(refresh) } })
  // Watch source controls, not our own animation/selection attributes.
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled','hidden','class','min','max'] })
  refresh()
})()
