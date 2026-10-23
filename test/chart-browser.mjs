// Local-only browser acceptance with real pointer input; no production access.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const url = process.argv[2]
if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Local fixture URL required')
const browser = await chromium.launch({channel:'msedge',headless:true})
try {
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 // Observe the actual library's scale, not a mocked chart.
 await page.route('**/price-chart.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('series = chart.addSeries', 'window.fixtureChart = chart; series = chart.addSeries')})})
 await page.goto(url); await page.locator('#splash').waitFor({state:'detached'})
 await page.locator('#chartStatus').filter({hasText:'Loading'}).waitFor({state:'hidden'})
 const canvas=page.locator('#chartCanvas');await canvas.scrollIntoViewIfNeeded()
 let r=await canvas.boundingBox()
 await page.mouse.click(r.x+100,r.y+130)
 assert.equal(await page.locator('#chartTicket').isVisible(),false)
 await page.mouse.move(r.x+100,r.y+130);await page.mouse.down();await page.waitForTimeout(650);await page.mouse.move(r.x+110,r.y+150,{steps:5});await page.mouse.up()
 assert.equal(await page.locator('#chartPlus').isVisible(),true)
 await page.locator('#chartPlus').click();await page.getByRole('textbox',{name:'Alert price',exact:true}).fill('1.35000')
 await page.locator('#chartDirection').selectOption('above');await page.getByRole('button',{name:'Add alert',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('#chartExisting').options.length===2)
 await page.locator('#chartExisting').selectOption({index:1});await page.getByRole('button',{name:'Delete alert',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('#chartExisting').options.length===1)
 const axis=page.locator('#chartAxis');await axis.scrollIntoViewIfNeeded();r=await axis.boundingBox()
 const width=()=>page.evaluate(()=>{const r=window.fixtureChart.priceScale('right').getVisibleRange();return r.to-r.from})
 const before=await width()
 await page.mouse.move(r.x+20,r.y+100);await page.mouse.down();await page.mouse.move(r.x+20,r.y+180,{steps:12});await page.mouse.up()
 assert.ok(await width()>before,'Actual price range expands on axis drag')
 await page.getByRole('button',{name:'Reset view',exact:true}).click()
 // Chromium touch input exercises WebView-like events, not physical phone acceptance.
 const cdp=await page.context().newCDPSession(page)
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2})
 r=await canvas.boundingBox()
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+90,y:r.y+120}]});await page.waitForTimeout(650)
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:r.x+100,y:r.y+145}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
 assert.equal(await page.locator('#chartPlus').isVisible(),true,'Touch hold leaves plus available')
 await page.locator('#chartPlus').click();assert.equal(await page.locator('#chartTicket').isVisible(),true)
 await page.getByRole('button',{name:'Cancel',exact:true}).click()
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false})
 for (const tf of ['H1','H4','D1','M15']) {await page.getByRole('button',{name:tf,exact:true}).click();await page.waitForTimeout(250)}
 await page.getByRole('button',{name:'GBPUSD 1.30010',exact:true}).click();await page.waitForTimeout(300);assert.equal(await page.locator('#chartSymbol').textContent(),'GBPUSD')
 await page.getByRole('button',{name:'EURUSD 1.30010',exact:true}).click();await page.waitForTimeout(300);assert.equal(await page.locator('#chartSymbol').textContent(),'EURUSD')
 await canvas.scrollIntoViewIfNeeded();await page.screenshot({path:'test/chart-revision.png'})
 assert.deepEqual(errors,[])
 console.log('PASS: mobile-width layout; tap has no draft; real mouse hold/move/plus; EUR create/delete; axis drag without errors; four frames; GBP/EUR switching. Not a real phone touch test.')
} finally {await browser.close()}
