import fs from 'node:fs'
import crypto from 'node:crypto'
// A separate hash: legacy price/news/H4 writes cannot erase personal reminders.
// CAS covers create/edit/delete AND each delivery claim across concurrent callers.
const HASH = 'tg-alerts:{live}:reminders:v1'
export const LIVE_LIMIT = 100
export class LiveConflict extends Error { constructor() { super('Reminder changed. Reload and try again.'); this.status = 409 } }
export async function createLiveStore({ redis = null, file }) {
  let records = Object.create(null), revision = 0
  let invalid = new Set()
  const validZones = new Set()
  const parse = (raw) => {
    const value = JSON.parse(raw)
    if (!value || typeof value.id !== 'string' || typeof value.userId !== 'string' || !Array.isArray(value.deliveries)
      || typeof value.enabled !== 'boolean' || typeof value.revision !== 'string'
      || !value.config || typeof value.config.text !== 'string' || typeof value.config.timezone !== 'string'
      || !value.deliveries.every(d => d && Number.isFinite(d.at) && ['pending','attempting','sent','failed','unknown','missed','cancelled'].includes(d.status)
        && (d.status !== 'attempting' || typeof d.attempt === 'string' && Number.isFinite(d.attemptedAt)))) throw new Error('Invalid Live storage')
    if (!validZones.has(value.config.timezone)) { new Intl.DateTimeFormat('en', { timeZone: value.config.timezone }); validZones.add(value.config.timezone) }
    return value
  }
  function validRecord(key, raw) {
    try {
      const row = parse(raw)
      if (key !== `${row.userId}|${row.id}`) throw new Error('Invalid Live key')
      invalid.delete(key)
      return row
    } catch {
      invalid.add(key)
      return null
    }
  }
  const validRows = () => Object.entries(records).map(([key, raw]) => validRecord(key, raw)).filter(Boolean)
  async function refresh() {
    if (!redis) return
    const before = revision, raw = await redis(['HGETALL', HASH]), next = Object.create(null)
    if (!Array.isArray(raw) || raw.length % 2) throw new Error('Invalid Live Redis response')
    for (let i = 0; i < raw.length; i += 2) { next[raw[i]] = raw[i + 1] }
    if (before === revision) { records = next; invalid = new Set(); validRows() }
  }
  if (redis) await refresh()
  else {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Live file')
      for (const [k, v] of Object.entries(raw)) { records[k] = v; validRecord(k, v) }
    } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  const field = (uid, id) => `${uid}|${id}`
  async function read(uid, id) {
    const k = field(uid, id)
    if (redis) {
      const raw = await redis(['HGET', HASH, k])
      revision++
      if (raw !== null && raw !== undefined) { records[k] = raw } else { delete records[k]; invalid.delete(k) }
    }
    return Object.hasOwn(records, k) ? validRecord(k, records[k]) : null
  }
  async function cas(uid, id, expected, value, isCreate = false) {
    const k = field(uid, id), old = expected ? JSON.stringify(expected) : '', next = value ? JSON.stringify(value) : ''
    if (redis) {
      // Limit checked in the same atomic operation as creation; no races at cap.
      const script = `local old=redis.call('HGET',KEYS[1],ARGV[1]) or ''; if old~=ARGV[2] then return 0 end; if ARGV[5]=='1' then local n=0; for _,k in ipairs(redis.call('HKEYS',KEYS[1])) do if string.sub(k,1,string.len(ARGV[4]))==ARGV[4] then n=n+1 end end; if n>=100 then return -1 end end; if ARGV[3]=='' then redis.call('HDEL',KEYS[1],ARGV[1]) else redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]) end; return 1`
      const result = await redis(['EVAL', script, 1, HASH, k, old, next, `${uid}|`, isCreate ? '1' : '0'])
      if (result === -1) { const e = new Error('Live limit reached (100). Delete an old reminder.'); e.status = 400; throw e }
      if (result !== 1) throw new LiveConflict()
    } else {
      if ((records[k] || '') !== old) throw new LiveConflict()
      if (isCreate && validRows().filter((r) => r.userId === uid).length >= LIVE_LIMIT) { const e = new Error('Live limit reached (100). Delete an old reminder.'); e.status = 400; throw e }
      const updated = { ...records }
      if (next) updated[k] = next; else delete updated[k]
      fs.writeFileSync(file + '.tmp', JSON.stringify(updated), { mode: 0o600 })
      fs.renameSync(file + '.tmp', file)
    }
    revision++
    if (next) records[k] = next; else delete records[k]
    invalid.delete(k)
    return value
  }
  return {
    refresh, read, cas,
    all: validRows,
    list: (uid) => validRows().filter((r) => r.userId === uid),
    diagnostics: () => ({ invalidRecords: invalid.size }),
  }
}
