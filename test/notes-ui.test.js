import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8')
const code=html.slice(html.indexOf('const esc ='),html.indexOf('async function loadNews()'))
function fixture(){
 let list=[{id:1,symbol:'EURUSD',dir:'reach',level:1.1,status:'active',note:'saved'},{id:2,symbol:'GBPUSD',dir:'reach',level:1.3,status:'active',note:'second'}],failGet=false,failSave=false,release=null
 const rows=new Map(),messages=[],status={textContent:''}
 const row=id=>{if(!rows.has(String(id)))rows.set(String(id),{classList:{add(){}},input:{value:'',focus(){},setSelectionRange(){}},save:{},cancel:{},set innerHTML(value){this.input.value=value.match(/value="([^"]*)"/)?.[1]||''},querySelector(s){return s==='input'?this.input:s==='[data-a=save]'?this.save:this.cancel}});return rows.get(String(id))}
 const alist={content:'',set innerHTML(v){this.content=v;rows.clear()},get innerHTML(){return this.content},querySelectorAll(){return []},querySelector(s){const id=s.match(/data-id="(\d+)"/)?.[1];return id&&list.some(a=>String(a.id)===id)?row(id):null}}
 const api=async(path,o)=>{
  if(!o){if(failGet)throw new Error('Unauthorized');return list.map(a=>({...a}))}
  if(release)await release
  if(failSave)return {error:'unavailable'}
  const a=list.find(a=>String(a.id)===path.split('/').at(-1));Object.assign(a,JSON.parse(o.body));return {...a}
 }
 const context=vm.createContext({$,cfg:{symbols:{}},Option:function(text,value){this.text=text;this.value=value},window:{AlertMotion:{capture:()=>()=>{}}},document:{activeElement:null,getElementById(){return null}},api,toast:t=>messages.push(t),console})
 const filter={value:'all',replaceChildren(){}};function $(s){return s==='#alist'?alist:s.startsWith('#alertFilter')?filter:status}
 vm.runInContext(code,context)
 return {context,row,alist,status,messages,load:()=>vm.runInContext('loadAlerts()',context),edit:id=>vm.runInContext(`editAlert('${id}')`,context),get list(){return list},set failGet(v){failGet=v},set failSave(v){failSave=v},hold(p){release=p},draft:id=>vm.runInContext(`noteDrafts.get('${id}')?.value`,context)}
}
test('list refresh preserves multiple note drafts; Cancel clears only its own row',async()=>{
 const f=fixture();await f.load();f.edit(1);f.row(1).input.value='unsaved one';f.row(1).input.oninput()
 f.edit(2);f.row(2).input.value='unsaved two';f.row(2).input.oninput()
 await f.load();assert.equal(f.row(1).input.value,'unsaved one');assert.equal(f.row(2).input.value,'unsaved two')
 f.row(1).cancel.onclick();assert.equal(f.draft(1),undefined);assert.equal(f.row(2).input.value,'unsaved two')
})
test('rejected note save and list read keep drafts and existing list rather than false empty state',async()=>{
 const f=fixture();await f.load();f.edit(1);f.row(1).input.value='keep this';f.row(1).input.oninput();f.failSave=true
 await f.row(1).save.onclick();assert.equal(f.draft(1),'keep this');assert.equal(f.list[0].note,'saved');assert.match(f.messages[0],/draft is kept/)
 const before=f.alist.innerHTML;f.failGet=true;await f.load();assert.equal(f.alist.innerHTML,before);assert.match(f.status.textContent,/Could not load/)
 f.failGet=false;f.failSave=false;await f.row(1).save.onclick();assert.equal(f.list[0].note,'keep this');assert.equal(f.draft(1),undefined)
})
test('typing during pending save preserves newer draft; repeated Save cannot duplicate PATCH',async()=>{
 const f=fixture();await f.load();f.edit(1);const r=f.row(1);r.input.value='submitted';r.input.oninput()
 let done;f.hold(new Promise(resolve=>done=resolve));const saving=r.save.onclick();await r.save.onclick()
 r.input.value='newer draft';r.input.oninput();done();await saving
 assert.equal(f.list[0].note,'submitted');assert.equal(f.draft(1),'newer draft');assert.equal(f.row(1).input.value,'newer draft')
})
