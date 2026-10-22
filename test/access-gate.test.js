import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1]

function boot({ saved = null, valid = false, authApi = '/local-access', redeemedToken = null } = {}) {
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(id === '#accessGate' ? ['hide'] : [])
      elements.set(id, {
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
        dataset: {}, style: { setProperty() {} }, value: '', textContent: '', removed: false,
        focus() { this.focused = true }, remove() { this.removed = true },
        addEventListener() {}, querySelectorAll: () => [],
      })
    }
    return elements.get(id)
  }
  const storage = new Map(saved ? [['retocker.access.alerts.v1', saved]] : [])
  const timers = [], requests = [], listeners = new Map(), errors = []
  const window = {
    playIntro: () => new Promise(() => {}), // Intro never finishes: login must still be usable.
    addEventListener: (name, cb) => listeners.set(name, cb),
    dispatchEvent: (event) => listeners.get(event.type)?.(),
  }
  const context = vm.createContext({
    window, Event, console: { error: (e) => errors.push(e) }, performance: { now: () => 0 },
    document: { querySelector: (id) => id === '#splash' && element(id).removed ? null : element(id), querySelectorAll: () => [], getElementById: (id) => element('#' + id), addEventListener() {}, body: element('body') },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }) }, setInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
    fetch: async (url) => {
      requests.push(url)
      const responses = {
        '/api/config': { authRequired: true, authApi, symbols: { EURUSD: { digits: 5, pip: .0001 } } },
        '/api/access/check': { ok: valid }, '/api/prices': {}, '/api/events?since=0': [], '/api/settings': {},
        '/local-access/api/verify-code': redeemedToken ? { token: redeemedToken } : { error: 'invalid_code' },
      }
      assert.ok(url in responses, 'Unexpected request: ' + url)
      return { json: async () => responses[url] }
    },
  })
  vm.runInContext(script, context)
  return { element, storage, timers, requests, errors }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

for (const saved of [null, 'expired-test-token']) {
  test(`code entry is available without advancing timers (${saved ? 'expired session' : 'no session'})`, async () => {
    const app = boot({ saved })
    await settle()
    assert.equal(app.element('#accessGate').classList.contains('hide'), false)
    assert.equal(app.element('#accessCode').focused, true)
    assert.equal(app.element('#splash').removed, true)
    assert.equal(app.requests.includes('/api/prices'), false, 'Protected bootstrap must wait for login')
    assert.equal(app.storage.has('retocker.access.alerts.v1'), false)
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
  assert.equal(app.element('#splash').removed, true)
  assert.equal(app.storage.get('retocker.access.alerts.v1'), 'new-test-token')
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

test('missing access configuration is not hidden behind the splash', async () => {
  const app = boot({ authApi: '' })
  await settle()
  assert.equal(app.element('#splash').removed, true)
  assert.equal(app.element('#accessStatus').textContent, 'Access server is not configured.')
  assert.equal(app.requests.includes('/api/prices'), false)
})
