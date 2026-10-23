// GBPUSD only. Existing authenticated alert API remains the authority.
(() => {
  const $ = s => document.querySelector(s)
  let chart, series, api, getQuote, tf = 'M15', rows = [], hasMore = false, busy = false, generation = 0
  let chosen, draft, lines = [], alerts = [], active = false, loadedAt = 0, historyStale = true, lastLive = 0, listVersion = 0
  const seconds = { M15: 900, H1: 3600, H4: 14400, D1: 86400 }
  const panel = () => $('#gbpChart')
  const status = text => { $('#chartStatus').textContent = text }
  async function call(path, options) {
    const r = await api(path, options)
    if (r?.error) throw new Error(r.error === 'limit' ? `Лимит алертов: ${r.max}` : r.error)
    return r
  }
  function selection(price, alert) {
    if (!Number.isFinite(price) || price <= 0) return
    chosen = alert || null
    $('#chartPrice').value = price.toFixed(5)
    $('#chartTicket').hidden = false
    $('#chartAdd').hidden = !!chosen; $('#chartDelete').hidden = !chosen
    const q = getQuote()
    $('#chartDirection').value = alert?.dir || (price >= (q?.price || price) ? 'above' : 'below')
    paintDraft(price)
  }
  function paintDraft(price) {
    if (draft) series.removePriceLine(draft)
    draft = Number.isFinite(price) && price > 0 ? series.createPriceLine({ price, color: '#e6c887', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: chosen ? 'Выбранный алерт' : 'Новый уровень' }) : null
  }
  function clearSelection() {
    chosen = null; $('#chartTicket').hidden = true
    if (draft) series.removePriceLine(draft)
    draft = null
  }
  function paintAlerts() {
    for (const line of lines) series.removePriceLine(line)
    lines = alerts.filter(a => a.symbol === 'GBPUSD' && a.status === 'active').map(a => series.createPriceLine({ price: a.level, color: '#8bbab2', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `${a.dir === 'above' ? '▲' : '▼'} #${a.id}` }))
    const select = $('#chartExisting'); select.replaceChildren(new Option('Выбрать существующий алерт…', ''))
    for (const a of alerts.filter(a => a.symbol === 'GBPUSD' && a.status === 'active')) select.add(new Option(`${a.dir === 'above' ? '▲' : '▼'} ${Number(a.level).toFixed(5)} · #${a.id}`, String(a.id)))
    if (chosen && !alerts.some(a => a.id === chosen.id && a.status === 'active')) clearSelection()
  }
  async function loadAlerts() {
    const version = ++listVersion, list = await call('/api/alerts')
    if (version !== listVersion) return
    if (!Array.isArray(list)) throw new Error('Не удалось загрузить алерты')
    alerts = list; paintAlerts()
  }
  function draw(older = false) {
    const range = chart.timeScale().getVisibleLogicalRange()
    series.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })))
    if (!older && !range) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, rows.length - 65), to: rows.length + 3 })
  }
  async function history(older = false) {
    if (!active || busy || older && !hasMore) return
    busy = true; const version = generation, frame = tf
    $('#chartRetry').hidden = true
    try {
      const cursor = older && rows.length ? '&before=' + rows[0].time : ''
      const data = await call(`/api/chart/candles?symbol=GBPUSD&timeframe=${frame}${cursor}`, { signal: AbortSignal.timeout(12000) })
      if (version !== generation || !active) return
      if (!Array.isArray(data.candles)) throw new Error('История пока недоступна')
      if (older && !data.candles.length) { hasMore = false; $('#chartOlder').hidden = true; status('Достигнута граница доступной истории'); return }
      if (!data.candles.length) throw new Error('История пока недоступна')
      const range = chart.timeScale().getVisibleLogicalRange(), oldLength = rows.length
      const previousLive = lastLive, previousLast = rows.at(-1)
      const merged = new Map(rows.filter(c => !Number.isFinite(data.windowStart) || c.time >= data.windowStart).map(c => [c.time, c]))
      for (const c of data.candles) {
        // Keep newer sampled extremes while the broker response was in flight.
        const live = !c.complete && previousLast?.time === c.time && previousLive >= data.requestedAt
        merged.set(c.time, live ? { ...c, high: Math.max(c.high, previousLast.high), low: Math.min(c.low, previousLast.low), close: previousLast.close } : c)
      }
      rows = [...merged.values()].sort((a,b) => a.time-b.time).slice(-data.limit)
      if (older || !cursor && oldLength === 0) hasMore = data.hasMore
      lastLive = 0
      historyStale = data.stale; loadedAt = data.requestedAt || data.fetchedAt
      draw(older)
      if (older && range) chart.timeScale().setVisibleLogicalRange({ from: range.from + rows.length - oldLength, to: range.to + rows.length - oldLength })
      $('#chartOlder').hidden = !hasMore
      status(`OANDA · ${data.side} · ${frame} · ${rows.length} свечей${data.stale ? ' · история из кэша / устарела' : ''}`)
      update(getQuote())
    } catch (e) {
      if (version === generation) { historyStale = true; status('История недоступна; сохранённые свечи не считаются свежими. ' + e.message); $('#chartRetry').hidden = false }
    } finally { busy = false; if (version !== generation && active) history() }
  }
  function update(q) {
    if (!active || !series) return
    const fresh = q && !q.stale && q.tradeable && Date.now()-q.dataTs < 30000 && Date.now()-q.observedAt < 30000
    $('#chartFresh').textContent = fresh ? 'Цена: поток OANDA · текущая свеча предварительная' : 'Последняя цена · рынок закрыт или нет свежих данных'
    if (!fresh || !rows.length || q.dataTs <= lastLive || q.dataTs < loadedAt) return
    lastLive = q.dataTs
    const last = rows.at(-1), ts = q.dataTs / 1000
    // Never fabricate new OHLC from sampled display quotes. Await broker candle at a boundary.
    if (last.complete || ts < last.time || ts >= last.time + seconds[tf]) { $('#chartFresh').textContent = 'Цена свежая · ожидаем новую свечу OANDA'; return }
    const next = { ...last, high: Math.max(last.high, q.price), low: Math.min(last.low, q.price), close: q.price }
    rows[rows.length-1] = next; series.update({ time: next.time, open: next.open, high: next.high, low: next.low, close: next.close })
  }
  function init() {
    if (chart) return
    const lib = window.LightweightCharts
    if (!lib) throw new Error('Библиотека графика не загрузилась')
    chart = lib.createChart($('#chartCanvas'), { autoSize: true, height: 340,
      layout: { background: { color: '#191919' }, textColor: '#aaa', attributionLogo: true },
      grid: { vertLines: { color: '#242424' }, horzLines: { color: '#292929' } },
      timeScale: { timeVisible: true, secondsVisible: false }, rightPriceScale: { borderColor: '#444' },
      crosshair: { mode: lib.CrosshairMode.Normal }, handleScroll: { vertTouchDrag: false, horzTouchDrag: true }, handleScale: { pinch: true, axisPressedMouseMove: true } })
    series = chart.addSeries(lib.CandlestickSeries, { upColor: '#8bbab2', downColor: '#b07878', borderVisible: false, wickUpColor: '#8bbab2', wickDownColor: '#b07878', priceFormat: { type: 'price', precision: 5, minMove: .00001 } })
    function pick(point) {
      if (!point || point.y < 0 || point.y > 310 || !rows.length) return
      const hit = alerts.find(a => a.symbol === 'GBPUSD' && a.status === 'active' && Math.abs((series.priceToCoordinate(a.level) ?? -100) - point.y) <= 10)
      selection(hit ? hit.level : series.coordinateToPrice(point.y), hit)
    }
    chart.subscribeClick(p => pick(p.point))
    let hold, start
    const canvas = $('#chartCanvas')
    canvas.addEventListener('pointerdown', e => { if (!e.isPrimary) { clearTimeout(hold); return }; start = { x:e.clientX, y:e.clientY }; hold = setTimeout(() => { const r = canvas.getBoundingClientRect(); pick({ x:e.clientX-r.left, y:e.clientY-r.top }) }, 550) }, { passive:true })
    canvas.addEventListener('pointermove', e => { if (start && Math.hypot(e.clientX-start.x,e.clientY-start.y)>8) clearTimeout(hold) }, { passive:true })
    for (const name of ['pointerup','pointercancel']) canvas.addEventListener(name, () => clearTimeout(hold), { passive:true })
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && r.from < 12 && hasMore) history(true) })
    $('#chartExisting').onchange = e => { const a = alerts.find(a => String(a.id) === e.target.value); if (a) selection(a.level,a) }
    $('#chartPrice').oninput = () => { chosen = null; $('#chartAdd').hidden = false; $('#chartDelete').hidden = true; paintDraft(Number($('#chartPrice').value.replace(',','.'))) }
    $('#chartCancel').onclick = clearSelection
    $('#chartOlder').onclick = () => history(true)
    $('#chartRetry').onclick = () => history()
    $('#chartReset').onclick = () => chart.timeScale().setVisibleLogicalRange({ from: Math.max(0,rows.length-65), to:rows.length+3 })
    async function mutate(button, fn) { button.disabled = true; try { await fn(); clearSelection(); await loadAlerts() } catch (e) { status('Не удалось подтвердить операцию: ' + e.message + '. Перед повтором проверьте список алертов.'); await loadAlerts().catch(()=>{}) } finally { button.disabled = false } }
    $('#chartAdd').onclick = e => mutate(e.target, async () => {
      const value = $('#chartPrice').value.trim().replace(',','.'), level = Number(value)
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(level) || level <= 0) throw new Error('Введите положительную цену')
      await call('/api/alerts', { method:'POST', body:JSON.stringify({ symbol:'GBPUSD', level:Number(level.toFixed(5)), dir:$('#chartDirection').value }) })
    })
    $('#chartDelete').onclick = e => { if (chosen) mutate(e.target, () => call('/api/alerts/'+chosen.id, {method:'DELETE'})) }
    $('#chartFrames').querySelectorAll('button').forEach(b => b.onclick = () => {
      if (b.dataset.tf === tf || busy) return
      tf = b.dataset.tf; generation++; rows=[]; lastLive=0; hasMore=false; clearSelection(); series.setData([])
      $('#chartFrames').querySelectorAll('button').forEach(x => x.classList.toggle('on',x===b)); history()
    })
    setInterval(() => { if (active && !document.hidden) { history(); loadAlerts().catch(e=>status(e.message)) } }, 60000)
    // Expire the freshness label even when every network request fails.
    setInterval(() => { if (active && !document.hidden) update(getQuote()) }, 1000)
    document.addEventListener('visibilitychange', () => { if (active && !document.hidden) { update(getQuote()); history(); loadAlerts().catch(e=>status(e.message)) } })
  }
  window.PriceChart = {
    connect(options) { api=options.api; getQuote=options.getQuote },
    select(symbol) {
      active = symbol === 'GBPUSD'; panel().hidden = !active
      if (!active) { generation++; return }
      try { init(); history(); loadAlerts().catch(e=>status(e.message)) } catch(e) { status(e.message) }
    }, update,
    refreshAlerts() { if (active) loadAlerts().catch(e=>status(e.message)) }
  }
})()
