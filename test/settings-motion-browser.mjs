// Isolated real-Chromium regressions; all settings/API data are synthetic.
// Run: node test/settings-motion-browser.mjs (playwright-core + Chromium).
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import assert from 'node:assert/strict'
const asset = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8')
const index = asset('index.html')
const section = index.match(/<section id="p-settings"[\s\S]*?<\/section>/)[0].replace('class="hide"','class=""')
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${index.match(/<style>([\s\S]*?)<\/style>/)[1]}</style><link rel="stylesheet" href="/alert-refinements.css"><div class="wrap">${section}<div id="alist"></div><div id="footer">After alerts</div></div><script>const H={};function recoverAccess(){};function toast(){};</script><script src="/h4-settings.js"></script><script src="/alert-motion.js"></script>`
let prefs = { enabled: true, symbols: ['EURUSD'], lead: [15], atClose: true }, reject = false, posts = 0
const errors = []
const server = http.createServer(async (req,res) => {
  const reply = (body, code=200) => { res.writeHead(code, {'content-type':'application/json'});res.end(JSON.stringify(body)) }
  if (req.url === '/api/h4/settings') {
    if (req.method === 'POST') {
      posts++;let raw='';for await(const c of req)raw+=c
      await new Promise(r=>setTimeout(r,800))
      if(reject)return reply({error:'save_failed'},503)
      prefs=JSON.parse(raw)
    }
    return reply(prefs)
  }
  if (req.url === '/api/h4/status') return reply({configured:true,serverTime:Date.now(),assets:{EURUSD:{status:'waiting'},XAUUSD:{status:'locked'}}})
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(html)}
  const name=req.url.slice(1);if(!['alert-refinements.css','h4-settings.js','alert-motion.js'].includes(name)){res.writeHead(404);return res.end()}
  res.writeHead(200,{'content-type':name.endsWith('.css')?'text/css':'text/javascript'});res.end(asset(name))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/local/bin/chromium',headless:true,args:['--no-sandbox']})
try {
  const context=await browser.newContext({viewport:{width:390,height:1000}})
  await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort())
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin)
  await page.evaluate(()=>window.H4Settings.load());await page.waitForFunction(()=>document.querySelector('#p-settings').dataset.ready==='true')
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#h4Details')).opacity==='1')
  // Sample every animation frame through a deliberately slow POST. A save must
  // never fade the master, details, chips or the lower toggle, even transiently.
  async function watchSave() {
    await page.evaluate(()=>{
      window.samples=[];window.watching=true
      function tick(){if(!window.watching)return;const q=s=>Number(getComputedStyle(document.querySelector(s)).opacity);samples.push({details:q('#h4Details'),master:q('#h4Enabled'),close:q('#h4AtClose'),asset:q('#h4Assets button'),lead:q('#h4Lead button'),schedule:q('#h4NextClose'),busy:document.querySelector('#p-settings').getAttribute('aria-busy')});requestAnimationFrame(tick)}tick()
    })
  }
  async function stopWatch() {return page.evaluate(()=>{window.watching=false;return samples})}
  const close=page.locator('#h4AtClose')
  await watchSave();await close.click();await page.waitForTimeout(150)
  assert.equal(await close.getAttribute('aria-checked'),'false')
  assert.equal(await page.locator('#h4Details').getAttribute('aria-disabled'),'false')
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),true,'Saving temporarily locks edits without dimming')
  await page.evaluate(()=>document.querySelector('#h4AtClose').click())
  await page.waitForFunction(()=>document.querySelector('#p-settings').getAttribute('aria-busy')==='false')
  await page.waitForTimeout(50)
  const off=await stopWatch()
  assert.ok(off.some(s=>s.busy==='true'));assert.ok(off.length>10)
  for(const s of off)for(const k of ['details','master','close','asset','lead'])assert.equal(s[k],1,`${k} flashed during save`)
  assert.ok(off.some(s=>s.schedule<.99&&s.schedule>.35),'Schedule has intermediate fade frames')
  assert.ok(Math.abs(off.at(-1).schedule-.34)<.01)
  assert.equal(posts,1,'Repeated clicks while saving cannot issue duplicate writes')
  assert.equal(prefs.atClose,false)
  assert.equal(await page.locator('#h4Assets button').first().isDisabled(),false)
  await watchSave();await close.click();await page.waitForFunction(()=>document.querySelector('#p-settings').getAttribute('aria-busy')==='false')
  const on=await stopWatch();for(const s of on)assert.equal(s.details,1)
  assert.equal(on.at(-1).schedule,1);assert.equal(prefs.atClose,true)
  // A rejected save restores the exact previous switch/schedule, without an
  // unrelated section fade; existing lead times and asset selection survive.
  reject=true;await watchSave();await close.click();await page.waitForFunction(()=>document.querySelector('#p-settings').getAttribute('aria-busy')==='false');await page.waitForTimeout(360)
  const failed=await stopWatch();for(const s of failed)assert.equal(s.details,1)
  assert.equal(await close.getAttribute('aria-checked'),'true');assert.equal(failed.at(-1).schedule,1)
  assert.deepEqual(prefs,{enabled:true,symbols:['EURUSD'],lead:[15],atClose:true});reject=false
  await page.locator('#h4Enabled').click();await page.waitForFunction(()=>document.querySelector('#p-settings').getAttribute('aria-busy')==='false')
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),true)
  assert.ok(Math.abs(await page.locator('#h4Details').evaluate(e=>+getComputedStyle(e).opacity)-.34)<.01)
  assert.equal(await close.isDisabled(),true)
  await page.locator('#h4Enabled').click();await page.waitForFunction(()=>document.querySelector('#p-settings').getAttribute('aria-busy')==='false')
  assert.equal(await page.locator('#h4Details').evaluate(e=>e.inert),false)
  // Real layout geometry, preserving the muted appearance of triggered rows.
  await page.evaluate(()=>{document.querySelector('#p-settings').hidden=true;document.querySelector('#alist').innerHTML='<div class="item" data-id="1">First alert</div><div class="item done" data-id="2">Triggered alert</div>'})
  const row=page.locator('#alist [data-id="2"]'), original=await row.boundingBox()
  await page.evaluate(()=>{const list=document.querySelector('#alist'),settle=AlertMotion.capture(list);list.insertAdjacentHTML('beforeend','<div class="item done" data-id="3">New triggered alert</div>');settle()})
  await page.waitForTimeout(120)
  const entryOpacity=await page.locator('[data-id="3"]').evaluate(e=>+getComputedStyle(e).opacity)
  assert.ok(entryOpacity>0&&entryOpacity<=.4,'Entering done row never flashes fully bright')
  await page.waitForTimeout(500)
  assert.equal(await page.locator('[data-id="3"]').evaluate(e=>+getComputedStyle(e).opacity),.4)
  await page.evaluate(()=>{window.removing=AlertMotion.remove(document.querySelector('[data-id="2"]'))})
  await page.waitForTimeout(80)
  assert.ok(await row.evaluate(e=>+getComputedStyle(e).opacity)<=.4)
  await page.waitForTimeout(200)
  const shrinking=await row.boundingBox();assert.ok(shrinking.height>0&&shrinking.height<original.height,'Deletion collapses real layout height gradually')
  await page.evaluate(()=>window.removing);assert.equal(await row.count(),0)
  assert.equal(await page.locator('#alist').evaluate(e=>e.style.height),'','No stuck inline height after animation')
  // Reduced motion is immediate and has no leftover WAAPI/CSS transitions.
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.evaluate(()=>AlertMotion.remove(document.querySelector('[data-id="3"]')))
  assert.equal(await page.locator('[data-id="3"]').count(),0)
  assert.equal(await page.locator('#h4NextClose').evaluate(e=>getComputedStyle(e).transitionDuration),'0s')
  assert.deepEqual(errors,[])
  console.log('PASS: At-close-only schedule fade; no save-time flash sampled every frame; pending click guard; rollback; master lock; muted entry/delete; gradual layout collapse; reduced motion; mobile width. Synthetic APIs only.')
  await context.close()
} finally {await browser.close();await new Promise(r=>server.close(r))}
