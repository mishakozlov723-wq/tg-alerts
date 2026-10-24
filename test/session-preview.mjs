// Isolated expiry/re-login acceptance fixture. No live Telegram/Access/OANDA.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
const root = new URL('../public/', import.meta.url)
let expired = false, rejectNote = false
let alerts = [{id:1,symbol:'EURUSD',dir:'reach',level:1.4,status:'active',note:'Demo note'}, {id:2,symbol:'GBPUSD',dir:'reach',level:1.5,status:'active',note:'Second demo'}]
const symbols = { EURUSD: { pip: .0001, digits: 5 }, GBPUSD: { pip: .0001, digits: 5 } }
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
  if (path === '/fixture/expire') { expired = true; return json({ ok: true }) }
  if (path === '/fixture/reject-note') { rejectNote = !rejectNote; return json({ ok: true, rejectNote }) }
  if (path === '/fixture-access/api/verify-code') {
    const chunks = []; for await (const c of req) chunks.push(c)
    if (JSON.parse(Buffer.concat(chunks)).code !== '123456') return json({ error: 'invalid_code' }, 401)
    expired = false; return json({ token: 'fixture-session' })
  }
  if (path === '/api/config') return json({ authRequired: true, authApi: '/fixture-access', symbols })
  if (path.startsWith('/api/')) {
    if (expired) return json({ error: 'auth' }, 401)
    if (path === '/api/access/check') return json({ ok: true })
    if (path === '/api/prices') return json(Object.fromEntries(Object.keys(symbols).map(s => [s, { price: 1.3, dataTs: Date.now(), observedAt: Date.now(), tradeable: true }])))
    if (path === '/api/chart/candles') return json({ candles: [], hasMore: false, stale: true })
    if (path === '/api/alerts') return json(alerts)
    if (/^\/api\/alerts\/\d+$/.test(path) && req.method === 'PATCH') {
      if (rejectNote) return json({error:'fixture_save_rejected'},409)
      const chunks=[];for await(const c of req)chunks.push(c)
      const row=alerts.find(a=>String(a.id)===path.split('/').at(-1));Object.assign(row,JSON.parse(Buffer.concat(chunks)));return json(row)
    }
    if (path === '/api/events') return json([])
    if (path === '/api/settings') return json({})
    return json({ error: 'fixture_route' }, 404)
  }
  const name = path === '/' ? 'index.html' : path.slice(1)
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) { res.writeHead(404); return res.end() }
  try {
    let body = await readFile(new URL(name, root))
    if (name === 'index.html') body = Buffer.from(body.toString()
      .replace(/<link[^>]*https:\/\/[^>]*>/g, '').replace(/<script src="https:\/\/[^>]*><\/script>/g, '')
      .replace('<body>', `<body><aside>Локальный стенд · код 123456 <button onclick="fetch('/fixture/expire').then(()=>tick()).catch(()=>{})">Истечь сессию</button><button onclick="loadAlerts()">Обновить список</button><button onclick="fetch('/fixture/reject-note')">Сбой заметки</button></aside><script>${new URL(req.url, 'http://local').searchParams.has('login') ? "localStorage.removeItem('retocker.access.alerts.v1')" : "localStorage.setItem('retocker.access.alerts.v1','fixture-session')"}</script>`))
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body)
  } catch { res.writeHead(404); res.end() }
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`))
