import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nextH4Boundary, candleSnapshot, createOandaH4, normalizeH4Settings, defaultH4Settings, dueH4Notifications, h4Message, createH4Runner, createH4StatusBoard } from '../h4.js'
import { createH4Store } from '../h4-store.js'
const ms = Date.parse
const iso = (n) => new Date(n).toISOString()
const raw = (time, complete = false) => ({ time, complete, volume: 10 })
const cases = [
  ['2026-01-12T14:00Z', '2026-01-12T18:00:00.000Z'],
  ['2026-03-06T14:00Z', '2026-03-06T18:00:00.000Z'],
  ['2026-03-09T13:00Z', '2026-03-09T17:00:00.000Z'],
  ['2026-03-23T13:00Z', '2026-03-23T17:00:00.000Z'], // US summer, Europe winter
  ['2026-06-15T13:00Z', '2026-06-15T17:00:00.000Z'],
  ['2026-10-26T13:00Z', '2026-10-26T17:00:00.000Z'], // Europe winter, US summer
  ['2026-11-02T14:00Z', '2026-11-02T18:00:00.000Z'],
  ['2026-12-31T22:00Z', '2027-01-01T02:00:00.000Z'],
  ['2026-03-08T06:00Z', '2026-03-08T09:00:00.000Z'], // DST jump: no assumed 4 UTC hours
  ['2026-06-14T21:05Z', '2026-06-15T01:00:00.000Z'], // truncated opening candle
]
for (const [start, close] of cases) test('NY alignment ' + start, () => assert.equal(iso(nextH4Boundary(ms(start))), close))
test('all monthly weekday grids 2024–2035 stay aligned to broker-local 01/05/09/13/17/21', () => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  for (let year = 2024; year <= 2035; year++) for (let month = 0; month < 12; month++) for (let h = 0; h < 24; h++) {
    const start = Date.UTC(year, month, 15, h, 17)
    const close = nextH4Boundary(start)
    assert(close > start && close - start <= 5 * 3600000)
    const p = Object.fromEntries(fmt.formatToParts(close).map((v) => [v.type, v.value]))
    assert([1,5,9,13,17,21].includes(+p.hour)); assert.equal(+p.minute, 0)
  }
})
test('H4 preferences validate types, enums, no empty enabled setup', () => {
  assert.deepEqual(normalizeH4Settings(defaultH4Settings()), defaultH4Settings())
  for (const patch of [{ enabled: 'true' }, { symbols: ['__proto__'] }, { lead: [0] }, { lead: ['5'] }, { enabled: true, symbols: [] }, { enabled: true, lead: [], atClose: false }]) assert.throws(() => normalizeH4Settings({ ...defaultH4Settings(), ...patch }))
  assert.deepEqual(normalizeH4Settings({ ...defaultH4Settings(), lead: [5,10,5] }).lead, [10,5])
})
test('only real incomplete candle is active; no Friday candle extended through weekend', () => {
  const rows = [raw('2026-03-06T18:00Z')]
  assert(candleSnapshot(rows, ms('2026-03-06T21:55Z')).active)
  assert.equal(candleSnapshot(rows, ms('2026-03-07T10:00Z')).active, null)
  assert.equal(candleSnapshot(rows, ms('2026-03-08T20:55Z')).active, null)
})
test('zero volume, invalid time and future candles cannot start a timer', () => {
  assert.equal(candleSnapshot([{...raw('2026-06-15T13:00Z'), volume:0}, raw('bad'), raw('2026-06-16T13:00Z')], ms('2026-06-15T16:55Z')).active, null)
})
test('completion is authoritative, not the timer; Friday close does not require a next candle', () => {
  const now = ms('2026-03-06T22:00:10Z')
  assert.equal(candleSnapshot([raw('2026-03-06T18:00Z')], now).closed.length, 0)
  assert.equal(candleSnapshot([raw('2026-03-06T18:00Z', true)], now).closed.length, 1)
  assert.equal(candleSnapshot([raw('2026-03-06T18:00Z', true)], now + 180000).closed.length, 0)
})
const start = ms('2026-06-15T13:00Z'), close = ms('2026-06-15T17:00Z')
const prefs = { ...defaultH4Settings(), enabled:true, lead:[10,5], since: start }
const live = { EURUSD: { status:'live', active:{start,close}, closed:[] } }
test('10 and 5 minute reminders fire separately only within their windows', () => {
  assert.equal(dueH4Notifications(prefs, live, close-11*60000).length, 0)
  assert.equal(dueH4Notifications(prefs, live, close-10*60000)[0].lead, 10)
  assert.equal(dueH4Notifications(prefs, live, close-5*60000)[0].lead, 5)
  assert.equal(dueH4Notifications(prefs, live, close-4*60000).length, 0)
  assert.equal(dueH4Notifications(prefs, live, close).length, 0)
})
test('enabling or waking late never backfills stale pre-close reminders', () => {
  assert.equal(dueH4Notifications({...prefs,since:close-4*60000}, live, close-4*60000).length, 0)
  assert.equal(dueH4Notifications({...prefs,since:close-4.5*60000}, live, close-4.5*60000).length, 0)
  assert.equal(dueH4Notifications({...prefs,enabled:false}, live, close-5*60000).length, 0)
})
test('close delivery bounded and per-asset; atClose can be disabled', () => {
  const states = { EURUSD:{status:'waiting',closed:[{start,close}]} }
  assert.equal(dueH4Notifications(prefs, states, close+10000).length, 1)
  assert.equal(dueH4Notifications({...prefs,atClose:false}, states, close+10000).length, 0)
  assert.equal(dueH4Notifications(prefs, states, close+120000).length, 0)
  assert.equal(dueH4Notifications({...prefs,symbols:['GBPUSD']}, states, close+10000).length, 0)
})
function fixture({ tradeable = true, fail = false, token = 'test', mode = 'oanda' } = {}) {
  let now = close-5*60000, requests = []
  const source = createOandaH4({ env: { OANDA_TOKEN:token, PRICE_SOURCE:mode, OANDA_ENV:'practice' }, clock:()=>now, onError:()=>{}, fetcher: async (url, options) => {
    requests.push(url)
    assert.equal(options.headers.authorization, 'Bearer test')
    if (fail) return {ok:false,status:503}
    let result
    if (url.endsWith('/accounts')) result = { accounts:[{id:'test-account'}] }
    else if (url.includes('/pricing?')) result = {prices:[{instrument:new URL(url).searchParams.get('instruments'),tradeable}]}
    else {
      const u = new URL(url)
      assert.equal(u.searchParams.get('granularity'),'H4'); assert.equal(u.searchParams.get('dailyAlignment'),'17'); assert.equal(u.searchParams.get('alignmentTimezone'),'America/New_York')
      result = {instrument:decodeURIComponent(u.pathname.split('/')[3]),granularity:'H4',candles:[raw('2026-06-15T13:00Z', now>=close)]}
    }
    return {ok:true,json:async()=>result}
  } })
  return {source, requests, setTime:(v)=>{now=v}}
}
test('real candle API plus market status, removed DXY makes no extra request, cached across users', async () => {
  const f = fixture()
  const result = await f.source.get(['EURUSD','DXY'])
  assert.equal(result.EURUSD.status,'live'); assert.equal(result.DXY,undefined)
  assert.equal(result.EURUSD.active.close,close)
  assert.equal(f.requests.length,3)
  await f.source.get(['EURUSD']); assert.equal(f.requests.length,3)
  f.setTime(close+1000)
  const next = await f.source.get(['EURUSD']); assert.equal(next.EURUSD.closed.length,1)
})
test('broker reports holiday/session break: no pre-close reminders', async () => {
  const result = await fixture({tradeable:false}).source.get(['GER40'])
  assert.equal(result.GER40.status,'waiting'); assert.equal(result.GER40.active,null)
})
test('network failure disables H4 rather than using stale or other broker candles', async () => {
  const result = await fixture({fail:true}).source.get(['EURUSD'])
  assert.equal(result.EURUSD.status,'unavailable'); assert.equal(result.EURUSD.active,null)
})
test('no token or mock mode means unconfigured, never fabricated live candles', async () => {
  for (const f of [fixture({token:''}),fixture({mode:'mock'})]) {
    assert.equal((await f.source.get(['EURUSD'])).EURUSD.status,'unconfigured'); assert.equal(f.requests.length,0)
  }
})
test('legacy DXY preferences never produce H4 reminders', () => {
  const s = {...prefs,symbols:['DXY','EURUSD']}
  assert.deepEqual(dueH4Notifications(s,{...live,DXY:live.EURUSD},close-5*60000).map((e)=>e.symbol),['EURUSD'])
  assert.throws(()=>normalizeH4Settings({...defaultH4Settings(),symbols:['DXY']}))
  assert.match(h4Message({symbol:'EURUSD',close,lead:5}),/17:00 UTC/)
})
test('local settings and dedup survive restart; settings isolated between users', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'h4-')); const file=path.join(dir,'h4.json')
  try {
    const s=await createH4Store({file,clock:()=>start})
    await s.set('1',prefs); assert.equal(s.get('2').enabled,false)
    assert.equal(await s.claim('one',start),true); assert.equal(await s.claim('one',start),false)
    const restarted=await createH4Store({file,clock:()=>start+1})
    assert.equal(restarted.get('1').enabled,true); assert.equal(await restarted.claim('one',start+1),false)
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})
test('storage write errors are not reported as saved or sent', async () => {
  const s=await createH4Store({file:'/nonexistent-h4-test/invalid.json'})
  await assert.rejects(s.set('1',prefs)); assert.equal(s.get('1').enabled,false)
  await assert.rejects(s.claim('event',start))
})
test('Redis uses HSET per user and SET NX EX to deduplicate across instances', async () => {
  const hash=new Map(), markers=new Set(), commands=[]
  const redis=async(cmd)=>{ commands.push(cmd); const [op,k,...args]=cmd
    if(op==='HGETALL') return [...hash].flat()
    if(op==='HSET') {hash.set(args[0],args[1]);return 1}
    if(op==='SET') {if(markers.has(k)) return null; markers.add(k);return 'OK'}
  }
  const a=await createH4Store({redis,clock:()=>start})
  await a.set('1',prefs)
  const b=await createH4Store({redis,clock:()=>start})
  assert.equal(b.get('1').enabled,true)
  assert.equal(await a.claim('x',start),true); assert.equal(await b.claim('x',start),false)
  assert(commands.some((c)=>c[0]==='SET' && c.includes('NX') && c.includes('EX')))
})
test('runner is non-overlapping, deduplicates repeats, and respects revoked quote access', async () => {
  let sends=0, access=true; const sent=new Set()
  const run=createH4Runner({getSettings:()=>({'1':prefs}),source:{get:async()=>live},allowed:()=>access,clock:()=>close-5*60000,
    claim:async(k)=>{if(sent.has(k))return false;sent.add(k);return true}, deliver:async()=>{sends++}})
  await Promise.all([run(),run()]); await run(); assert.equal(sends,1)
  access=false; await run(); assert.equal(sends,1)
})
test('disabling while candle API is in flight prevents notification', async () => {
  let resolve,sends=0,current=prefs
  const run=createH4Runner({getSettings:()=>({'1':current}),source:{get:()=>new Promise((r)=>resolve=r)},allowed:()=>true,clock:()=>close-5*60000,claim:async()=>true,deliver:async()=>sends++})
  const job=run();current={...prefs,enabled:false};resolve(live);await job;assert.equal(sends,0)
})
test('ambiguous Telegram send is not blindly retried', async () => {
  let sends=0;const sent=new Set()
  const run=createH4Runner({getSettings:()=>({'1':prefs}),source:{get:async()=>live},allowed:()=>true,clock:()=>close-5*60000,
    claim:async(k)=>{if(sent.has(k))return false;sent.add(k);return true},deliver:async()=>{sends++;throw new Error('timeout')},onError:()=>{}})
  await run();await run();assert.equal(sends,1)
})
test('recovery after OANDA outage requires a new successful snapshot', async()=>{
  let now=close-5*60000, failing=false
  const source=createOandaH4({env:{PRICE_SOURCE:'oanda',OANDA_TOKEN:'fixture',OANDA_ACCOUNT:'test'},clock:()=>now,onError:()=>{},fetcher:async(url)=>{
    if(failing)throw new Error('network')
    return {ok:true,json:async()=>url.includes('/pricing?')?{prices:[{instrument:'EUR_USD',tradeable:true}]}:{instrument:'EUR_USD',granularity:'H4',candles:[raw('2026-06-15T13:00Z')]}}
  }})
  assert.equal((await source.get(['EURUSD'])).EURUSD.status,'live')
  failing=true;now+=31000;assert.equal((await source.get(['EURUSD'])).EURUSD.status,'unavailable')
  failing=false;now+=31000;assert.equal((await source.get(['EURUSD'])).EURUSD.status,'live')
})
test('instrument overrides apply to OANDA candles and market state, never Capital.com',async()=>{
  const urls=[]
  const source=createOandaH4({env:{PRICE_SOURCE:'oanda',OANDA_TOKEN:'fixture',OANDA_ACCOUNT:'test',OANDA_GER40:'CUSTOM_DE'},onError:()=>{},clock:()=>close-60000,fetcher:async(url)=>{
    urls.push(url);return {ok:true,json:async()=>url.includes('/pricing?')?{prices:[{instrument:'CUSTOM_DE',tradeable:true}]}:{instrument:'CUSTOM_DE',granularity:'H4',candles:[raw('2026-06-15T13:00Z')]}}
  }})
  assert.equal((await source.get(['GER40'])).GER40.status,'live');assert(urls.every((u)=>u.includes('CUSTOM_DE')))
})
test('Redis read errors do not silently use empty or local settings',async()=>{
  await assert.rejects(createH4Store({redis:async()=>{throw new Error('redis offline')},file:'/tmp/should-not-write-h4'}))
})
test('failed durable claim blocks sends, without starving another user',async()=>{
  const delivered=[]
  const run=createH4Runner({getSettings:()=>({'1':prefs,'2':prefs}),source:{get:async()=>live},allowed:()=>true,clock:()=>close-5*60000,claim:async(k)=>{if(k.startsWith('1|'))throw new Error('storage offline');return true},deliver:async(uid)=>delivered.push(uid),onError:()=>{}})
  await run();assert.deepEqual(delivered,['2'])
})
test('one failed Telegram recipient does not block other recipients',async()=>{
  const delivered=[]
  const run=createH4Runner({getSettings:()=>({'1':prefs,'2':prefs}),source:{get:async()=>live},allowed:()=>true,clock:()=>close-5*60000,claim:async()=>true,deliver:async(uid)=>{if(uid==='1')throw new Error('403');delivered.push(uid)},onError:()=>{}})
  await run();assert.deepEqual(delivered,['2'])
})
test('delivery claims atomically check current Redis preferences before deduplication', async()=>{
  let value, lastCommand
  const redis=async(cmd)=>{
    if(cmd[0]==='HGETALL')return value?['1',value]:[]
    if(cmd[0]==='HSET'){value=cmd[3];return 1}
    if(cmd[0]==='EVAL'){lastCommand=cmd;return cmd[6]===value?'OK':null}
  }
  const store=await createH4Store({redis,clock:()=>start})
  const saved=await store.set('1',prefs)
  assert.equal(await store.claim('event1',start,{uid:'1',settings:saved}),true)
  assert.equal(lastCommand[2],2);assert.match(lastCommand[1],/HGET/);assert.match(lastCommand[1],/NX/)
  value=JSON.stringify({...saved,enabled:false}) // another instance disabled reminders
  assert.equal(await store.claim('event2',start,{uid:'1',settings:saved}),false)
})
test('H4 monitor states merge per symbol and expire when no longer requested', () => {
  let now = 1000
  const board = createH4StatusBoard({ ttlMs: 600000, clock: () => now })
  board.record({ GBPUSD: { status: 'live' }, XAUUSD: { status: 'unavailable' } })
  // A user's status page for one symbol must not hide the runner's other results.
  now += 1000; board.record({ GBPUSD: { status: 'waiting' } })
  assert.deepEqual(board.current(), { GBPUSD: 'waiting', XAUUSD: 'unavailable' })
  now += 600000
  assert.deepEqual(board.current(), { GBPUSD: 'waiting' }, 'A symbol nobody asked about for 10 minutes drops out')
  now += 1
  assert.deepEqual(board.current(), {})
})
