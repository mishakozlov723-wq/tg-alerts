// Local fixture only: real Chromium + chart library; synthetic APIs and clipboard.
// Run: node test/refinements-browser.mjs (requires playwright-core and Chromium).
import { chromium } from 'playwright-core'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../', import.meta.url)), publicDir = path.join(root, 'public')
let html = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
const worker = readFileSync(path.join(root, 'cloudflare/worker.mjs'), 'utf8')
// Exercise the actual production HTML shims too (not just the unpatched asset).
const transform = worker.slice(worker.indexOf('    let html=await asset.text()') + '    let html=await asset.text()'.length, worker.indexOf('    return new Response(html,'))
html = vm.runInNewContext('let html = source;\n' + transform + '\nhtml', { source: html })
assert.ok(html.includes("fetch('/api/access/redeem'"))
let seq = 3, rejectNext = false, failSettings = false, redemptions = 0
let alerts = [
  { id: 1, symbol: 'EURUSD', level: 1.1005, dir: 'reach', status: 'active', note: 'first note' },
  { id: 2, symbol: 'EURUSD', level: 1.1015, dir: 'reach', status: 'active', note: 'second note' }
]
let prefs = { enabled: false, symbols: ['EURUSD'], lead: [15], atClose: true }
const mutations = [], errors = []
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local'), send = (body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  let raw = ''; for await (const chunk of req) raw += chunk
  const b = raw ? JSON.parse(raw) : {}
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname === '/api/access/redeem') { redemptions++; return rejectNext ? send({ error: 'invalid_or_expired_code' }, 401) : send({ token: 'synthetic-token' }) }
    if (u.pathname === '/api/config') return send({ authRequired: true, authApi: '/local-access', mock: false, symbols: { EURUSD: { digits: 5, pip: .0001 }, GBPUSD: { digits: 5, pip: .0001 } } })
    if (u.pathname === '/api/access/check') return send({ ok: req.headers['x-access-token'] === 'synthetic-token' })
    if (u.pathname === '/api/prices') return send(Object.fromEntries(['EURUSD','GBPUSD'].map(s => [s, { price: 1.1008, dataTs: Date.now(), observedAt: Date.now(), tradeable: true, stale: false }])))
    if (u.pathname === '/api/events') return send([])
    if (u.pathname === '/api/settings') return send({ lead: [15], currencies: ['EUR'] })
    if (u.pathname === '/api/h4/settings') {
      if (req.method === 'POST') { if (failSettings) return send({error:'save_failed'},503); prefs = b }
      return send(prefs)
    }
    if (u.pathname === '/api/h4/status') return send({ configured: true, serverTime: Date.now(), assets: { EURUSD: { status: 'waiting' }, GBPUSD: { status: 'waiting' }, XAUUSD: { status: 'locked' }, GER40: { status: 'locked' } } })
    if (u.pathname === '/api/chart/candles') {
      const now = Date.now(), step = 14400, base = Math.floor(now / (step * 1000)) * step - 99 * step
      return send({ requestedAt: now, fetchedAt: now, stale: false, limit: 2000, hasMore: false,
        candles: Array.from({ length: 100 }, (_, i) => ({ time: base + i * step, open: 1.1004, high: 1.1025, low: 1.099, close: 1.1008, complete: i < 99 })) })
    }
    if (u.pathname === '/api/alerts' && req.method === 'GET') return send(alerts)
    if (u.pathname === '/api/alerts' && req.method === 'POST') { const a = { ...b, id: seq++, dir: 'reach', status: 'active' }; alerts.push(a); mutations.push({method:'POST',...a}); return send(a) }
    if (u.pathname.startsWith('/api/alerts/')) {
      const id = Number(u.pathname.split('/').at(-1)), a = alerts.find(a => a.id === id)
      if (req.method === 'DELETE') { alerts = alerts.filter(a => a.id !== id); mutations.push({method:'DELETE',id}); return send({ ok: true }) }
      if (req.method === 'PATCH') { Object.assign(a, b); mutations.push({method:'PATCH',...b,id}); return send(a) }
    }
    return send({})
  }
  if (u.pathname === '/') { res.writeHead(200, {'content-type':'text/html'}); return res.end(html) }
  const file = path.join(publicDir, u.pathname)
  const type = u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'
  res.writeHead(200, { 'content-type': type })
  let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (u.pathname === '/price-chart.js') text = text.replace('series = chart.addSeries', 'window.fixtureChart = chart; series = window.fixtureSeries = chart.addSeries')
  res.end(text)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/local/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } })
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
  await context.addInitScript(() => {
    window.Telegram = { WebApp: { platform: 'tdesktop' } }
    window.clipboardMode = 'ok'
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => { if (window.clipboardMode === 'deny') throw new Error('denied'); return window.clipboardMode === 'bad' ? 'not a code' : '123456' } } })
  })
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin)
  await page.waitForTimeout(150)
  assert.equal(await page.locator('#accessGate').evaluate(e => e.classList.contains('hide')), true, 'Intro must be first')
  assert.equal(await page.locator('#splash').count(), 1)
  await page.waitForFunction(() => document.querySelector('#accessGate').classList.contains('is-visible'))
  await page.locator('#splash').waitFor({ state: 'detached' })
  await page.locator('#accessAction').click()
  await page.waitForTimeout(100)
  assert.equal(await page.locator('#accessCode').inputValue(), '123456')
  assert.equal(await page.locator('#accessDigits span').count(), 6)
  assert.equal(await page.locator('#accessAction').isDisabled(), true)
  assert.equal(redemptions, 0, 'Paste is never automatic login')
  await page.waitForFunction(() => !document.querySelector('#accessAction').disabled)
  assert.equal(await page.locator('#accessAction').getAttribute('data-filled'), 'true')
  await page.screenshot({path: process.env.QA_DIR ? path.join(process.env.QA_DIR,'access-desktop.png') : '/tmp/access-desktop.png'})
  rejectNext = true; await page.locator('#accessAction').click()
  await page.waitForFunction(() => !document.querySelector('#accessAction').disabled)
  assert.match(await page.locator('#accessStatus').textContent(), /Код истёк/)
  assert.equal(await page.locator('#accessCode').inputValue(), '123456')
  await page.locator('#accessCode').fill('')
  await page.evaluate(()=>{window.clipboardMode='bad'})
  await page.locator('#accessAction').click();await page.waitForTimeout(80)
  assert.match(await page.locator('#accessStatus').textContent(),/six-digit/)
  assert.equal(await page.locator('#accessCode').inputValue(),'')
  await page.evaluate(()=>{window.clipboardMode='deny';Object.assign(window.Telegram.WebApp,{isVersionAtLeast:()=>true,readTextFromClipboard:cb=>cb('123456')})})
  await page.locator('#accessAction').click();await page.waitForTimeout(100)
  assert.equal(await page.locator('#accessDigits span').count(),6,'Telegram clipboard fallback animates too')
  await page.locator('#accessCode').fill('111111');await page.waitForTimeout(600)
  assert.equal(await page.locator('#accessCode').inputValue(),'111111','Typing cancels stale paste animation')
  assert.equal(await page.locator('#accessDigits span').count(),0)
  rejectNext = false; await page.locator('#accessAction').click()
  await page.waitForFunction(() => document.querySelector('#accessGate').classList.contains('hide'))
  await page.waitForFunction(() => window.fixtureSeries && document.querySelector('#chartExisting').options.length === 3)
  assert.equal(await page.evaluate(() => window.fixtureChart.options().crosshair.vertLine.visible), false)
  assert.equal(await page.evaluate(() => window.fixtureChart.options().crosshair.horzLine.labelVisible), false)
  const canvas = page.locator('#chartCanvas')
  await canvas.scrollIntoViewIfNeeded()
  let box = await canvas.boundingBox()
  const coordinate = p => page.evaluate(p => window.fixtureSeries.priceToCoordinate(p), p)
  let y = await coordinate(1.1005)
  // An initial unselected drag must not open the editor or move a saved price.
  await page.mouse.move(box.x + 100, box.y + y); await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + y + 25, {steps:6}); await page.mouse.up()
  assert.equal(await page.locator('#chartTicket').evaluate(e => e.classList.contains('is-open')), false)
  assert.equal(alerts[0].level, 1.1005)
  await page.locator('#chartReset').click(); await canvas.scrollIntoViewIfNeeded(); box = await canvas.boundingBox(); y = await coordinate(1.1005)
  await page.mouse.click(box.x + 100, box.y + y)
  await page.waitForFunction(() => document.querySelector('#chartTicket').classList.contains('is-open'))
  assert.equal(await page.locator('#chartNote').inputValue(), 'first note')
  const before = await page.locator('#chartPrice').inputValue(), y2 = await coordinate(1.1015)
  await page.mouse.move(box.x+100,box.y+y2); await page.mouse.down(); await page.mouse.move(box.x+100,box.y+y2+20,{steps:6}); await page.mouse.up()
  assert.equal(await page.locator('#chartPrice').inputValue(), before, 'Other line stays locked')
  y = await coordinate(Number(before)); await page.mouse.move(box.x+100,box.y+y); await page.mouse.down(); await page.mouse.move(box.x+100,box.y+y+20,{steps:6}); await page.mouse.up()
  assert.notEqual(await page.locator('#chartPrice').inputValue(), before)
  assert.equal(alerts[0].level, 1.1005, 'No backend changes until Save')
  await page.locator('#chartNote').fill('updated with price')
  await page.locator('#chartAdd').click()
  await page.waitForTimeout(100)
  const closing = await page.locator('#chartTicket').boundingBox()
  assert.ok(closing && closing.height > 0, 'Close has intermediate height')
  await page.waitForFunction(() => document.querySelector('#chartTicket').hidden)
  assert.equal(alerts[0].note, 'updated with price')
  // Hover + is centered on the selected price and smaller on a fine pointer.
  await canvas.scrollIntoViewIfNeeded(); box = await canvas.boundingBox()
  await page.mouse.move(box.x + 100, box.y + 150)
  await page.waitForFunction(() => !document.querySelector('#chartPlus').hidden)
  const plus = await page.locator('#chartPlus').boundingBox()
  assert.equal(plus.width,28); assert.ok(Math.abs(plus.y+plus.height/2-(box.y+150))<2)
  await page.locator('#chartPlus').click();await page.locator('#chartNote').fill('new chart note');await page.locator('#chartAdd').click()
  await page.waitForFunction(() => document.querySelector('#chartTicket').hidden)
  assert.equal(alerts.at(-1).note,'new chart note')
  await page.locator('#manualToggle').click();await page.locator('#level').fill('1.12000');await page.locator('#alertNote').fill('manual note');await page.locator('#create').click()
  await page.waitForTimeout(150);assert.equal(alerts.at(-1).note,'manual note')
  await page.locator('[data-t=settings]').click();await page.waitForTimeout(500)
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),true)
  assert.equal(await page.locator('#h4Enabled').isDisabled(),false)
  assert.equal(await page.locator('#h4AtClose').isDisabled(),true)
  await page.locator('#h4Enabled').click();await page.waitForTimeout(400)
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),false)
  assert.equal(await page.locator('#h4AtClose').isDisabled(),false)
  failSettings = true;await page.locator('#h4Enabled').click();await page.waitForTimeout(400)
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),false,'Rejected save restores enabled state')
  failSettings = false;await page.locator('#h4Enabled').click();await page.waitForTimeout(400)
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),true)
  await page.locator('[data-t=alerts]').click();await page.waitForTimeout(700)
  const deleting = alerts[0].id
  await page.locator(`.item[data-id="${deleting}"] .x`).click();await page.waitForTimeout(100)
  assert.ok(await page.locator(`.item[data-id="${deleting}"]`).count(),'Delete has an exit animation')
  await page.waitForTimeout(500);assert.equal(await page.locator(`.item[data-id="${deleting}"]`).count(),0)
  // Mobile: clipboard denial, native/manual paste, reduced motion and no horizontal overflow.
  const mobile = await browser.newContext({ viewport:{width:390,height:844},isMobile:true,hasTouch:true })
  await mobile.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort())
  await mobile.addInitScript(()=>{window.Telegram={WebApp:{platform:'ios'}};Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>{throw new Error('denied')}}})})
  const phone = await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.goto(origin)
  await phone.waitForFunction(()=>document.querySelector('#accessGate').classList.contains('is-visible'));await phone.locator('#splash').waitFor({state:'detached'})
  await phone.locator('#accessAction').click();await phone.waitForTimeout(100)
  assert.match(await phone.locator('#accessStatus').textContent(),/Clipboard unavailable/)
  assert.equal(await phone.locator('#accessAction').isDisabled(),false)
  await phone.evaluate(()=>{const dt=new DataTransfer();dt.setData('text','654321');document.querySelector('#accessCode').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))})
  await phone.waitForTimeout(80);assert.equal(await phone.locator('#accessDigits span').count(),6)
  await phone.waitForTimeout(600);assert.equal(await phone.locator('#accessCode').inputValue(),'654321')
  await phone.screenshot({path:process.env.QA_DIR?path.join(process.env.QA_DIR,'access-mobile.png'):'/tmp/access-mobile.png'})
  await phone.emulateMedia({reducedMotion:'reduce'})
  await phone.locator('#accessCode').fill('');await phone.locator('#accessCode').fill('123456');await phone.locator('#accessAction').click()
  await phone.waitForFunction(()=>document.querySelector('#accessGate').classList.contains('hide'))
  await phone.waitForFunction(()=>window.fixtureSeries&&document.querySelector('#chartExisting').options.length>1)
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  // Native dropdown selects the sole editable line; touch drag edits only its local draft.
  await phone.locator('#chartExisting').selectOption(String(alerts[0].id));await phone.locator('#chartCanvas').scrollIntoViewIfNeeded()
  let r=await phone.locator('#chartCanvas').boundingBox(),level=Number(await phone.locator('#chartPrice').inputValue())
  let ty=await phone.evaluate(p=>window.fixtureSeries.priceToCoordinate(p),level)
  const cdp=await mobile.newCDPSession(phone)
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+100,y:r.y+ty}]})
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:r.x+100,y:r.y+ty+22}]})
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
  assert.notEqual(Number(await phone.locator('#chartPrice').inputValue()),level)
  assert.equal(alerts[0].level,level)
  await phone.locator('#chartCancel').click()
  await phone.screenshot({path:process.env.QA_DIR?path.join(process.env.QA_DIR,'chart-mobile.png'):'/tmp/chart-mobile.png'})
  assert.deepEqual(errors,[])
  console.log('PASS: intro-first; animated paste/manual fallback; explicit login/errors; real chart selected-only mouse/touch drag; no crosshair; centered compact plus; notes on create/edit/manual; smooth close/delete; settings disabled/rollback; reduced motion; mobile layout. Synthetic APIs, not production or physical Telegram.')
  await mobile.close();await context.close()
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)) }
