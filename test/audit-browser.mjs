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
let checkFail=false,configFail=false;const injectedNews=[];let seq = 3, rejectNext = false, failSettings = false, redemptions = 0, configDelay = 0
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
    if(u.pathname==='/api/news')return send(injectedNews);
    if (u.pathname === '/api/config') { if(configFail&&req.headers['x-access-token'])return send({error:'audit_failure'},503); if (configDelay && req.headers['x-access-token']) await new Promise(r=>setTimeout(r,configDelay)); return send({ authRequired: true, authApi: '/local-access', mock: false, symbols: { EURUSD: { digits: 5, pip: .0001 }, GBPUSD: { digits: 5, pip: .0001 } } }) }
    if(u.pathname==='/api/access/check'&&checkFail){if(checkFail==='401')return send({ok:false},401);if(checkFail==='503')return send({error:'unavailable'},503);req.socket.destroy();return;}
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
    if (u.pathname === '/api/alerts' && req.method === 'POST') { await new Promise(r=>setTimeout(r,250)); const a = { ...b, id: seq++, dir: 'reach', status: 'active' }; alerts.push(a); mutations.push({method:'POST',...a}); return send(a) }
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
 const context=await browser.newContext({viewport:{width:1000,height:1000},reducedMotion:'reduce'})
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort())
 await context.addInitScript(()=>{window.Telegram={WebApp:{platform:'tdesktop'}};if(!location.search.includes('fresh'))localStorage.setItem('retocker.access.alerts.v3','synthetic-token')})
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin)
 await page.waitForSelector('.asset');await page.waitForFunction(()=>document.body.classList.contains('ready'))
 if(await page.locator('#manualToggle').isVisible())await page.locator('#manualToggle').click()
 await page.locator('#level').fill('1.15');const before=mutations.length
 await page.evaluate(()=>{document.querySelector('#create').click();document.querySelector('#create').click()});await page.waitForTimeout(650)
 assert.equal(mutations.length-before,1,'Rapid repeated Create must send one request')
 const {createNews}=await import('../cloudflare/news.mjs')
 const payload='<img src=x onerror="window.auditXss=localStorage.getItem(\'retocker.access.alerts.v3\')">'
 const source=createNews({NEWS_MIRROR_URL:'https://artificial.local/news',LOCAL_STORE:{command:async()=>null},FETCH:async()=>Response.json([{title:payload,country:'USD',impact:'High',forecast:payload,previous:payload,date:new Date(Date.now()+3600000).toISOString()}])})
 injectedNews.push(...await source.getNews());await page.evaluate(()=>loadNews());await page.waitForTimeout(200)
 assert.equal(await page.evaluate(()=>window.auditXss),undefined);assert.equal(await page.locator('#nlist img').count(),0)
 assert.ok((await page.locator('#nlist').textContent()).includes(payload),'External news must remain literal text')
 for(const failure of [true,'503']) {
  checkFail=failure;await page.reload();await page.locator('#bootRetry').waitFor()
  assert.equal(await page.evaluate(()=>localStorage.getItem('retocker.access.alerts.v3')),'synthetic-token')
  assert.equal(await page.locator('.asset').count(),0)
  checkFail=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')))
  await page.waitForSelector('.asset');assert.equal(await page.locator('#accessGate').evaluate(e=>e.classList.contains('hide')),true)
 }
 await page.evaluate(()=>localStorage.removeItem('retocker.access.alerts.v3'));configFail=true;await page.goto(origin+'/?fresh=1')
 await page.waitForFunction(()=>document.querySelector('#accessGate').classList.contains('is-visible'))
 await page.locator('#accessCode').fill('123456');await page.waitForTimeout(100);await page.locator('#accessAction').click()
 await page.locator('#accessRetry').waitFor({state:'visible'});const redeemed=redemptions
 assert.equal(await page.locator('#accessGate').evaluate(e=>e.classList.contains('hide')),false,'Failed hydration must keep the gate visible')
 assert.equal(await page.locator('.asset').count(),0)
 configFail=false;await page.locator('#accessRetry').click();await page.waitForSelector('.asset')
 await page.waitForFunction(()=>document.querySelector('#accessGate').classList.contains('hide'))
 assert.equal(redemptions,redeemed,'Hydration retry must reuse the accepted token, not spend another code')
 // If the accepted token expires while hydration is unavailable, unlock the
 // code form as well as showing it: never leave the previous submit busy.
 await page.evaluate(()=>localStorage.removeItem('retocker.access.alerts.v3'));configFail=true;await page.goto(origin+'/?fresh=1')
 await page.waitForFunction(()=>document.querySelector('#accessGate').classList.contains('is-visible'))
 await page.locator('#accessCode').fill('123456');await page.waitForTimeout(100);await page.locator('#accessAction').click()
 await page.locator('#accessRetry').waitFor({state:'visible'});checkFail='401';configFail=false
 await page.locator('#accessRetry').click();await page.waitForFunction(()=>!document.querySelector('#accessAction').disabled)
 checkFail=false;await page.locator('#accessCode').fill('654321');await page.waitForTimeout(100);await page.locator('#accessAction').click()
 await page.waitForSelector('.asset');await page.waitForFunction(()=>document.querySelector('#accessGate').classList.contains('hide'))
 assert.deepEqual(errors,[]);await context.close()
 console.log('PASS: news escaped; Create guarded; network/503 retry retains session; hydration retry keeps gate and reuses token. Synthetic APIs only.')
}finally{await browser.close();await new Promise(r=>server.close(r))}
