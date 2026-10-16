import fs from 'node:fs'
import crypto from 'node:crypto'
import { defaultH4Settings } from './h4.js'

// Separate from legacy news preferences so old clients cannot erase H4 settings.
// Redis HSET updates one user's preferences atomically; SET NX deduplicates across
// overlapping Render deployments. No in-memory fallback if Redis is unavailable.
export async function createH4Store({ redis = null, file, clock = Date.now }) {
  const hash = 'tg-alerts:{h4}:settings:v1'
  let state = { settings: {}, sent: {} }
  let refreshedAt = 0, revision = 0
  async function refresh(force = false) {
    if (!redis || (!force && clock() - refreshedAt < 30000)) return
    const startedRevision = revision
    const raw = await redis(['HGETALL', hash])
    if (raw && !Array.isArray(raw)) throw new Error('Invalid H4 Redis settings')
    const settings = {}
    for (let i = 0; i < (raw || []).length; i += 2) settings[raw[i]] = JSON.parse(raw[i + 1])
    if (revision !== startedRevision) return
    state.settings = settings
    refreshedAt = clock()
  }
  if (redis) await refresh(true)
  else {
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if (!state.settings || !state.sent) throw new Error('Invalid H4 settings file')
  }
  const persist = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  }
  return {
    refresh,
    all: () => state.settings,
    get: (uid) => state.settings[uid] || { ...defaultH4Settings(), since: clock() },
    async set(uid, settings) {
      const value = { ...settings, since: clock() }
      if (redis) await redis(['HSET', hash, uid, JSON.stringify(value)])
      revision++
      const previous = state.settings[uid]
      state.settings[uid] = value
      if (!redis) try { persist() } catch (e) {
        if (previous) state.settings[uid] = previous
        else delete state.settings[uid]
        throw e
      }
      return value
    },
    async claim(key, now, context) {
      if (redis) {
        const digest = crypto.createHash('sha256').update(key).digest('hex')
        const marker = 'tg-alerts:{h4}:sent:' + digest
        if (context) {
          // A previous Render instance cannot send with preferences changed on
          // the new instance: compare preferences and claim in ONE Redis operation.
          const script = `if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return nil end; return redis.call('SET', KEYS[2], '1', 'NX', 'EX', 172800)`
          return (await redis(['EVAL', script, 2, hash, marker, context.uid, JSON.stringify(context.settings)])) === 'OK'
        }
        return (await redis(['SET', marker, '1', 'NX', 'EX', 172800])) === 'OK'
      }
      if (context && JSON.stringify(state.settings[context.uid]) !== JSON.stringify(context.settings)) return false
      if (state.sent[key]) return false
      state.sent[key] = now
      for (const k of Object.keys(state.sent)) if (now - state.sent[k] > 172800000) delete state.sent[k]
      try { persist() } catch (e) { delete state.sent[key]; throw e }
      return true
    },
  }
}
