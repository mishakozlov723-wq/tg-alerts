import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const code=readFileSync(new URL('../public/price-chart.js',import.meta.url),'utf8')
function fixture() {
 const elements=new Map(),intervals=[],timers=[],frames=['M15','H1','H4','D1'].map(tf=>({dataset:{tf},classList:{toggle(){}}}))
 const el=s=>{if(!elements.has(s))elements.set(s,{hidden:false,value:'',textContent:'',disabled:false,style:{},events:{},clientWidth:400,clientHeight:340,setAttribute(){},setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0}),querySelectorAll:()=>frames,replaceChildren(...a){this.options=a},add(a){this.options.push(a)},addEventListener(n,fn){this.events[n]=fn}});return elements.get(s)}
 let quote={price:1.3,dataTs:Date.now(),observedAt:Date.now(),stale:false,tradeable:true},click,range=null,table=[],lines=[],lastRequest,hasMore=true,list=[],delayList=null,fail=false,scale={from:1.2,to:1.4},chartOptions,seriesOptions
 const series={setData(a){table=a},update(a){table[table.length-1]=a},createPriceLine(a){lines.push(a);return a},removePriceLine(a){lines=lines.filter(x=>x!==a)},priceToCoordinate:p=>p*100,coordinateToPrice:y=>y/100}
 const priceScale={width:()=>68,getVisibleRange:()=>scale,setVisibleRange:r=>scale=r,applyOptions(){}}
 const chart={addSeries(_,o){seriesOptions=o;return series},priceScale:()=>priceScale,clearCrosshairPosition(){},setCrosshairPosition(){},subscribeClick(fn){click=fn},timeScale:()=>({coordinateToTime:()=>1,getVisibleLogicalRange:()=>range,setVisibleLogicalRange:r=>range=r,subscribeVisibleLogicalRangeChange(){}})}
 const context={window:{LightweightCharts:{createChart(_,o){chartOptions=o;return chart},CandlestickSeries:{},CrosshairMode:{Normal:0},TrackingModeExitMode:{OnNextTap:1}}},document:{querySelector:el,hidden:false,addEventListener(){}},setInterval:fn=>intervals.push(fn),setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout:id=>{timers[id-1]=null},Date,AbortSignal,Option:function(text,value){this.text=text;this.value=value}}
 vm.runInNewContext(code,context)
 const row=(time,close=1.3)=>({time,open:1.3,high:1.32,low:1.29,close,complete:false})
 const start=Math.floor(Date.now()/900000)*900
 const api=async(path,options)=>{
  if(fail)throw new Error('offline')
  if(path.startsWith('/api/chart/candles')){
   lastRequest=path;const before=new URL('https://local'+path).searchParams.get('before')
   return {candles:before?(hasMore?[row(start-900),row(start-450)]:[]):[row(start)],limit:2000,hasMore:before?false:true,side:'mid',stale:false,requestedAt:Date.now()-2000,fetchedAt:Date.now(),windowStart:start-1800}
  }
  if(options?.method==='POST'){list=[...list,{...JSON.parse(options.body),id:list.length+1,status:'active'}];return list.at(-1)}
  if(options?.method==='DELETE'){list=list.filter(x=>String(x.id)!==path.split('/').at(-1));return{ok:true}}
  if(delayList){const fn=delayList;delayList=null;return fn()}
  return list.map(x=>({...x}))
 }
 context.window.PriceChart.connect({api,getQuote:()=>quote})
 const event=(y=130)=>({isPrimary:true,clientX:100,clientY:y,pointerId:1,preventDefault(){}})
 return {el,intervals,frames,context,select:(s='GBPUSD')=>context.window.PriceChart.select(s),click:()=>click({point:{y:130}}),hold(){el('#chartCanvas').events.pointerdown(event());timers.at(-1)?.();el('#chartCanvas').events.pointermove(event(131));el('#chartCanvas').events.pointerup(event());el('#chartPlus').onclick()},event,setMore:v=>hasMore=v,setFail:v=>fail=v,setQuote:v=>quote={...quote,...v},delayList:fn=>delayList=fn,get table(){return table},get lines(){return lines},get lastRequest(){return lastRequest},get scale(){return scale},get list(){return list},get options(){return {chartOptions,seriesOptions}}}
}
const settle=()=>new Promise(r=>setImmediate(r))
test('tap never creates a candidate; hold, move, plus, correction, explicit create and delete',async()=>{
 const f=fixture();f.select();await settle();f.click();assert.equal(f.el('#chartTicket').hidden,true);assert.equal(f.el('#chartPlus').hidden,true)
 f.hold();assert.equal(f.el('#chartPrice').value,'1.31000');assert.equal(f.list.length,0)
 f.el('#chartPrice').value='1.30005';f.el('#chartPrice').oninput();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 assert.ok(f.el('#chartExisting').options.some(o=>o.text.includes('1.30005')))
 f.el('#chartExisting').onchange({target:{value:'1'}});assert.equal(f.el('#chartDelete').hidden,false)
 await f.el('#chartDelete').onclick({target:f.el('#chartDelete')});assert.equal(f.el('#chartExisting').options.length,1)
})
test('pagination retains existing candles and handles an expired cursor',async()=>{
 const f=fixture();f.select();await settle();f.el('#chartOlder').onclick();await settle();assert.equal(f.table.length,3)
 f.select();await settle();f.setMore(false);f.el('#chartOlder').onclick();await settle();assert.equal(f.el('#chartOlder').hidden,true)
})
test('freshness expires locally offline, history cache explicit, stale direction requires selection',async()=>{
 const f=fixture();f.select();await settle();assert.equal(f.el('#chartFresh').textContent,'')
 f.setQuote({dataTs:Date.now()-60000,observedAt:Date.now()-60000});f.intervals[1]();assert.match(f.el('#chartFresh').textContent,/Last price/)
 f.hold();assert.equal(f.el('#chartDirection').value,'');await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list.length,0)
 f.setFail(true);f.intervals[0]();await settle();assert.equal(f.el('#chartRetry').hidden,false);assert.match(f.el('#chartFresh').textContent,/Cached history/)
})
test('old alert-list response cannot resurrect a deleted line',async()=>{
 const f=fixture();f.select();await settle();f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 let release;f.delayList(()=>new Promise(r=>release=r));f.context.window.PriceChart.refreshAlerts()
 f.el('#chartExisting').onchange({target:{value:'1'}});f.el('#chartDelete').onclick({target:f.el('#chartDelete')});await settle()
 release([{id:1,symbol:'GBPUSD',status:'active',level:1.3,dir:'above'}]);await settle();assert.equal(f.el('#chartExisting').options.length,1)
})
test('EUR switch isolates lines and creates the correct symbol; DXY stays without chart',async()=>{
 const f=fixture();f.select();await settle();f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 f.select('EURUSD');await settle();assert.match(f.lastRequest,/symbol=EURUSD/);assert.equal(f.el('#chartExisting').options.length,1)
 f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list.at(-1).symbol,'EURUSD')
 f.select('DXY');assert.equal(f.el('#gbpChart').hidden,true)
})
test('price-axis vertical drag changes range, pane movement cancels hold, monochrome palette',async()=>{
 const f=fixture();f.select();await settle();const axis=f.el('#chartAxis'),before=f.scale.to-f.scale.from
 axis.onpointerdown(f.event(100));axis.onpointermove(f.event(180));axis.onpointerup();assert.ok(f.scale.to-f.scale.from>before)
 const canvas=f.el('#chartCanvas');canvas.events.pointerdown(f.event());canvas.events.pointermove(f.event(180));canvas.events.pointerup();assert.equal(f.el('#chartPlus').hidden,true)
 assert.equal(f.options.seriesOptions.upColor,'#d4d4d0');assert.equal(f.options.seriesOptions.downColor,'#666662');assert.equal(f.options.chartOptions.handleScale.pinch,true)
})
