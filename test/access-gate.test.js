import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1]

function boot({ legacy = null, saved = null, valid = false, authApi = '/local-access', redeemedToken = null, cached = null, pricesResponse = {}, eventsResponse = [], storageFails = false, expirePrices = false, introPending = false } = {}) {
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(id === '#accessGate' ? ['hide'] : [])
      elements.set(id, {
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
        replaceChildren(){},dataset: {}, style: { setProperty() {} }, value: '', textContent: '', removed: false,
        focus() { this.focused = true }, remove() { this.removed = true },
        addEventListener() {}, querySelectorAll: () => [],
      })
    }
    const result = elements.get(id); result.children ||= []; return result
  }
  const storage = new Map(saved ? [['retocker.access.alerts.v3', saved]] : [])
  if (legacy) { storage.set('retocker.access.alerts.v1', legacy); storage.set('retocker.access.alerts.v2', legacy) }
  if (cached) storage.set('retocker.quotes.display.v1', cached)
  const timers = [], requests = [], listeners = new Map(), errors = []
  const window = {
    quoteState:()=> 'streaming',
    playIntro: () => introPending ? new Promise(() => {}) : Promise.resolve(),
    AccessCode: {bind({form,input,status,submit}) {form.onsubmit=async e=>{e.preventDefault();await submit()};return {setBusy(){},reset(){input.value='';status.textContent=''}}}},
    AlertMotion:{capture:()=>()=>{}},
    addEventListener: (name, cb) => listeners.set(name, cb),
    dispatchEvent: (event) => listeners.get(event.type)?.(),
  }
  const context = vm.createContext({
    Option:function(text,value){this.text=text;this.value=value}, window, location:{protocol:'https:'}, matchMedia:()=>({matches:true}), Event, AbortSignal, console: { error: (e) => errors.push(e) }, performance: { now: () => 0 },
    document: { querySelector: (id) => id === '#splash' && element(id).removed ? null : element(id), querySelectorAll: () => [], getElementById: (id) => element('#' + id), addEventListener() {}, body: element('body') },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => { if (storageFails) throw new Error('quota'); storage.set(k, v) }, removeItem: (k) => storage.delete(k) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }) }, setInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
    fetch: async (url) => {
      requests.push(url)
      const responses = {
        '/api/config': { authRequired: true, authApi, symbols: { EURUSD: { digits: 5, pip: .0001 } } },
        '/api/access/check': { ok: valid }, '/api/prices': pricesResponse, '/api/events?since=0': eventsResponse, '/api/settings': {},
        '/local-access/api/verify-code': redeemedToken ? { token: redeemedToken } : { error: 'invalid_code' },
      }
      assert.ok(url in responses, 'Unexpected request: ' + url)
      if (url === '/local-access/api/verify-code' && redeemedToken) expirePrices = false
      return { ok: !(expirePrices && url === '/api/prices'), status: expirePrices && url === '/api/prices' ? 401 : 200, json: async () => responses[url] }
    },
  })
  vm.runInContext(script, context)
  return { element, storage, timers, requests, errors, context, setFetch(fn) { context.fetch = fn } }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
const snapshot = JSON.stringify({ version: 1, mock: false, prices: {
  EURUSD: { price: 1.12345, dataTs: 1000, observedAt: 1000 },
  GOLD: { price: 2500, dataTs: 1000, observedAt: 1000 },
} })

test('cached prices load behind the intro before blocked network/history; unentitled assets are excluded', async () => {
  const app = boot({ saved: 'valid-test-token', valid: true, cached: snapshot,
    pricesResponse: new Promise(() => {}), eventsResponse: new Promise(() => {}) })
  await settle()
  assert.equal(app.element('#price').textContent, '1.12345')
  assert.equal(app.element('#splash').removed, false)
  assert.equal(vm.runInContext('prices.EURUSD.stale', app.context), true)
  assert.equal(vm.runInContext('prices.GOLD', app.context), undefined)
  assert.ok(app.requests.includes('/api/events?since=0'))
  assert.deepEqual(app.errors, [])
})

test('cache does not bypass expired access or expose prices before login', async () => {
  const app = boot({ saved: 'expired-test-token', cached: snapshot })
  await settle()
  assert.equal(app.element('#price').textContent, '')
  assert.equal(vm.runInContext('Object.keys(prices).length', app.context), 0)
})

test('fresh response replaces cached price and persists original timestamps without waiting for events', async () => {
  const q = { price: 1.23456, dataTs: 2000, observedAt: 3000, stale: false, tradeable: true }
  const app = boot({ saved: 'valid-test-token', valid: true, cached: snapshot,
    pricesResponse: { EURUSD: q }, eventsResponse: new Promise(() => {}) })
  await settle()
  assert.deepEqual(JSON.parse(app.storage.get('retocker.quotes.display.v1')).prices.EURUSD, q)
  assert.equal(vm.runInContext('prices.EURUSD.price', app.context), q.price)
  assert.deepEqual(app.errors, [])
})

for (const cached of ['broken json', JSON.stringify({ version: 1, mock: true, prices: JSON.parse(snapshot).prices })]) {
  test('invalid or incompatible cache is ignored and polling starts', async () => {
    const app = boot({ saved: 'valid-test-token', valid: true, cached, storageFails: true })
    await settle()
    assert.equal(vm.runInContext('Object.keys(prices).length', app.context), 0)
    assert.ok(app.requests.includes('/api/prices'))
    assert.deepEqual(app.errors, [])
  })
}

for (const saved of [null, 'expired-test-token']) {
  test(`code entry is available after the intro (${saved ? 'expired session' : 'no session'})`, async () => {
    const app = boot({ saved })
    await settle()
    assert.equal(app.element('#accessGate').classList.contains('hide'), false)
    assert.notEqual(app.element('#accessCode').focused, true, 'Do not open the keyboard before user action')
    assert.equal(app.element('#splash').classList.contains('out'), true)
    assert.equal(app.requests.includes('/api/prices'), false, 'Protected bootstrap must wait for login')
    assert.equal(app.storage.has('retocker.access.alerts.v3'), false)
    app.element('#accessCode').value = '123456'
    await app.element('#accessForm').onsubmit({ preventDefault() {} })
    assert.equal(app.element('#accessStatus').textContent, 'Invalid or already used code.')
    assert.equal(app.element('#accessGate').classList.contains('hide'), false)
    for (const timer of app.timers) timer.fn()
    assert.deepEqual(app.errors, [])
  })
}

test('successful code entry resumes bootstrap without restoring the splash', async () => {
  const app = boot({ redeemedToken: 'new-test-token' })
  await settle()
  app.element('#accessCode').value = '123456'
  await app.element('#accessForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'), true)
  assert.equal(app.element('#splash').classList.contains('out'), true)
  assert.equal(app.storage.get('retocker.access.alerts.v3'), 'new-test-token')
  assert.ok(app.requests.includes('/api/prices'))
  assert.deepEqual(app.errors, [])
})

test('valid saved session retains the normal intro and skips code entry', async () => {
  const app = boot({ saved: 'valid-test-token', valid: true })
  await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'), true)
  assert.equal(app.element('#splash').removed, false)
  assert.ok(app.requests.includes('/api/prices'))
  assert.deepEqual(app.errors, [])
})

test('expired session during polling opens one gate and resumes without replaying mutations', async () => {
  const app = boot({ saved: 'valid-test-token', valid: true, expirePrices: true, redeemedToken: 'replacement-token' })
  await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'), false)
  assert.equal(app.storage.has('retocker.access.alerts.v3'), false)
  app.element('#accessCode').value = '123456'
  await app.element('#accessForm').onsubmit({ preventDefault() {} }); await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'), true)
  assert.equal(app.storage.get('retocker.access.alerts.v3'), 'replacement-token')
  assert.equal(app.requests.filter(u => u === '/local-access/api/verify-code').length, 1)
  assert.deepEqual(app.errors, [])
})

test('recovery refreshes the active list and reconciles revoked selected symbol without mutation replay', async () => {
  const app=boot({saved:'valid-test-token',valid:true,redeemedToken:'replacement-token'})
  await settle()
  vm.runInContext("sym='XAUUSD'; curTab='alerts'",app.context)
  let listReads=0,mutations=0
  app.setFetch(async(url,o={})=>{
    if(o.method&&o.method!=='GET')mutations++
    if(url==='/api/config')return {ok:true,status:200,json:async()=>({authRequired:true,authApi:'/local-access',symbols:{EURUSD:{digits:5,pip:.0001}}})}
    if(url==='/api/alerts'){listReads++;return {ok:true,status:200,json:async()=>[]}}
    return {ok:true,status:200,json:async()=>url.includes('verify-code')?{token:'replacement-token'}:{}}
  })
  vm.runInContext('recoverAccess()',app.context);await settle()
  app.element('#accessCode').value='123456';await app.element('#accessForm').onsubmit({preventDefault(){}});await settle()
  assert.equal(vm.runInContext('sym',app.context),'EURUSD');assert.equal(listReads,1)
  assert.equal(mutations,1,'Only code redemption, no replay of previous mutation')
  assert.equal(app.element('#accessGate').classList.contains('hide'),true)
})
test('failed configuration refresh reopens login visibly and permits a later successful recovery',async()=>{
  const app=boot({saved:'valid-test-token',valid:true});await settle()
  let configFails=true
  app.setFetch(async url=>({ok:!(url==='/api/config'&&configFails),status:url==='/api/config'&&configFails?503:200,json:async()=>url==='/api/config'?(configFails?{error:'unavailable'}:{authRequired:true,authApi:'/local-access',symbols:{EURUSD:{digits:5,pip:.0001}}}):url.includes('verify-code')?{token:'replacement-token'}:{}}))
  vm.runInContext('recoverAccess()',app.context);await settle()
  app.element('#accessCode').value='123456';await app.element('#accessForm').onsubmit({preventDefault(){}});await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'),false)
  assert.match(app.element('#accessStatus').textContent,/Could not refresh/)
  configFails=false;app.element('#accessCode').value='123456';await app.element('#accessForm').onsubmit({preventDefault(){}});await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'),true)
})
test('missing access configuration is not hidden behind the splash', async () => {
  const app = boot({ authApi: '' })
  await settle()
  assert.equal(app.element('#splash').classList.contains('out'), true)
  assert.equal(app.element('#accessStatus').textContent, 'Access server is not configured.')
  assert.equal(app.requests.includes('/api/prices'), false)
})

test('login waits for intro, but stuck intro has a bounded fallback and no appReady deadlock',async()=>{
 const app=boot({introPending:true});await settle()
 assert.equal(app.element('#accessGate').classList.contains('hide'),true)
 assert.equal(app.element('#splash').classList.contains('out'),false)
 const timeout=app.timers.find(t=>t.ms===15000);assert.ok(timeout);timeout.fn();await settle()
 assert.equal(app.element('#accessGate').classList.contains('hide'),false)
 assert.equal(app.requests.includes('/api/prices'),false)
 assert.deepEqual(app.errors,[])
})


test('one-time UI rollout ignores even valid old saved login, then retains the new login', async () => {
  const app = boot({ legacy: 'old-valid-token', valid: true, cached: snapshot, redeemedToken: 'fresh-after-rollout' })
  await settle()
  assert.equal(app.storage.has('retocker.access.alerts.v1'), false)
  assert.equal(app.storage.has('retocker.access.alerts.v2'), false)
  assert.equal(app.element('#accessGate').classList.contains('hide'), false)
  assert.equal(app.requests.includes('/api/access/check'), false, 'Old login is never submitted to skip the new gate')
  assert.equal(app.requests.includes('/api/prices'), false)
  assert.equal(app.storage.get('retocker.quotes.display.v1'), snapshot, 'Do not clear unrelated storage')
  app.element('#accessCode').value = '123456'
  await app.element('#accessForm').onsubmit({ preventDefault() {} }); await settle()
  assert.equal(app.storage.get('retocker.access.alerts.v3'), 'fresh-after-rollout')
  const reopened = boot({ legacy: 'old-valid-token', saved: app.storage.get('retocker.access.alerts.v3'), valid: true })
  await settle()
  assert.equal(reopened.storage.has('retocker.access.alerts.v1'), false)
  assert.equal(reopened.element('#accessGate').classList.contains('hide'), true, 'A successful new login must not be cleared again')
  assert.ok(reopened.requests.includes('/api/access/check'))
  assert.ok(reopened.requests.includes('/api/prices'))
  assert.deepEqual([...app.errors,...reopened.errors], [])
})


test('successful redemption keeps the gate up until protected bootstrap has rendered', async () => {
  const app = boot({ redeemedToken: 'new-test-token' }); await settle()
  let releaseConfig
  const delayedConfig = new Promise(resolve => { releaseConfig = resolve })
  app.setFetch(async url => ({ ok: true, status: 200, json: async () => {
    if (url.includes('verify-code')) return { token: 'new-test-token' }
    if (url === '/api/config') return delayedConfig
    if (url === '/api/prices') return {}
    if (url.startsWith('/api/events')) return []
    return {}
  } }))
  app.element('#accessCode').value = '123456'
  const entered = app.element('#accessForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'), false)
  assert.equal(app.element('body').classList.contains('ready'), false, 'Entrance must not play behind the gate')
  assert.equal(app.element('#accessStatus').textContent, 'Opening Alerts…')
  releaseConfig({ authRequired: true, authApi: '/local-access', symbols: { EURUSD: { digits: 5, pip: .0001 } } })
  await entered; await settle()
  assert.equal(app.element('#accessGate').classList.contains('hide'), true)
  assert.equal(app.element('body').classList.contains('ready'), true)
  assert.equal(app.element('.wrap').inert, false)
  assert.deepEqual(app.errors, [])
})
