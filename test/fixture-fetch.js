// Loaded ONLY by the isolated subprocess integration test. Never imported by app.
import fs from 'node:fs'
const time = Date.parse('2026-06-15T16:55:00Z')
Date.now = () => time
const response = (data) => ({ ok:true, status:200, json:async()=>data })
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url)
  if (u.hostname === 'api-fxpractice.oanda.com') {
    if (u.pathname === '/v3/accounts') return response({accounts:[{id:'fixture-account'}]})
    if (u.pathname.endsWith('/instruments')) return response({instruments:[{name:'XAU_USD'},{name:'DE30_EUR'}]})
    if (u.pathname.endsWith('/pricing')) return response({prices:u.searchParams.get('instruments').split(',').map((instrument)=>({instrument,tradeable:true,bids:[{price:'1.1'}],asks:[{price:'1.2'}],time:String(time/1000)}))})
    if (u.pathname.endsWith('/candles')) return response({instrument:decodeURIComponent(u.pathname.split('/')[3]),granularity:'H4',candles:[{time:'2026-06-15T13:00:00Z',complete:false,volume:123}]})
  }
  if (u.hostname === 'telegram.test.invalid') {
    const payload=JSON.parse(options.body)
    fs.appendFileSync(process.env.H4_TEST_DELIVERIES,JSON.stringify(payload)+'\n')
    return response({ok:true,result:{message_id:1}})
  }
  throw new Error('Unexpected external request blocked by H4 fixture')
}
