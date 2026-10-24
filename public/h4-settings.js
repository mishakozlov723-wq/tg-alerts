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
    const buttons = (id, values, selected, makeLabel) => {
      el(id).replaceChildren(...values.map((value) => {
        const b = document.createElement('button')
        b.type = 'button'; b.dataset.value = value; b.textContent = makeLabel(value)
        b.classList.toggle('on', selected.includes(value)); b.setAttribute('aria-pressed', String(selected.includes(value)))
        const locked = id === 'h4Assets' && status?.assets[value]?.status === 'locked'
        b.disabled = disabled || (locked && !selected.includes(value))
        if (locked) { b.textContent += ' · locked'; b.title = 'Requires access to this quote' }
        b.onclick = () => update({ [id === 'h4Assets' ? 'symbols' : 'lead']: toggle(selected, value) })
        return b
      }))
    }
    buttons('h4Assets', Object.keys(labels), prefs?.symbols || [], (s) => labels[s])
    buttons('h4Lead', [30, 15, 10, 5, 1], prefs?.lead || [], String)
    el('h4State').textContent = error || (busy ? 'Saving…' : !status?.configured ? 'Reminders unavailable' : prefs?.enabled ? 'On' : 'Off')
    el('h4Retry').classList.toggle('hide', !error)
    renderSchedule()
  }
  function renderSchedule() {
    const now = status ? status.serverTime + performance.now() - statusPerf : 0
    const selected = prefs?.symbols || []
    el('h4Schedule').replaceChildren(...selected.map((symbol) => {
      const asset = status?.assets[symbol]
      const row = document.createElement('div'); row.className = 'item'
      const box = document.createElement('div'); const title = document.createElement('div'); title.className = 't'
      title.textContent = labels[symbol]
      const small = document.createElement('small')
      if (asset?.active && asset.active.close > now) {
        const seconds = Math.max(0, Math.ceil((asset.active.close - now) / 1000))
        const countdown = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':')
        const local = new Date(asset.active.close).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
        small.textContent = `Closes ${local} · ${countdown}`
      } else small.textContent = asset?.active ? 'Confirming candle close…' : ({ locked: 'Quote access required', unavailable: 'Sync unavailable', unconfigured: 'OANDA is not configured', waiting: 'Market closed' }[asset?.status] || 'Syncing with OANDA…')
      box.append(title, small); row.append(box); return row
    }))
  }
  async function update(patch) {
    if (busy || !prefs) return
    const next = { ...prefs, ...patch }
    if (next.enabled && (!next.symbols.length || (!next.lead.length && !next.atClose))) return toast('Select an asset and a notification time first.')
    busy = true; error = ''; render()
    try { prefs = await request('/api/h4/settings', { method: 'POST', body: JSON.stringify(next) }) }
    catch (e) { error = e.message; toast('Save not confirmed: ' + e.message) }
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
