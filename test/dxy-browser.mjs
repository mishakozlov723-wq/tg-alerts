// Local fixture only: real chart and authenticated CRUD, simulated Capital.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
const url=process.argv[2]
if(new URL(url).hostname!=='127.0.0.1')throw new Error('Local fixture required')
const browser=await chromium.launch({channel:'msedge',headless:true})
try {
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/price-chart.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('series = chart.addSeries','window.fixtureChart = chart; series = window.fixtureSeries = chart.addSeries')})})
 await page.goto(url);await page.locator('#splash').waitFor({state:'detached'})
 await page.getByRole('button',{name:'DXY —',exact:true}).click()
 await page.waitForFunction(()=>window.fixtureSeries?.data().length===300)
 assert.equal(await page.locator('#chartSymbol').textContent(),'DXY')
 for(const tf of ['H1','H4','D1','M15']){
  await page.getByRole('button',{name:tf,exact:true}).click();await page.waitForTimeout(250)
  assert.equal(await page.evaluate(()=>window.fixtureSeries.data().length),300)
 }
 const canvas=page.locator('#chartCanvas');await canvas.scrollIntoViewIfNeeded();const r=await canvas.boundingBox()
 await page.mouse.move(r.x+100,r.y+130);await page.mouse.down();await page.waitForTimeout(600);await page.mouse.up()
 await page.locator('#chartPlus').click()
 await page.getByRole('textbox',{name:'Alert price',exact:true}).fill('100.123')
 await page.getByRole('button',{name:'Save alert',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('#chartExisting').options.length===2)
 await page.locator('#chartExisting').selectOption({index:1})
 assert.equal(await page.locator('#chartPrice').inputValue(),'100.123')
 await page.getByRole('button',{name:'Delete alert',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('#chartExisting').options.length===1)
 assert.deepEqual(errors,[])
 console.log('PASS: DXY 300 rendered candles, four timeframes, hold/plus, authenticated create/select/delete, 3-digit price, no page errors. Simulated Capital only.')
}finally{await browser.close()}
