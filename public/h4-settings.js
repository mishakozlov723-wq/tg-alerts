/* Existing app auth headers, palette and components; no Telegram bot commands. */
(() => {
  const labels = { EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD', XAUUSD: 'Gold', GER40: 'GER40' }
  let prefs = null, status = null, busy = false, loading = false, statusPerf = 0, error = ''
  const el = (id) => document.getElementById(id)
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...H, ...options.headers }, signal: AbortSignal.timeout(15000) })
    if (response.status === 401) recoverAccess()
    const data = await response.json()
    if (!response.ok || data.error) throw new Error(data.error || 'Cannot reach the server. Please retry.')
    return data
  }
  const toggle = (items, value) => items.includes(value) ? items.filter((x) => x !== value) : [...items, value]
  function render() {
    const disabled = busy || !prefs
    el('h4Enabled').disabled = disabled
    el('h4AtClose').disabled = disabled
    el('h4Enabled').setAttribute('aria-checked', String(Boolean(prefs?.enabled)))
    el('h4AtClose').setAttribute('aria-checked', String(Boolean(prefs?.atClose)))
    el('p-settings').dataset.ready = String(Boolean(prefs))
    el('p-settings').setAttribute('aria-busy', String(busy || loading))
    const buttons = (id, values, selected, makeLabel) => {
      const container = el(id)
      values.forEach((value) => {
        let b = container.querySelector(`[data-value="${value}"]`)
        if (!b) {
          b = document.createElement('button'); b.type = 'button'; b.dataset.value = value
          b.onclick = () => { const key = id === 'h4Assets' ? 'symbols' : 'lead'; update({ [key]: toggle(prefs?.[key] || [], value) }) }
          container.append(b)
        }
        const locked = id === 'h4Assets' && status?.assets[value]?.status === 'locked'
        const text = makeLabel(value) + (locked ? ' · locked' : '')
        if (b.textContent !== text) b.textContent = text
        b.classList.toggle('on', selected.includes(value)); b.setAttribute('aria-pressed', String(selected.includes(value)))
        b.dataset.locked = String(locked)
        b.disabled = disabled || (locked && !selected.includes(value))
        b.title = locked ? 'Requires access to this quote' : ''
      })
    }
    buttons('h4Assets', Object.keys(labels), prefs?.symbols || [], (s) => labels[s])
    buttons('h4Lead', [30, 15, 10, 5, 1], prefs?.lead || [], String)
    const message = error || (!prefs ? 'Loading settings…' : !status?.configured ? 'Reminders unavailable' : '')
    if (el('h4State').textContent !== message) el('h4State').textContent = message
    el('h4Retry').classList.toggle('hide', !error)
    renderSchedule()
  }
  function renderSchedule() {
    const now = status ? status.serverTime + performance.now() - statusPerf : 0
    const selected = prefs?.symbols || []
    const container = el('h4Schedule')
    for (const row of Array.from(container.children)) if (!selected.includes(row.dataset.symbol)) row.remove()
    selected.forEach((symbol, index) => {
      const asset = status?.assets[symbol]
      let row = container.querySelector(`[data-symbol="${symbol}"]`)
      if (!row) {
        row = document.createElement('div'); row.className = 'item'; row.dataset.symbol = symbol
        const box = document.createElement('div'), title = document.createElement('div'), small = document.createElement('small')
        title.className = 't'; title.textContent = labels[symbol]; box.append(title, small); row.append(box)
      }
      if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null)
      let text
      if (asset?.active && asset.active.close > now) {
        const seconds = Math.max(0, Math.ceil((asset.active.close - now) / 1000))
        const countdown = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':')
        const local = new Date(asset.active.close).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
        text = `Closes ${local} · ${countdown}`
      } else text = asset?.active ? 'Confirming candle close…' : ({ locked: 'Quote access required', unavailable: 'Sync unavailable', unconfigured: 'OANDA is not configured', waiting: 'Market closed' }[asset?.status] || 'Syncing with OANDA…')
      const small = row.querySelector('small'); if (small.textContent !== text) small.textContent = text
    })
  }
  async function update(patch) {
    if (busy || !prefs) return
    const next = { ...prefs, ...patch }
    if (next.enabled && (!next.symbols.length || (!next.lead.length && !next.atClose))) return toast('Select an asset and a notification time first.')
    const previous = prefs
    prefs = next; busy = true; error = ''; render()
    try { prefs = await request('/api/h4/settings', { method: 'POST', body: JSON.stringify(next) }) }
    catch (e) { prefs = previous; error = e.message; toast('Save not confirmed: ' + e.message) }
    finally { busy = false; render() }
  }
  async function refreshStatus() {
    status = await request('/api/h4/status'); statusPerf = performance.now()
  }
  async function load() {
    if (loading || busy) return
    loading = true
    try {
      const [value] = await Promise.all([request('/api/h4/settings'), refreshStatus()])
      prefs = value; error = ''
    } catch (e) { error = e.message }
    finally { loading = false; render() }
  }
  el('h4Enabled').onclick = () => update({ enabled: !prefs.enabled })
  el('h4AtClose').onclick = () => update({ atClose: !prefs.atClose })
  el('h4Retry').onclick = load
  const visible = () => !document.hidden && !el('p-settings').classList.contains('hide')
  setInterval(() => { if (visible()) renderSchedule() }, 1000)
  setInterval(async () => {
    if (!visible() || loading || busy) return
    try { await refreshStatus(); render() }
    catch { status = null; error = 'Cannot sync with OANDA. Please retry.'; render() }
  }, 30000)
  document.addEventListener('visibilitychange', () => { if (visible()) load() })
  window.H4Settings = { load }
})()
