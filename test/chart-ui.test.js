import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const code=readFileSync(new URL('../public/price-chart.js',import.meta.url),'utf8')
function fixture() {
 const elements=new Map(),intervals=[],frames=['M15','H1','H4','D1'].map(tf=>({dataset:{tf},classList:{toggle(){}}}))
 const el=s=>{if(!elements.has(s))elements.set(s,{hidden:false,value:'',textContent:'',disabled:false,querySelectorAll:()=>frames,replaceChildren(...a){this.options=a},add(a){this.options.push(a)},addEventListener(){}});return elements.get(s)}
 let quote={price:1.3,dataTs:Date.now(),observedAt:Date.now(),stale:false,tradeable:true},click,range=null,table=[],lines=[],lastRequest,hasMore=true,stale=false,list=[],delayList=null,fail=false
 const series={setData(a){table=a},update(a){table[table.length-1]=a},createPriceLine(a){lines.push(a);return a},removePriceLine(a){lines=lines.filter(x=>x!==a)},priceToCoordinate:p=>p*100,coordinateToPrice:y=>y/100}
 const chart={addSeries:()=>series,subscribeClick(fn){click=fn},timeScale:()=>({getVisibleLogicalRange:()=>range,setVisibleLogicalRange:r=>range=r,subscribeVisibleLogicalRangeChange(){}})}
 const context={window:{LightweightCharts:{createChart:()=>chart,CandlestickSeries:{},CrosshairMode:{Normal:0}}},document:{querySelector:el,hidden:false,addEventListener(){}},setInterval:fn=>intervals.push(fn),setTimeout,clearTimeout,Date,AbortSignal,Option:function(text,value){this.text=text;this.value=value}}
 vm.runInNewContext(code,context)
 const row=(time,close=1.3)=>({time,open:1.3,high:1.32,low:1.29,close,complete:false})
 const start=Math.floor(Date.now()/900000)*900
 const api=async(path,options)=>{
  if(fail)throw new Error('offline')
  if(path.startsWith('/api/chart/candles')){
   lastRequest=path;const before=new URL('https://local'+path).searchParams.get('before')
   return {candles:before?(hasMore?[row(start-900),row(start-450)]:[]):[row(start)],limit:2000,hasMore:before?false:true,side:'mid',stale,requestedAt:Date.now()-2000,fetchedAt:Date.now(),windowStart:start-1800}
  }
  if(options?.method==='POST'){list=[...list,{...JSON.parse(options.body),id:list.length+1,status:'active'}];return list.at(-1)}
  if(options?.method==='DELETE'){list=list.filter(x=>String(x.id)!==path.split('/').at(-1));return{ok:true}}
  if(delayList){const fn=delayList;delayList=null;return fn()}
  return list.map(x=>({...x}))
 }
 context.window.PriceChart.connect({api,getQuote:()=>quote})
 return {el,intervals,frames,context,select:()=>context.window.PriceChart.select('GBPUSD'),click:()=>click({point:{y:130}}),setMore:v=>hasMore=v,setFail:v=>fail=v,setQuote:v=>quote={...quote,...v},delayList:fn=>delayList=fn,get table(){return table},get lines(){return lines},get lastRequest(){return lastRequest}}
}
const settle=()=>new Promise(r=>setImmediate(r))
test('chart tap, numeric correction, create and select/delete use existing API',async()=>{
 const f=fixture();f.select();await settle();f.click();assert.equal(f.el('#chartPrice').value,'1.30000')
 f.el('#chartPrice').value='1.30005';f.el('#chartPrice').oninput();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 assert.ok(f.el('#chartExisting').options.some(o=>o.text.includes('1.30005')))
 f.el('#chartExisting').onchange({target:{value:'1'}});assert.equal(f.el('#chartDelete').hidden,false)
 await f.el('#chartDelete').onclick({target:f.el('#chartDelete')});await settle();assert.equal(f.el('#chartExisting').options.length,1)
})
test('pagination retains existing candles and handles an expired cursor',async()=>{
 const f=fixture();f.select();await settle();f.el('#chartOlder').onclick();await settle();assert.equal(f.table.length,3)
 f.select();await settle();f.setMore(false);f.el('#chartOlder').onclick();await settle();assert.equal(f.el('#chartOlder').hidden,true)
})
test('freshness expires locally even when network is entirely offline; cached history is explicit',async()=>{
 const f=fixture();f.select();await settle();assert.match(f.el('#chartFresh').textContent,/поток OANDA/)
 f.setFail(true);f.setQuote({dataTs:Date.now()-60000,observedAt:Date.now()-60000});f.intervals[1]();assert.match(f.el('#chartFresh').textContent,/Последняя цена/)
 f.intervals[0]();await settle();assert.equal(f.el('#chartRetry').hidden,false)
})
test('old alert-list response cannot resurrect a deleted line',async()=>{
 const f=fixture();f.select();await settle();f.click();await f.el('#chartAdd').onclick({target:f.el('#chartAdd')})
 let release;f.delayList(()=>new Promise(r=>release=r));f.context.window.PriceChart.refreshAlerts()
 f.el('#chartExisting').onchange({target:{value:'1'}});f.el('#chartDelete').onclick({target:f.el('#chartDelete')});await settle()
 release([{id:1,symbol:'GBPUSD',status:'active',level:1.3,dir:'above'}]);await settle();assert.equal(f.el('#chartExisting').options.length,1)
})
