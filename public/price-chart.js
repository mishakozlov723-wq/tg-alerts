// Chart UI only; authentication, ownership and triggering remain server-side.
(() => {
  const $ = s => document.querySelector(s)
  const palette = { light: '#d4d4d0', dark: '#666662', label: '#bcbcb7', grid: '#272727' }
  let chart, series, api, getQuote, symbol, tf = 'M15', rows = [], hasMore = false, busy = false, generation = 0
  let chosen, draft, lines = [], alerts = [], active = false, loadedAt = 0, lastLive = 0, listVersion = 0, historyStale = true
  let candidate = null, holding = false, hold, start, axisDrag
  const seconds = { M15: 900, H1: 3600, H4: 14400, D1: 86400 }
  const panel = () => $('#gbpChart')
  const status = text => { $('#chartStatus').textContent = text }
  const quote = () => getQuote(symbol)
  const ownAlerts = () => alerts.filter(a => a.symbol === symbol && a.status === 'active')
  async function call(path, options) {
    const r = await api(path, options)
    if (r?.error) throw new Error(r.error === 'limit' ? `Alert limit: ${r.max}` : r.error)
    return r
  }
  function paintDraft(price, title = '') {
    if (draft) series.removePriceLine(draft)
    draft = Number.isFinite(price) && price > 0 ? series.createPriceLine({ price, color: palette.label, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }) : null
  }
  function clearSelection() {
    chosen = null; candidate = null; holding = false
    $('#chartTicket').hidden = true; $('#chartPlus').hidden = true
    if (draft) series.removePriceLine(draft)
    draft = null
    chart?.clearCrosshairPosition()
  }
  function selection(price, alert) {
    if (!Number.isFinite(price) || price <= 0) return
    chosen = alert || null
    $('#chartPrice').value = price.toFixed(5)
    $('#chartTicket').hidden = false; $('#chartPlus').hidden = true
    $('#chartAdd').hidden = !!chosen; $('#chartDelete').hidden = !chosen
    const q = quote(), fresh = isFresh(q)
    // Never infer direction from a stale quote: require an explicit choice.
    $('#chartDirection').value = alert?.dir || (fresh ? (price >= q.price ? 'above' : 'below') : '')
    paintDraft(price, 'Alert')
  }
  function paintAlerts() {
    for (const line of lines) series.removePriceLine(line)
    lines = ownAlerts().map(a => series.createPriceLine({ price: a.level, color: palette.label, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `${a.dir === 'above' ? '▲' : '▼'} #${a.id}` }))
    const select = $('#chartExisting'); select.replaceChildren(new Option('Select alert…', ''))
    for (const a of ownAlerts()) select.add(new Option(`${a.dir === 'above' ? '▲' : '▼'} ${Number(a.level).toFixed(5)} · #${a.id}`, String(a.id)))
    if (chosen && !ownAlerts().some(a => a.id === chosen.id)) clearSelection()
  }
  async function loadAlerts() {
    const version = ++listVersion, list = await call('/api/alerts')
    if (version !== listVersion || !active) return
    if (!Array.isArray(list)) throw new Error('Alerts unavailable')
    alerts = list; paintAlerts()
  }
  function draw(older = false) {
    const range = chart.timeScale().getVisibleLogicalRange()
    series.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })))
    if (!older && !range) reset()
  }
  function reset() {
    clearSelection(); chart.priceScale('right').applyOptions({ autoScale: true })
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, rows.length - 65), to: rows.length + 3 })
  }
  async function history(older = false) {
    if (!active || busy || older && !hasMore) return
    busy = true; const version = generation, frame = tf, asset = symbol
    $('#chartRetry').hidden = true
    try {
      const cursor = older && rows.length ? '&before=' + rows[0].time : ''
      const data = await call(`/api/chart/candles?symbol=${asset}&timeframe=${frame}${cursor}`, { signal: AbortSignal.timeout(12000) })
      if (version !== generation || !active) return
      if (!Array.isArray(data.candles)) throw new Error('History unavailable')
      if (older && !data.candles.length) { hasMore = false; $('#chartOlder').hidden = true; return }
      if (!data.candles.length) throw new Error('History unavailable')
      const range = chart.timeScale().getVisibleLogicalRange(), oldLength = rows.length
      const previousLive = lastLive, previousLast = rows.at(-1)
      const merged = new Map(rows.filter(c => !Number.isFinite(data.windowStart) || c.time >= data.windowStart).map(c => [c.time, c]))
      for (const c of data.candles) {
        const live = !c.complete && previousLast?.time === c.time && previousLive >= data.requestedAt
        merged.set(c.time, live ? { ...c, high: Math.max(c.high, previousLast.high), low: Math.min(c.low, previousLast.low), close: previousLast.close } : c)
      }
      rows = [...merged.values()].sort((a,b) => a.time-b.time).slice(-data.limit)
      if (older || !cursor && oldLength === 0) hasMore = data.hasMore
      lastLive = 0; historyStale = data.stale; loadedAt = data.requestedAt || data.fetchedAt
      draw(older)
      if (!oldLength) reset()
      $('#chartAxis').style.width = `${chart.priceScale('right').width()}px`
      if (older && range) chart.timeScale().setVisibleLogicalRange({ from: range.from + rows.length - oldLength, to: range.to + rows.length - oldLength })
      $('#chartOlder').hidden = !hasMore; status(''); update(quote())
    } catch (e) {
      if (version === generation) { historyStale = true; status('History unavailable · ' + e.message); $('#chartRetry').hidden = false; update(quote()) }
    } finally { busy = false; if (version !== generation && active) history() }
  }
  function isFresh(q) { return q && !q.stale && q.tradeable && Date.now()-q.dataTs < 30000 && Date.now()-q.observedAt < 30000 }
  function update(q = quote()) {
    if (!active || !series) return
    const fresh = isFresh(q)
    $('#chartFresh').textContent = [!fresh ? 'Last price' : '', historyStale || Date.now()-loadedAt > 90000 ? 'Cached history' : ''].filter(Boolean).join(' · ')
    if (!fresh || !rows.length || q.dataTs <= lastLive || q.dataTs < loadedAt) return
    lastLive = q.dataTs
    const last = rows.at(-1), ts = q.dataTs / 1000
    // Do not fabricate new candles from sampled display quotes at a boundary.
    if (last.complete || ts < last.time || ts >= last.time + seconds[tf]) return
    const next = { ...last, high: Math.max(last.high, q.price), low: Math.min(last.low, q.price), close: q.price }
    rows[rows.length-1] = next; series.update({ time: next.time, open: next.open, high: next.high, low: next.low, close: next.close })
  }
  function point(e) { const r = $('#chartCanvas').getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top } }
  function moveCandidate(p) {
    if (!p || !rows.length || p.y < 0 || p.y > $('#chartCanvas').clientHeight - 28) return
    const price = series.coordinateToPrice(p.y)
    if (!Number.isFinite(price) || price <= 0) return
    candidate = price; paintDraft(price)
    const time = chart.timeScale().coordinateToTime(p.x)
    if (time !== null) chart.setCrosshairPosition(price, time, series)
    const plus = $('#chartPlus'); plus.hidden = false; plus.style.top = `${p.y}px`
    plus.style.right = `${chart.priceScale('right').width()}px`
    plus.setAttribute('aria-label', `Add alert at ${price.toFixed(5)}`)
  }
  function init() {
    if (chart) return
    const lib = window.LightweightCharts
    if (!lib) throw new Error('Chart library unavailable')
    chart = lib.createChart($('#chartCanvas'), { autoSize: true, height: 340,
      layout: { background: { color: '#191919' }, textColor: '#aaa', attributionLogo: true },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      timeScale: { timeVisible: true, secondsVisible: false }, rightPriceScale: { borderColor: '#444', minimumWidth: 68 },
      crosshair: { mode: lib.CrosshairMode.Normal, vertLine: { color: palette.label, labelBackgroundColor: '#555551' }, horzLine: { color: palette.label, labelBackgroundColor: '#555551' } },
      trackingMode: { exitMode: lib.TrackingModeExitMode.OnNextTap },
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true }, handleScale: { pinch: true, axisPressedMouseMove: { price: true, time: true } } })
    series = chart.addSeries(lib.CandlestickSeries, { upColor: palette.light, downColor: palette.dark, borderVisible: false, wickUpColor: palette.light, wickDownColor: palette.dark, priceLineColor: palette.label, priceFormat: { type: 'price', precision: 5, minMove: .00001 } })
    // A tap may select an existing alert, but never creates a new candidate.
    chart.subscribeClick(p => {
      if (candidate !== null || !p.point) return
      const hit = ownAlerts().find(a => Math.abs((series.priceToCoordinate(a.level) ?? -100) - p.point.y) <= 10)
      if (hit) selection(hit.level, hit)
    })
    const canvas = $('#chartCanvas')
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    canvas.addEventListener('pointerdown', e => {
      clearTimeout(hold)
      if (!e.isPrimary) { holding = false; start = null; return }
      const p = point(e)
      if (p.x >= canvas.clientWidth - chart.priceScale('right').width()) return
      if (candidate !== null) clearSelection()
      start = { x:e.clientX, y:e.clientY, id:e.pointerId }
      hold = setTimeout(() => { holding = true; $('#chartTicket').hidden = true; moveCandidate(p) }, 500)
    }, { passive:true })
    canvas.addEventListener('pointermove', e => {
      if (holding && start?.id === e.pointerId) { e.preventDefault(); moveCandidate(point(e)) }
      else if (start && Math.hypot(e.clientX-start.x,e.clientY-start.y)>8) clearTimeout(hold)
    }, { passive:false })
    canvas.addEventListener('pointerup', () => { clearTimeout(hold); holding = false; start = null })
    canvas.addEventListener('pointercancel', () => { clearTimeout(hold); start = null; if (holding) clearSelection() })
    $('#chartPlus').onclick = () => { if (candidate !== null) selection(candidate) }
    // Explicit price-axis drag works for both touch and mouse without stealing pane pan/pinch.
    const axis = $('#chartAxis')
    axis.onpointerdown = e => {
      clearSelection(); const range = chart.priceScale('right').getVisibleRange()
      if (!range) return
      axisDrag = { y:e.clientY, range, id:e.pointerId }; axis.setPointerCapture(e.pointerId); e.preventDefault()
    }
    axis.onpointermove = e => {
      if (!axisDrag || e.pointerId !== axisDrag.id) return
      const { range, y } = axisDrag, mid = (range.from+range.to)/2
      const half = (range.to-range.from)/2 * Math.exp(Math.max(-4,Math.min(4,(e.clientY-y)/140)))
      chart.priceScale('right').setVisibleRange({ from: mid-half, to: mid+half }); e.preventDefault()
    }
    axis.onpointerup = axis.onpointercancel = () => { axisDrag = null }
    axis.ondblclick = reset
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && r.from < 12 && hasMore) history(true) })
    $('#chartExisting').onchange = e => { const a = ownAlerts().find(a => String(a.id) === e.target.value); if (a) selection(a.level,a) }
    $('#chartPrice').oninput = () => { chosen = null; $('#chartAdd').hidden = false; $('#chartDelete').hidden = true; paintDraft(Number($('#chartPrice').value.replace(',','.')), 'Alert') }
    $('#chartCancel').onclick = clearSelection
    $('#chartOlder').onclick = () => history(true)
    $('#chartRetry').onclick = () => history()
    $('#chartReset').onclick = reset
    async function mutate(button, fn) {
      const asset = symbol, version = generation
      button.disabled = true
      try { await fn(); if (asset === symbol && version === generation) clearSelection(); await loadAlerts() }
      catch (e) { status('Not confirmed: ' + e.message + '. Check alerts before retrying.'); await loadAlerts().catch(()=>{}) }
      finally { button.disabled = false }
    }
    $('#chartAdd').onclick = e => mutate(e.target, async () => {
      const value = $('#chartPrice').value.trim().replace(',','.'), level = Number(value), dir = $('#chartDirection').value
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(level) || level <= 0) throw new Error('Enter a positive price')
      if (!['above','below'].includes(dir)) throw new Error('Choose above or below')
      await call('/api/alerts', { method:'POST', body:JSON.stringify({ symbol, level:Number(level.toFixed(5)), dir }) })
    })
    $('#chartDelete').onclick = e => { if (chosen) return mutate(e.target, () => call('/api/alerts/'+chosen.id, {method:'DELETE'})) }
    $('#chartFrames').querySelectorAll('button').forEach(b => b.onclick = () => {
      if (b.dataset.tf === tf || busy) return
      tf = b.dataset.tf; generation++; rows=[]; lastLive=0; hasMore=false; clearSelection(); series.setData([]); reset(); historyStale = true
      $('#chartFrames').querySelectorAll('button').forEach(x => x.classList.toggle('on',x===b)); history()
    })
    setInterval(() => { if (active && !document.hidden) { history(); loadAlerts().catch(e=>status(e.message)) } }, 60000)
    setInterval(() => { if (active && !document.hidden) update(quote()) }, 1000)
    document.addEventListener('visibilitychange', () => { if (active && !document.hidden) { update(quote()); history(); loadAlerts().catch(e=>status(e.message)) } })
  }
  window.PriceChart = {
    connect(options) { api=options.api; getQuote=options.getQuote },
    select(asset) {
      const changed = asset !== symbol
      active = ['GBPUSD','EURUSD'].includes(asset); panel().hidden = !active
      if (!active) { generation++; if (chart) clearSelection(); return }
      try {
        init()
        if (changed) { symbol=asset; generation++; listVersion++; rows=[]; hasMore=false; lastLive=0; historyStale=true; clearSelection(); series.setData([]); paintAlerts(); reset(); status('Loading…') }
        $('#chartSymbol').textContent = asset
        history(); loadAlerts().catch(e=>status(e.message)); update(quote())
      } catch(e) { status(e.message) }
    }, update,
    refreshAlerts() { if (active) loadAlerts().catch(e=>status(e.message)) }
  }
})()
