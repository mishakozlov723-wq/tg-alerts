// Local fixture only: real Chromium + chart library; synthetic APIs and clipboard.
// Run: node test/refinements-browser.mjs (requires playwright-core and Chromium).
import { chromium } from 'playwright-core'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../', import.meta.url)), publicDir = path.join(root, 'public')
// The production page is served as-is: no runtime HTML patching in the worker.
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
assert.ok(html.includes("fetch('/api/access/redeem'"))
let seq = 3, rejectNext = false, failSettings = false, redemptions = 0, configDelay = 0
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
    if (u.pathname === '/api/config') { if (configDelay && req.headers['x-access-token']) await new Promise(r=>setTimeout(r,configDelay)); return send({ authRequired: true, authApi: '/local-access', mock: false, symbols: { EURUSD: { digits: 5, pip: .0001 }, GBPUSD: { digits: 5, pip: .0001 } } }) }
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
    // This legacy token is accepted by the fixture API, but the rollout must
    // still show the code gate instead of restoring it.
    localStorage.setItem('retocker.access.alerts.v1','synthetic-token')
    localStorage.setItem('retocker.access.alerts.v2','synthetic-token')
    window.entryFrames=[]
    function sampleEntry() {
      const gate=document.querySelector('#accessGate'),box=document.querySelector('.access-box'),price=document.querySelector('#price')
      if(gate&&box&&price)window.entryFrames.push({time:performance.now(),splash:!!document.querySelector('#splash'),gateHidden:gate.classList.contains('hide'),gate:+getComputedStyle(gate).opacity,box:+getComputedStyle(box).opacity,ready:document.body.classList.contains('ready'),price:+getComputedStyle(price.closest('.rise')||price).opacity,tiles:document.querySelector('#tiles').children.length})
      requestAnimationFrame(sampleEntry)
    }
    requestAnimationFrame(sampleEntry)
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
  assert.equal(await page.evaluate(()=>localStorage.getItem('retocker.access.alerts.v1')),null,'Legacy saved login was cleared')
  await page.waitForTimeout(850)
  const entranceFrames=await page.evaluate(()=>window.entryFrames)
  assert.ok(entranceFrames.some(f=>!f.splash&&!f.gateHidden&&f.gate<.05),'Panel has a committed invisible starting frame after the splash')
  assert.ok(entranceFrames.some(f=>!f.splash&&f.gate>.1&&f.gate<.9&&f.box>.01&&f.box<.99),'Panel has visible intermediate fade/slide frames, not a spawn behind the splash')
  assert.equal(await page.evaluate(()=>document.body.classList.contains('ready')),false,'Main entrance is reserved until authentication/rendering')
  assert.equal(await page.evaluate(()=>localStorage.getItem('retocker.access.alerts.v2')),null)
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
  rejectNext = false; configDelay=800
  const loginStart=await page.evaluate(()=>performance.now())
  await page.locator('#accessAction').click()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('#accessAction').isDisabled(),true,'Keep the consumed-code form busy through delayed hydration')
  assert.equal(await page.locator('#accessGate').evaluate(e=>e.classList.contains('is-visible')),true)
  assert.equal(await page.evaluate(()=>document.body.classList.contains('ready')),false)
  await page.waitForFunction(() => document.querySelector('#accessGate').classList.contains('hide'))
  await page.waitForFunction(() => window.fixtureSeries && document.querySelector('#chartExisting').options.length === 3)
  configDelay=0
  await page.waitForTimeout(1400)
  const loginFrames=await page.evaluate(start=>window.entryFrames.filter(f=>f.time>=start),loginStart)
  assert.ok(loginFrames.some(f=>f.ready&&f.gate>.05&&f.gate<.95),'Gate and hydrated view cross-fade')
  assert.ok(loginFrames.some(f=>f.ready&&f.price>.05&&f.price<.95&&f.tiles===2),'Populated app uses the normal staggered rise entrance')
  assert.ok(loginFrames.filter(f=>f.ready).every(f=>f.tiles===2),'Do not reveal before the authenticated tiles exist')
  assert.equal(await page.evaluate(()=>localStorage.getItem('retocker.access.alerts.v3')),'synthetic-token')
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
  await mobile.addInitScript(()=>{window.tgCalls=[];window.Telegram={WebApp:{platform:'ios',initData:'',ready(){window.tgCalls.push('ready')},expand(){window.tgCalls.push('expand')}}};Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>{throw new Error('denied')}}})})
  const phone = await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.goto(origin)
  assert.deepEqual(await phone.evaluate(()=>window.tgCalls),['ready','expand'],'Inside Telegram the app is shown and expanded without initData')
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
  // Stress a real chart/canvas/axis/+ crossing the fixed navigation. Spacers
  // only provide scroll range; production DOM, styles and chart are unchanged.
  async function checkNavLayer(view, viewport, touch) {
    await view.setViewportSize(viewport)
    await view.locator('.tabs [data-t=new]').click()
    await view.waitForFunction(()=>!document.querySelector('#gbpChart').hidden)
    await view.waitForTimeout(1200) // complete section-entry animations too
    await view.evaluate(()=>{
      for(const id of ['nav-test-before','nav-test-after'])document.getElementById(id)?.remove()
      const before=document.createElement('div');before.id='nav-test-before';before.style.height='600px';document.querySelector('#gbpChart').before(before)
      const after=document.createElement('div');after.id='nav-test-after';after.style.height='800px';document.querySelector('.wrap').append(after)
      const nav=document.querySelector('.tabs').getBoundingClientRect(),canvas=document.querySelector('#chartCanvas').getBoundingClientRect()
      scrollTo(0,scrollY+canvas.top+170-(nav.top+nav.height/2))
      const plus=document.querySelector('#chartPlus');plus.hidden=false;plus.style.top='170px';plus.style.right='68px'
    })
    await view.waitForTimeout(60)
    const overlap=await view.evaluate(()=>{
      const nav=document.querySelector('.tabs'),n=nav.getBoundingClientRect(),c=document.querySelector('#chartCanvas').getBoundingClientRect()
      const hits=[]
      for(const button of nav.querySelectorAll('button')) {
        const b=button.getBoundingClientRect()
        for(const y of [n.top+4,n.top+n.height/2,n.bottom-3]) {
          const hit=document.elementFromPoint(b.x+b.width/2,y)
          hits.push({tab:button.dataset.t,y,top:hit?.id||hit?.tagName,inNav:!!hit?.closest('.tabs')})
        }
      }
      return {intersects:c.top<n.bottom&&c.bottom>n.top,bg:getComputedStyle(nav).backgroundColor,hits}
    })
    assert.equal(overlap.intersects,true,'Fixture must actually overlap the graph and navigation')
    assert.ok(overlap.hits.every(h=>h.inNav),`Chart intercepted navigation at ${JSON.stringify(viewport)}: ${JSON.stringify(overlap.hits)}`)
    assert.equal(overlap.bg,'rgb(25, 25, 25)','Navigation must fully mask graph lines, not let them bleed through')
    await view.screenshot({path:path.join(process.env.QA_DIR||'/tmp',`nav-layer-${viewport.width}x${viewport.height}.png`)})
    // Authentication overlays still outrank navigation; do not raise tabs above
    // access/intro/modal layers just to solve the chart overlap.
    await view.evaluate(()=>{const gate=document.querySelector('#accessGate');gate.inert=false;gate.classList.remove('hide');gate.classList.add('is-visible')})
    assert.equal(await view.evaluate(()=>{const n=document.querySelector('.tabs').getBoundingClientRect();return !!document.elementFromPoint(100,n.top+10)?.closest('#accessGate')}),true)
    await view.evaluate(()=>{const gate=document.querySelector('#accessGate');gate.inert=true;gate.classList.add('hide');gate.classList.remove('is-visible')})
    const settings=await view.locator('.tabs [data-t=settings]').boundingBox()
    const x=settings.x+settings.width/2,y=settings.y+settings.height/2
    if(touch)await view.touchscreen.tap(x,y);else await view.mouse.click(x,y)
    await view.waitForFunction(()=>!document.querySelector('#p-settings').classList.contains('hide'))
    assert.equal(await view.locator('.tabs [data-t=settings]').evaluate(e=>e.classList.contains('on')),true)
    await view.evaluate(()=>{document.querySelector('#nav-test-before')?.remove();document.querySelector('#nav-test-after')?.remove()})
  }
  await checkNavLayer(phone,{width:390,height:640},true)
  await checkNavLayer(phone,{width:390,height:844},true) // expanded/fullscreen
  await checkNavLayer(phone,{width:844,height:390},true) // rotation
  await checkNavLayer(page,{width:1000,height:700},false)
  const beforeReopen=redemptions
  await phone.reload()
  await phone.waitForFunction(()=>window.fixtureSeries&&document.querySelector('#chartExisting').options.length>1)
  assert.equal(await phone.locator('#accessGate').evaluate(e=>e.classList.contains('hide')),true,'New login survives reopening')
  assert.equal(redemptions,beforeReopen,'Reopening must not redeem another code')
  assert.deepEqual(errors,[])
  console.log('PASS: visible panel fade after intro; hydrated app cross-fade/rise with slow configuration; one-time v1/v2 reset/v3 persistence; intro-first; animated paste/manual fallback; explicit login/errors; real chart selected-only mouse/touch drag; no crosshair; centered compact plus; notes on create/edit/manual; smooth close/delete; settings disabled/rollback; reduced motion; mobile layout; chart under navigation on scroll/fullscreen/rotation with working mouse/touch tabs and access overlay. Synthetic APIs, not production or physical Telegram.')
  await mobile.close();await context.close()
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)) }
