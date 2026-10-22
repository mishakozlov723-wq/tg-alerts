export function makeRedis(env) {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token || !url.startsWith('https://')) throw new Error('redis_configuration_missing')
  return async cmd => {
    let r
    try {
      r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error()
      const data = await r.json()
      if (data.error || !Object.hasOwn(data, 'result')) throw new Error()
      return data.result
    } catch { const e = new Error('durable_storage_unavailable'); e.storageFailure = true; throw e }
  }
}
export async function loadLegacy(redis, allowEmpty = false) {
  const raw = await redis(['GET','tg-alerts-db'])
  if (raw === null && !allowEmpty) throw new Error('legacy_database_missing_do_not_start_empty')
  const empty = { alerts: [], settings: {}, events: [], sentNews: {}, seq: 1, owned: {}, orders: {} }
  let db
  try { db = raw === null ? empty : { ...empty, ...JSON.parse(raw) } } catch { throw new Error('legacy_database_invalid') }
  if (!Array.isArray(db.alerts) || !Array.isArray(db.events) || !db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings) || !db.owned || typeof db.owned !== 'object' || !db.orders || !db.sentNews || !Number.isSafeInteger(db.seq) || db.seq < 1) throw new Error('legacy_database_invalid')
  // Do not auto-run resetV3 or any purchase reset on migration.
  return db
}
