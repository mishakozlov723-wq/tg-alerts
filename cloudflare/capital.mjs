// Shared read-only Capital session and DXY instrument discovery. Never places orders.
export const CAPITAL_CHART_SYMBOLS = ['DXY', 'GER40', 'XAUUSD', 'XAGUSD']
export function capitalInstrument(env, symbol) {
  const defaults = { GER40: 'DE40', XAUUSD: 'GOLD', XAGUSD: 'SILVER' }
  return env['CAPITAL_EPIC_' + symbol] || defaults[symbol]
}
const clients = new WeakMap()
export function capitalClient(env) {
  if (clients.has(env)) return clients.get(env)
  const fetcher = env.FETCH || globalThis.fetch
  const base = env.CAPITAL_ENV === 'live' ? 'https://api-capital.backend-capital.com' : 'https://demo-api-capital.backend-capital.com'
  let session, loginAt = 0, loginJob, epicJob, epic = env.CAPITAL_EPIC_DXY || '', retryAt = 0
  async function failure(r, stage, diagnostic) {
    if(diagnostic){
      let code=null
      try{
        const raw=(await r.json())?.errorCode
        const secrets=[env.CAPITAL_API_KEY,env.CAPITAL_IDENTIFIER,env.CAPITAL_PASSWORD,...Object.values(session||{})].filter(v=>typeof v==='string'&&v.length)
        if(typeof raw==='string'&&/^error\.[a-z0-9_.-]{1,100}$/i.test(raw)&&!secrets.some(v=>raw.includes(v)))code=raw
      }catch{}
      diagnostic.stage=stage;diagnostic.httpStatus=r.status;diagnostic.errorCode=code||'http_error'
    }
    return new Error('capital_data_unavailable')
  }
  async function login(diagnostic) {
    if (session && Date.now() - loginAt < 8 * 60000) return session
    if (!loginJob) loginJob = (async () => {
      if (!env.CAPITAL_API_KEY || !env.CAPITAL_IDENTIFIER || !env.CAPITAL_PASSWORD) throw new Error('chart_source_unconfigured')
      if(diagnostic)diagnostic.stage='login'
      const r = await fetcher(base + '/api/v1/session', { method: 'POST', headers: { 'X-CAP-API-KEY': env.CAPITAL_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ identifier: env.CAPITAL_IDENTIFIER, password: env.CAPITAL_PASSWORD, encryptedPassword: false }), signal: AbortSignal.timeout(8000) })
      if(diagnostic)diagnostic.httpStatus=r.status
      if (!r.ok) throw await failure(r,'login',diagnostic)
      const CST = r.headers.get('cst'), token = r.headers.get('x-security-token')
      if (!CST || !token){if(diagnostic)diagnostic.errorCode='session_headers_missing';throw new Error('capital_session_unavailable')}
      loginAt = Date.now(); session = { CST, 'X-SECURITY-TOKEN': token }; return session
    })().finally(() => { loginJob = null })
    return loginJob
  }
  async function get(path, diagnostic) {
    const headers = await login(diagnostic)
    if(diagnostic){diagnostic.stage='markets';diagnostic.httpStatus=null}
    const r = await fetcher(base + '/api/v1' + path, { headers, signal: AbortSignal.timeout(8000), redirect: 'manual' })
    if(diagnostic)diagnostic.httpStatus=r.status
    if (r.status === 401) session = null
    if (!r.ok) throw await failure(r,'markets',diagnostic)
    if(diagnostic)diagnostic.stage='decode_markets'
    return r.json()
  }
  async function dxyEpic() {
    if (epic) return epic
    if (Date.now() < retryAt) throw new Error('capital_dxy_unavailable')
    if (!epicJob) epicJob = (async () => {
      const data = await get('/markets?searchTerm=Dollar%20Index')
      // Refuse ambiguous or unrelated dollar indices rather than guessing a price source.
      const matches = (data.markets || []).filter(m => /^(?:US )?Dollar Index$/i.test(m.instrumentName || '') && typeof m.epic === 'string')
      if (matches.length !== 1) throw new Error('capital_dxy_unavailable')
      epic = matches[0].epic; return epic
    })().catch(e => { retryAt = Date.now() + 60000; throw e }).finally(() => { epicJob = null })
    return epicJob
  }
  const client = { get, dxyEpic }; clients.set(env, client); return client
}
export function capitalTime(raw) {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(raw) ? Date.parse(raw.endsWith('Z') ? raw : raw + 'Z') : NaN
}
