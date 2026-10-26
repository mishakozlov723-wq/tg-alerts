// Chart UI only; authentication, ownership and triggering remain server-side.
(() => {
  const $ = s => document.querySelector(s)
  const palette = { light: '#d4d4d0', dark: '#666662', label: '#bcbcb7', grid: '#272727' }
  let chart, series, api, getQuote, symbol, tf = 'H4', rows = [], hasMore = false, busy = false, generation = 0
  let chosen, draft, lines = [], alerts = [], active = false, loadedAt = 0, lastLive = 0, listVersion = 0, historyStale = true
  let candidate = null, holding = false, hold, start, axisDrag, touchActive = false, multiTouch = false, scaleBase = null, candidateTime = null, manualAsset = null, draftDrag = false, mouseHover = false
  let ticketOpen = false, ticketTimer, mutating = false
  function setTicket(open) {
    const ticket = $('#chartTicket')
    const wasOpen = ticketOpen
    clearTimeout(ticketTimer); ticketOpen = open
    ticket.inert = !open
    if (open) {
      ticket.hidden = false
      void ticket.offsetHeight
      ticket.classList.add('is-open')
    } else {
      if (ticket.contains(document.activeElement)) $('#chartExisting').focus({ preventScroll: true })
      ticket.classList.remove('is-open')
      if (!wasOpen || matchMedia('(prefers-reduced-motion: reduce)').matches) ticket.hidden = true
      else ticketTimer = setTimeout(() => { if (!ticketOpen) ticket.hidden = true }, 500)
    }
  }
  function draftHit(p) {
    const price = candidate ?? (ticketOpen ? Number($('#chartPrice').value.replace(',', '.')) : NaN)
    return Number.isFinite(price) && Math.abs((series.priceToCoordinate(price) ?? -1000) - p.y) <= 14
  }
  function lineHit(p) {
    // A pointer-down never selects a saved line. Only a previous explicit tap or
    // dropdown selection unlocks the current draft; every other line stays fixed.
    if (mutating || !ticketOpen) return false
    const width = $('#chartCanvas').clientWidth - chart.priceScale('right').width()
    if (p.x < 0 || p.x >= width || p.y >= $('#chartCanvas').clientHeight - 28) return false
    return draftHit(p)
  }
  function moveDraft(p) {
    const price = series.coordinateToPrice(clamp(p.y, 1, $('#chartCanvas').clientHeight - 29))
    if (!Number.isFinite(price) || price <= 0) return
    candidate = price; paintDraft(price, chosen ? `Alert #${chosen.id}` : 'New alert')
    if (ticketOpen) $('#chartPrice').value = price.toFixed(digits())
    positionPlus()
  }
  const digits = () => ({ DXY: 3, GER40: 1, XAUUSD: 2, XAGUSD: 3 }[symbol] ?? 5)
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
  function endHold() {
    clearTimeout(hold); start = null
    if (holding) chart.applyOptions({ handleScroll: { pressedMouseMove: true } })
    holding = false; draftDrag = false
  }
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
    if (Number.isFinite(price) && price > 0) {
      if (draft) draft.applyOptions({ price, title })
      else draft = series.createPriceLine({ price, color: palette.label, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title })
    } else { if (draft) series.removePriceLine(draft); draft = null }
  }
  function clearSelection() {
    endHold(); mouseHover = false; chosen = null; candidate = null; candidateTime = null
    setTicket(false); $('#chartPlus').hidden = true
    if (draft) series.removePriceLine(draft)
    draft = null
    chart?.clearCrosshairPosition()
    if (series) paintAlerts()
  }
  function selection(price, alert) {
    if (mutating || !Number.isFinite(price) || price <= 0) return
    mouseHover = false; chosen = alert || null; candidate = alert ? null : price
    $('#chartPrice').value = price.toFixed(digits())
    setTicket(true); $('#chartPlus').hidden = true
    $('#chartNote').value = alert?.note || ''
    $('#chartAdd').hidden = false; $('#chartAdd').textContent = 'Save alert'; $('#chartDelete').hidden = !chosen
    // Changes remain local until Save alert; retain chosen.id for PATCH.
    $('#chartPrice').readOnly = false
    paintDraft(price, chosen ? `Alert #${chosen.id}` : 'New alert'); paintAlerts()
  }
  function paintAlerts() {
    for (const line of lines) series.removePriceLine(line)
    lines = ownAlerts().map(a => series.createPriceLine({ price: a.level, color: palette.label, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: `${a.dir === 'reach' ? 'Alert' : a.dir === 'above' ? '▲' : '▼'} #${a.id}` }))
    const select = $('#chartExisting'); select.replaceChildren(new Option('Select alert…', ''))
    for (const a of ownAlerts()) select.add(new Option(`${a.dir === 'reach' ? '' : a.dir === 'above' ? '▲ ' : '▼ '}${Number(a.level).toFixed(digits())} · #${a.id}`, String(a.id)))
    if (chosen && !ownAlerts().some(a => a.id === chosen.id)) clearSelection()
    if (chosen) {
      select.value = String(chosen.id)
      lines[ownAlerts().findIndex(a => a.id === chosen.id)]?.applyOptions({ lineVisible:false, axisLabelVisible:false })
    }
  }
  async function loadAlerts() {
    const version = ++listVersion, list = await call('/api/alerts')
    if (version !== listVersion || !active) return
    if (!Array.isArray(list)) throw new Error('Alerts unavailable')
    alerts = list; paintAlerts()
  }
  function draw(range) {
    series.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })))
    if (range) chart.timeScale().setVisibleLogicalRange(range)
    requestAnimationFrame(positionPlus)
  }
  function reset() {
    clearSelection(); scaleBase = null; chart.priceScale('right').applyOptions({ autoScale: true })
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
      if (older && !data.candles.length) { hasMore = false; return }
      if (!data.candles.length) throw new Error('History unavailable')
      const range = chart.timeScale().getVisibleLogicalRange(), oldLength = rows.length
      const anchorIndex = range && oldLength ? clamp(Math.floor(range.from), 0, oldLength - 1) : null
      const anchorTime = anchorIndex === null ? null : rows[anchorIndex].time
      const previousLive = lastLive, previousLast = rows.at(-1)
      const merged = new Map(rows.filter(c => !Number.isFinite(data.windowStart) || c.time >= data.windowStart).map(c => [c.time, c]))
      for (const c of data.candles) {
        const live = !c.complete && previousLast?.time === c.time && previousLive >= data.requestedAt
        merged.set(c.time, live ? { ...c, high: Math.max(c.high, previousLast.high), low: Math.min(c.low, previousLast.low), close: previousLast.close } : c)
      }
      rows = [...merged.values()].sort((a,b) => a.time-b.time).slice(-data.limit)
      if (older || !cursor && oldLength === 0) hasMore = data.hasMore
      lastLive = 0; historyStale = data.stale; loadedAt = data.requestedAt || data.fetchedAt
      const newIndex = anchorTime === null ? -1 : rows.findIndex(c => c.time === anchorTime)
      const shift = newIndex < 0 ? 0 : newIndex - anchorIndex
      draw(range && oldLength ? { from: range.from + shift, to: range.to + shift } : null)
      if (!oldLength) reset()
      $('#chartAxis').style.width = `${chart.priceScale('right').width()}px`
      status(''); update(quote())
    } catch (e) {
      if (version === generation) { historyStale = true; status('History unavailable · ' + e.message); $('#chartRetry').hidden = false; update(quote()) }
    } finally { busy = false; if (version !== generation && active) history() }
  }
  function isFresh(q) { return q && !q.stale && q.tradeable && Date.now()-q.dataTs < 30000 && Date.now()-q.observedAt < 30000 }
  function update(q = quote()) {
    if (!active || !series) return
    const fresh = isFresh(q)
    const state = window.quoteState(symbol, q)
    $('#chartFresh').textContent = [state === 'market closed' ? 'Market closed' : !fresh ? 'Last price · ' + state : '', historyStale || Date.now()-loadedAt > 90000 ? 'Cached history' : ''].filter(Boolean).join(' · ')
    if (!fresh || !rows.length || q.dataTs <= lastLive || q.dataTs < loadedAt) return
    lastLive = q.dataTs
    const last = rows.at(-1), ts = q.dataTs / 1000
    // Do not fabricate new candles from sampled display quotes at a boundary.
    if (last.complete || ts < last.time || ts >= last.time + seconds[tf]) return
    const next = { ...last, high: Math.max(last.high, q.price), low: Math.min(last.low, q.price), close: q.price }
    rows[rows.length-1] = next; series.update({ time: next.time, open: next.open, high: next.high, low: next.low, close: next.close })
    if (candidate !== null) requestAnimationFrame(positionPlus)
  }
  function point(e) { const r = $('#chartCanvas').getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top } }
  function positionPlus() {
    if (candidate === null || ticketOpen) return
    const y = series.priceToCoordinate(candidate), height = $('#chartCanvas').clientHeight - 28
    const plus = $('#chartPlus')
    plus.hidden = !Number.isFinite(y)
    if (plus.hidden) return
    plus.style.top = `${clamp(y, 22, height - 22)}px`
    plus.style.right = `${chart.priceScale('right').width()}px`
    plus.setAttribute('aria-label', `Add alert at ${candidate.toFixed(digits())}`)
  }
  function moveCandidate(p, native = false) {
    if (!p || !rows.length) return
    const y = clamp(p.y, 1, $('#chartCanvas').clientHeight - 29)
    const price = series.coordinateToPrice(y)
    if (!Number.isFinite(price) || price <= 0) return
    if (ticketOpen || mutating) return
    candidate = price; chosen = null; paintDraft(price)
    candidateTime = chart.timeScale().coordinateToTime(p.x)
    if (!native && candidateTime !== null) chart.setCrosshairPosition(price, candidateTime, series)
    positionPlus()
  }
  function manual(open, instant = false) {
    const body = $('#manualBody'), toggle = $('#manualToggle')
    if (instant) body.classList.add('no-motion')
    if (!open && body.contains(document.activeElement)) toggle.focus()
    body.inert = !open
    body.classList.toggle('collapsed', !open)
    toggle.setAttribute('aria-expanded', String(open))
    if (instant) { void body.offsetHeight; body.classList.remove('no-motion') }
  }
  function init() {
    if (chart) return
    $('#chartFrames').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf))
    $('#manualToggle').onclick = () => manual($('#manualToggle').getAttribute('aria-expanded') !== 'true')
    const lib = window.LightweightCharts
    if (!lib) throw new Error('Chart library unavailable')
    chart = lib.createChart($('#chartCanvas'), { autoSize: true, height: 340,
      layout: { background: { color: '#191919' }, textColor: '#aaa', attributionLogo: false },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, minBarSpacing: 2, maxBarSpacing: 24, shiftVisibleRangeOnNewBar: false }, rightPriceScale: { borderColor: '#444', minimumWidth: 68 },
      crosshair: { mode: lib.CrosshairMode.Normal, vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
      trackingMode: { exitMode: lib.TrackingModeExitMode.OnTouchEnd },
      kineticScroll: { mouse: false, touch: false },
      handleScroll: { vertTouchDrag: true, horzTouchDrag: true, pressedMouseMove: true }, handleScale: { pinch: true, axisPressedMouseMove: { price: false, time: true } } })
    series = chart.addSeries(lib.CandlestickSeries, { upColor: palette.light, downColor: palette.dark, borderVisible: false, wickUpColor: palette.light, wickDownColor: palette.dark, priceLineColor: palette.label, priceFormat: { type: 'price', precision: 5, minMove: .00001 } })
    // A tap may select an existing alert, but never creates a new candidate.
    chart.subscribeClick(p => {
      if (mutating || ticketOpen || !p.point) return
      const hit = ownAlerts().find(a => Math.abs((series.priceToCoordinate(a.level) ?? -100) - p.point.y) <= 10)
      if (hit) { chart.priceScale('right').applyOptions({ autoScale: false }); selection(hit.level, hit) }
    })
    const canvas = $('#chartCanvas')
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    // Native tracking owns long-press; saved/draft line hits are intercepted for editing.
    canvas.addEventListener('touchstart', e => {
      if (mutating) { e.preventDefault(); e.stopImmediatePropagation(); return }
      touchActive = true; multiTouch = e.touches.length !== 1
      draftDrag = !multiTouch && lineHit(point(e.touches[0]))
      if (draftDrag) { e.preventDefault(); e.stopImmediatePropagation(); return }
      if (multiTouch) { if (!ticketOpen) clearSelection(); else endHold(); return }
      if (!ticketOpen) clearSelection()
      const range = chart.priceScale('right').getVisibleRange()
      if (range) chart.priceScale('right').applyOptions({ autoScale: false })
    }, { capture: true, passive: false })
    canvas.addEventListener('touchmove', e => {
      if (draftDrag && e.touches.length === 1) {
        e.preventDefault(); e.stopImmediatePropagation(); moveDraft(point(e.touches[0]))
      }
    }, { capture: true, passive: false })
    // End native tracking on release so the next swipe pans normally. Retain
    // the selected price and synthetic crosshair until + or the next gesture.
    canvas.addEventListener('touchend', e => {
      touchActive = e.touches.length > 0
      if (draftDrag) { draftDrag = false; e.preventDefault(); e.stopImmediatePropagation(); positionPlus(); return }
      requestAnimationFrame(() => {
        if (!touchActive && !multiTouch && candidate !== null && candidateTime !== null) {
          chart.setCrosshairPosition(candidate, candidateTime, series); positionPlus()
        }
      })
    }, { capture: true, passive: false })
    canvas.addEventListener('touchcancel', () => { touchActive = false; multiTouch = false; clearSelection() }, { passive: true })
    chart.subscribeCrosshairMove(p => {
      if (!active || multiTouch || draftDrag || ticketOpen) return
      if (touchActive && p.point) moveCandidate(p.point, true)
      // Native tracking may emit an empty point on release. Keep the candidate.
      else if (candidate !== null) positionPlus()
    })
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || mutating) return
      endHold()
      if (!e.isPrimary || e.button > 0) return
      const p = point(e)
      if (p.x >= canvas.clientWidth - chart.priceScale('right').width() || p.y >= canvas.clientHeight - 28) return
      if (mouseHover) clearSelection()
      if (lineHit(p)) {
        draftDrag = true; holding = true
        chart.applyOptions({ handleScroll: { pressedMouseMove: false } })
        start = { x:e.clientX, y:e.clientY, id:e.pointerId }
        canvas.setPointerCapture(e.pointerId); e.preventDefault(); return
      }
      if (ticketOpen) return
      if (candidate !== null) clearSelection()
      chart.priceScale('right').applyOptions({ autoScale: false })
      start = { x:e.clientX, y:e.clientY, id:e.pointerId }
      hold = setTimeout(() => {
        holding = true; chart.applyOptions({ handleScroll: { pressedMouseMove: false } })
        canvas.setPointerCapture(e.pointerId); moveCandidate(p)
      }, 500)
    }, { passive:false })
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return
      // Desktop hover is separate from touch tracking and press/drag selection.
      if (e.pointerType === 'mouse' && window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches && !e.buttons && !start && !holding && !axisDrag && !touchActive && active && !ticketOpen) {
        const p = point(e), width = canvas.clientWidth - chart.priceScale('right').width()
        if (p.x >= 0 && p.x < width && p.y >= 0 && p.y < canvas.clientHeight - 28) {
          moveCandidate(p, true); mouseHover = candidate !== null
        } else if (mouseHover) clearSelection()
        return
      }
      if (draftDrag && start?.id === e.pointerId) { e.preventDefault(); moveDraft(point(e)); return }
      if (holding && start?.id === e.pointerId) { e.preventDefault(); moveCandidate(point(e)) }
      else if (start && Math.hypot(e.clientX-start.x,e.clientY-start.y)>5) endHold()
    }, { passive:false })
    canvas.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') endHold() })
    canvas.addEventListener('pointercancel', e => { if (e.pointerType !== 'touch') endHold() })
    canvas.addEventListener('lostpointercapture', () => endHold())
    // Keep the candidate when crossing from the canvas onto the sibling + button.
    canvas.parentElement.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse' && mouseHover && !holding && !draftDrag && !ticketOpen) clearSelection()
    })
    $('#chartPlus').onclick = () => { if (candidate !== null) selection(candidate) }
    // Explicit price-axis drag works for both touch and mouse without stealing pane pan/pinch.
    const axis = $('#chartAxis')
    axis.onpointerdown = e => {
      if (!e.isPrimary || axisDrag) return
      clearSelection(); const scale = chart.priceScale('right'), range = scale.getVisibleRange()
      if (!range || !Number.isFinite(range.to-range.from) || range.to <= range.from) return
      scaleBase ??= range.to-range.from
      scale.applyOptions({ autoScale: false })
      axisDrag = { y:e.clientY, range, id:e.pointerId }; axis.setPointerCapture(e.pointerId); e.preventDefault()
    }
    axis.onpointermove = e => {
      if (!axisDrag || e.pointerId !== axisDrag.id) return
      const { range, y } = axisDrag, mid = (range.from+range.to)/2
      // Bounds are anchored to the first drag, not multiplied on every new gesture.
      const min = Math.max(.0002, scaleBase / 5), max = Math.max(min, Math.min(scaleBase * 5, mid * 1.8))
      const span = clamp((range.to-range.from) * Math.exp(clamp((e.clientY-y)/180, -6, 6)), min, max)
      chart.priceScale('right').setVisibleRange({ from: mid-span/2, to: mid+span/2 }); e.preventDefault()
    }
    axis.onpointerup = axis.onpointercancel = axis.onlostpointercapture = () => { axisDrag = null }
    axis.ondblclick = reset
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && r.from < 12 && hasMore) history(true) })
    $('#chartExisting').onchange = e => { if (mutating) return; const a = ownAlerts().find(a => String(a.id) === e.target.value); if (a) selection(a.level,a); else clearSelection() }
    $('#chartPrice').oninput = () => {
      $('#chartAdd').hidden = false; $('#chartDelete').hidden = !chosen
      const price = Number($('#chartPrice').value.replace(',','.'))
      candidate = Number.isFinite(price) && price > 0 ? price : null
      paintDraft(price, chosen ? `Alert #${chosen.id}` : 'New alert')
    }
    $('#chartCancel').onclick = () => { if (!mutating) clearSelection() }
    $('#chartRetry').onclick = () => history()
    $('#chartReset').onclick = reset
    async function mutate(button, fn) {
      if (mutating) return
      const asset = symbol, version = generation
      mutating = true; panel().dataset.saving = 'true'
      const controls = [...panel().querySelectorAll('button,input,select')]
      const previous = controls.map(el => el.disabled)
      controls.forEach(el => { el.disabled = true })
      try {
        await fn()
        if (asset === symbol && version === generation) clearSelection()
        await loadAlerts()
      } catch (e) {
        status('Not confirmed: ' + e.message + '. Check alerts before retrying.')
        await loadAlerts().catch(()=>{})
      } finally {
        mutating = false; panel().dataset.saving = 'false'
        controls.forEach((el, i) => { el.disabled = previous[i] })
      }
    }
    $('#chartAdd').onclick = e => mutate(e.target, async () => {
      const value = $('#chartPrice').value.trim().replace(',','.'), level = Number(value)
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(level) || level <= 0) throw new Error('Enter a positive price')
      await call(chosen ? '/api/alerts/'+chosen.id : '/api/alerts', { method:chosen ? 'PATCH' : 'POST', body:JSON.stringify({ symbol, level:Number(level.toFixed(digits())), note:$('#chartNote').value }) })
    })
    $('#chartDelete').onclick = e => { if (chosen) return mutate(e.target, () => call('/api/alerts/'+chosen.id, {method:'DELETE'})) }
    $('#chartFrames').querySelectorAll('button').forEach(b => b.onclick = () => {
      if (b.dataset.tf === tf || busy || mutating) return
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
      active = ['GBPUSD','EURUSD','DXY','GER40','XAUUSD','XAGUSD'].includes(asset); panel().hidden = !active
      // Tab navigation must not reset the user's expanded form; asset changes do.
      if (asset) {
        $('#manualToggle').hidden = !active
        if (asset !== manualAsset) manual(!active, true)
        manualAsset = asset
      }
      if (!active) { generation++; touchActive = false; if (chart) clearSelection(); return }
      try {
        init()
        if (changed) { symbol=asset; series.applyOptions({ priceFormat: { type:'price', precision:digits(), minMove:10 ** -digits() } }); $('#chartPrice').step = String(10 ** -digits()); generation++; listVersion++; rows=[]; hasMore=false; lastLive=0; historyStale=true; clearSelection(); series.setData([]); paintAlerts(); reset(); status('Loading…') }
        $('#chartSymbol').textContent = asset
        history(); loadAlerts().catch(e=>status(e.message)); update(quote())
      } catch(e) { status(e.message) }
    }, update,
    refreshAlerts() { if (active) loadAlerts().catch(e=>status(e.message)) }
  }
})()
