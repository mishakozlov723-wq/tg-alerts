// Local UI fixture only: no Telegram, Access or OANDA requests and no real tokens.
// Run: node test/access-gate-preview.mjs
import http from 'node:http'
import { readFile } from 'node:fs/promises'
const root = new URL('../public/', import.meta.url)
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  res.setHeader('cache-control', 'no-store')
  if (url.pathname === '/api/config') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ authRequired: true, authApi: '/fixture-access' }))
  }
  if (url.pathname === '/api/access/check' || url.pathname === '/api/access/redeem') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ ok: false, error: 'invalid_code' }))
  }
  const files = { '/': 'index.html', '/intro.js': 'intro.js', '/h4-settings.js': 'h4-settings.js', '/live-reminders.js': 'live-reminders.js', '/live-time.js': 'live-time.js', '/price-chart.css': 'price-chart.css', '/price-chart.js': 'price-chart.js', '/lightweight-charts-5.0.9.js': 'lightweight-charts-5.0.9.js' }
  if (!files[url.pathname]) { res.writeHead(404); return res.end() }
  try {
    let body = await readFile(new URL(files[url.pathname], root), 'utf8')
    if (url.pathname === '/') {
      // Remove external resources only in this isolated fixture, not in the application.
      body = body.replace(/<link[^>]*https:\/\/[^>]*>/g, '').replace(/<script src="https:\/\/[^>]*><\/script>/g, '')
    }
    res.setHeader('content-type', url.pathname === '/' ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript')
    res.end(body)
  } catch { res.writeHead(500); res.end('Fixture asset unavailable') }
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`))
