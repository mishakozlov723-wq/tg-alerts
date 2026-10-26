import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const code=readFileSync(new URL('../public/price-chart.js',import.meta.url),'utf8')
function fixture() {
 const elements=new Map(),intervals=[],timers=[],frames=['M15','H1','H4','D1'].map(tf=>({dataset:{tf},classList:{toggle(){}}}))
 const el=s=>{if(!elements.has(s))elements.set(s,{dataset:{},hidden:false,value:'',textContent:'',disabled:false,style:{},parentElement:{addEventListener(){}},events:{},clientWidth:400,clientHeight:340,attrs:{},classList:{add(){},remove(){},toggle(){}},contains:()=>false,focus(){},setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]},setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0}),querySelectorAll:()=>frames,replaceChildren(...a){this.options=a},add(a){this.options.push(a)},addEventListener(n,fn){this.events[n]=fn}});return elements.get(s)}
 let quote={price:1.3,dataTs:Date.now(),observedAt:Date.now(),stale:false,tradeable:true},click,range=null,table=[],lines=[],lastRequest,hasMore=true,list=[],delayList=null,fail=false,scale={from:1.2,to:1.4},chartOptions,seriesOptions
 const series={applyOptions(o){seriesOptions={...seriesOptions,...o}},setData(a){table=a},update(a){table[table.length-1]=a},createPriceLine(a){a.applyOptions=o=>Object.assign(a,o);lines.push(a);return a},removePriceLine(a){lines=lines.filter(x=>x!==a)},priceToCoordinate:p=>p*100,coordinateToPrice:y=>y/100}
 const priceScale={width:()=>68,getVisibleRange:()=>scale,setVisibleRange:r=>scale=r,applyOptions(){}}
 let crosshair,rangeChange
 const chart={applyOptions(o){chartOptions={...chartOptions,...o,handleScroll:{...chartOptions.handleScroll,...o.handleScroll}}},subscribeCrosshairMove(fn){crosshair=fn},addSeries(_,o){seriesOptions=o;return series},priceScale:()=>priceScale,clearCrosshairPosition(){},setCrosshairPosition(){},subscribeClick(fn){click=fn},timeScale:()=>({coordinateToTime:()=>1,getVisibleLogicalRange:()=>range,setVisibleLogicalRange:r=>range=r,subscribeVisibleLogicalRangeChange(fn){rangeChange=fn}})}
 const context={matchMedia:()=>({matches:true}),window:{quoteState:(_,q)=>q&&Date.now()-q.observedAt<30000?'streaming':'reconnecting',LightweightCharts:{createChart(_,o){chartOptions=o;return chart},CandlestickSeries:{},CrosshairMode:{Normal:0},TrackingModeExitMode:{OnNextTap:1,OnTouchEnd:0}}},document:{querySelector:el,hidden:false,addEventListener(){}},requestAnimationFrame:fn=>fn(),setInterval:fn=>intervals.push(fn),setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout:id=>{timers[id-1]=null},Date,AbortSignal,Option:function(text,value){this.text=text;this.value=value}}
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
  if(options?.method==='PATCH'){const a=list.find(x=>String(x.id)===path.split('/').at(-1));Object.assign(a,JSON.parse(options.body));return {...a}}
  if(options?.method==='DELETE'){list=list.filter(x=>String(x.id)!==path.split('/').at(-1));return{ok:true}}
  if(delayList){const fn=delayList;delayList=null;return fn()}
  return list.map(x=>({...x}))
 }
 context.window.PriceChart.connect({api,getQuote:()=>quote})
 const event=(y=130)=>({isPrimary:true,clientX:100,clientY:y,pointerId:1,preventDefault(){}})
 return {el,intervals,frames,context,rangeChange:r=>rangeChange(r),crosshair:p=>crosshair(p),get range(){return range},setRange:r=>range=r,fireHold:()=>timers.at(-1)?.(),select:(s='GBPUSD')=>context.window.PriceChart.select(s),click:()=>click({point:{y:130}}),hold(){el('#chartCanvas').events.pointerdown(event());timers.at(-1)?.();el('#chartCanvas').events.pointermove(event(131));el('#chartCanvas').events.pointerup(event());el('#chartPlus').onclick()},event,setMore:v=>hasMore=v,setFail:v=>fail=v,setQuote:v=>quote={...quote,...v},delayList:fn=>delayList=fn,get table(){return table},get lines(){return lines},get lastRequest(){return lastRequest},get scale(){return scale},get list(){return list},get options(){return {chartOptions,seriesOptions}}}
}
const settle=()=>new Promise(r=>setImmediate(r))
test('saved lines drag with mouse/touch, save by PATCH, cancel without mutation',async()=>{
 const f=fixture();f.select();await settle();f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 const c=f.el('#chartCanvas'),old=f.list[0].level
 c.events.pointerdown(f.event(old*100));c.events.pointermove(f.event(145));c.events.pointerup(f.event(145))
 assert.equal(f.el('#chartTicket').hidden,true,'An unselected saved line cannot be dragged')
 f.el('#chartExisting').onchange({target:{value:'1'}})
 c.events.pointerdown(f.event(old*100));c.events.pointermove(f.event(145));c.events.pointerup(f.event(145))
 assert.equal(f.el('#chartPrice').value,'1.45000');assert.equal(f.list[0].level,old)
 f.el('#chartCancel').onclick();assert.equal(f.list[0].level,old)
 const touch=y=>({touches:[f.event(y)],preventDefault(){},stopImmediatePropagation(){}})
 f.el('#chartExisting').onchange({target:{value:'1'}})
 c.events.touchstart(touch(old*100));c.events.touchmove(touch(155));c.events.touchend({...touch(155),touches:[]})
 assert.equal(f.el('#chartPrice').value,'1.55000');assert.equal(f.el('#chartDelete').hidden,false)
 await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list.length,1);assert.equal(f.list[0].id,1);assert.equal(f.list[0].level,1.55)
 f.el('#chartExisting').onchange({target:{value:'1'}});f.el('#chartPrice').value='1.6';f.el('#chartPrice').oninput()
 await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list.length,1);assert.equal(f.list[0].level,1.6)
})
test('unsaved line drags with mouse and touch without saving or dismissing ticket',async()=>{
 const f=fixture();f.select();await settle();f.hold();const c=f.el('#chartCanvas')
 assert.equal(f.lines.at(-1).lineStyle,0)
 c.events.pointerdown(f.event(131));c.events.pointermove(f.event(140));c.events.pointerup(f.event(140))
 assert.equal(f.el('#chartPrice').value,'1.40000');assert.equal(f.el('#chartTicket').hidden,false)
 const touch=y=>({touches:[f.event(y)],preventDefault(){},stopImmediatePropagation(){}})
 c.events.touchstart(touch(140));c.events.touchmove(touch(150));c.events.touchend({...touch(150),touches:[]})
 assert.equal(f.el('#chartPrice').value,'1.50000');assert.equal(f.list.length,0)
 c.events.touchstart(touch(80));f.crosshair({point:{x:100,y:90}});c.events.touchend({touches:[]})
 assert.equal(f.el('#chartPrice').value,'1.50000');assert.equal(f.el('#chartTicket').hidden,false)
 assert.equal(f.options.chartOptions.handleScroll.vertTouchDrag,true)
 await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list[0].level,1.5)
})
test('native touch crosshair immediately exposes plus without second timer; multi-touch cannot select',async()=>{
 const f=fixture();f.select();await settle();const c=f.el('#chartCanvas')
 c.events.touchstart({touches:[f.event(100)]});f.crosshair({point:{x:100,y:130}})
 assert.equal(f.el('#chartPlus').hidden,false);assert.equal(f.el('#chartPlus').style.top,'130px')
 c.events.touchend({touches:[]});f.intervals[0]();await settle();assert.equal(f.el('#chartPlus').hidden,false)
 c.events.touchstart({touches:[{},{}]});f.crosshair({point:{x:100,y:131}});assert.equal(f.el('#chartPlus').hidden,true)
 c.events.touchend({touches:[]});c.events.touchstart({touches:[f.event(100)]});f.crosshair({point:{x:100,y:1}})
 assert.equal(f.el('#chartPlus').style.top,'22px');f.crosshair({});assert.equal(f.el('#chartPlus').hidden,false)
})
test('mouse hold locks pane pan, restores on cancel; repeated price drags stay bounded',async()=>{
 const f=fixture();f.select();await settle();const c=f.el('#chartCanvas'),axis=f.el('#chartAxis'),base=f.scale.to-f.scale.from
 c.events.pointerdown(f.event());f.fireHold();assert.equal(f.options.chartOptions.handleScroll.pressedMouseMove,false)
 c.events.pointercancel(f.event());assert.equal(f.options.chartOptions.handleScroll.pressedMouseMove,true)
 for(let i=0;i<8;i++){axis.onpointerdown(f.event(0));axis.onpointermove(f.event(2000));axis.onpointerup()}
 assert.ok(f.scale.to-f.scale.from<=base*5+1e-10)
 for(let i=0;i<8;i++){axis.onpointerdown(f.event(2000));axis.onpointermove(f.event(0));axis.onpointerup()}
 assert.ok(f.scale.to-f.scale.from>=base/5-1e-10)
 assert.equal(f.options.chartOptions.timeScale.minBarSpacing,2);assert.equal(f.options.chartOptions.timeScale.maxBarSpacing,24)
})
test('refresh preserves manual viewport; manual form collapses for chart symbols only',async()=>{
 const f=fixture();f.select('EURUSD');await settle();const b=f.el('#manualBody'),t=f.el('#manualToggle')
 assert.equal(b.inert,true);assert.equal(t.attrs['aria-expanded'],'false');t.onclick();assert.equal(b.inert,false)
 f.select('EURUSD');assert.equal(b.inert,false)
 const r={from:20,to:80};f.setRange(r);f.intervals[0]();await settle();assert.equal(f.range.from,r.from);assert.equal(f.range.to,r.to)
 f.select('GBPUSD');assert.equal(b.inert,true);f.select('UNSUPPORTED');assert.equal(b.inert,false);assert.equal(t.hidden,true)
 f.select('GBPUSD');assert.equal(b.inert,true);assert.equal(t.hidden,false)
})
test('tap never creates a candidate; hold, move, plus, correction, explicit create and delete',async()=>{
 const f=fixture();f.select();await settle();f.click();assert.equal(f.el('#chartTicket').hidden,true);assert.equal(f.el('#chartPlus').hidden,true)
 f.hold();assert.equal(f.el('#chartPrice').value,'1.31000');assert.equal(f.list.length,0)
 f.el('#chartPrice').value='1.30005';f.el('#chartPrice').oninput();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 assert.ok(f.el('#chartExisting').options.some(o=>o.text.includes('1.30005')))
 f.el('#chartExisting').onchange({target:{value:'1'}});assert.equal(f.el('#chartDelete').hidden,false)
 await f.el('#chartDelete').onclick({target:f.el('#chartDelete')});assert.equal(f.el('#chartExisting').options.length,1)
})
test('pagination retains existing candles and handles an expired cursor',async()=>{
 const f=fixture();f.select();await settle();f.rangeChange({from:0,to:60});await settle();assert.equal(f.table.length,3)
 f.select();await settle();f.setMore(false);f.rangeChange({from:0,to:60});await settle();assert.equal(f.table.length,3)
})
test('freshness expires locally offline; reach creation does not infer direction from stale data',async()=>{
 const f=fixture();f.select();await settle();assert.equal(f.el('#chartFresh').textContent,'')
 f.setQuote({dataTs:Date.now()-60000,observedAt:Date.now()-60000});f.intervals[1]();assert.match(f.el('#chartFresh').textContent,/Last price/)
 f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list.length,1);assert.equal(f.list[0].dir,undefined)
 f.setFail(true);f.intervals[0]();await settle();assert.equal(f.el('#chartRetry').hidden,false);assert.match(f.el('#chartFresh').textContent,/Cached history/)
})
test('old alert-list response cannot resurrect a deleted line',async()=>{
 const f=fixture();f.select();await settle();f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 let release;f.delayList(()=>new Promise(r=>release=r));f.context.window.PriceChart.refreshAlerts()
 f.el('#chartExisting').onchange({target:{value:'1'}});f.el('#chartDelete').onclick({target:f.el('#chartDelete')});await settle()
 release([{id:1,symbol:'GBPUSD',status:'active',level:1.3,dir:'above'}]);await settle();assert.equal(f.el('#chartExisting').options.length,1)
})
test('EUR switch isolates lines and creates the correct symbol; DXY has its own chart',async()=>{
 const f=fixture();f.select();await settle();f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 f.select('EURUSD');await settle();assert.match(f.lastRequest,/symbol=EURUSD/);assert.equal(f.el('#chartExisting').options.length,1)
 f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list.at(-1).symbol,'EURUSD')
 f.select('DXY');await settle();assert.equal(f.el('#gbpChart').hidden,false);assert.match(f.lastRequest,/symbol=DXY/);assert.equal(f.options.seriesOptions.priceFormat.precision,3)
})
test('GER40, gold and silver use their own chart, precision and explicit alert CRUD',async()=>{
 const f=fixture()
 for(const [symbol,precision,level] of [['GER40',1,'23456.7'],['XAUUSD',2,'3456.78'],['XAGUSD',3,'42.123']]) {
  f.select(symbol);await settle()
  assert.equal(f.el('#gbpChart').hidden,false);assert.match(f.lastRequest,new RegExp('symbol='+symbol))
  assert.equal(f.options.seriesOptions.priceFormat.precision,precision)
  assert.equal(f.el('#manualBody').inert,true)
  f.hold();f.el('#chartPrice').value=level;f.el('#chartPrice').oninput()
  assert.equal(f.list.length,0)
  await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
  assert.equal(f.list[0].symbol,symbol);assert.equal(f.list[0].level,Number(level))
  f.el('#chartExisting').onchange({target:{value:'1'}})
  await f.el('#chartDelete').onclick({target:f.el('#chartDelete')});assert.equal(f.list.length,0)
 }
})
test('price-axis vertical drag changes range, pane movement cancels hold, monochrome palette',async()=>{
 const f=fixture();f.select();await settle();const axis=f.el('#chartAxis'),before=f.scale.to-f.scale.from
 axis.onpointerdown(f.event(100));axis.onpointermove(f.event(180));axis.onpointerup();assert.ok(f.scale.to-f.scale.from>before)
 const canvas=f.el('#chartCanvas');canvas.events.pointerdown(f.event());canvas.events.pointermove(f.event(180));canvas.events.pointerup(f.event(180));assert.equal(f.el('#chartPlus').hidden,true)
 assert.equal(f.options.seriesOptions.upColor,'#d4d4d0');assert.equal(f.options.seriesOptions.downColor,'#666662');assert.equal(f.options.chartOptions.handleScale.pinch,true)
})

test('only the selected saved line moves; chart crosshair lines and axis labels are hidden',async()=>{
 const f=fixture();f.select();await settle();f.hold();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 f.hold();f.el('#chartPrice').value='2.5';f.el('#chartPrice').oninput();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 f.el('#chartExisting').onchange({target:{value:'1'}})
 const before=f.el('#chartPrice').value,c=f.el('#chartCanvas')
 c.events.pointerdown(f.event(250));c.events.pointermove(f.event(280));c.events.pointerup(f.event(280))
 assert.equal(f.el('#chartPrice').value,before);assert.equal(f.el('#chartExisting').value,'1')
 assert.equal(f.options.chartOptions.crosshair.vertLine.visible,false);assert.equal(f.options.chartOptions.crosshair.horzLine.visible,false)
 assert.equal(f.options.chartOptions.crosshair.vertLine.labelVisible,false)
})
test('chart create and PATCH include note, Cancel does not persist the draft',async()=>{
 const f=fixture();f.select();await settle();f.hold();f.el('#chartNote').value='initial note'
 await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list[0].note,'initial note')
 f.el('#chartExisting').onchange({target:{value:'1'}});assert.equal(f.el('#chartNote').value,'initial note')
 f.el('#chartNote').value='discard';f.el('#chartCancel').onclick();assert.equal(f.list[0].note,'initial note')
 f.el('#chartExisting').onchange({target:{value:'1'}});f.el('#chartNote').value='changed'
 await f.el('#chartAdd').onclick({target:f.el('#chartAdd')});assert.equal(f.list[0].note,'changed')
})
