// Telegram has no idempotency key for outgoing messages. Persist the claim
// before running a command; never blindly replay an interrupted/unknown outcome.
// The caller serializes webhook processing. Initialization failures before the
// claim remain retryable; users can explicitly resend a command after a failure.
export async function processUpdateOnce({ storage, update, prepare, clock = Date.now }) {
  const key = 'update:' + update.update_id
  if (await storage.get(key)) return { duplicate: true }
  const run = await prepare()
  await storage.put(key, { status: 'processing', at: clock() })
  try {
    await run(update)
    await storage.put(key, { status: 'done', at: clock() })
  } catch (error) {
    // If this checkpoint also fails, the committed processing claim still stops
    // a repeat after restart. Never delete it: Telegram may have accepted a send.
    try { await storage.put(key, { status: 'unknown', at: clock() }) } catch {}
    throw error
  }
  return { duplicate: false }
}

// Hourly cleanup of old update claims. Pages through every key instead of only
// the first 5000, and deletes in batches of 128 (the documented per-call limit).
export async function pruneUpdates(storage, { now = Date.now(), maxAgeMs = 7 * 86400000, pageSize = 1000 } = {}) {
  let startAfter, removed = 0
  for (;;) {
    const page = await storage.list({ prefix: 'update:', limit: pageSize, ...(startAfter ? { startAfter } : {}) })
    const keys = [...page.keys()]
    const expired = [...page].filter(([, v]) => now - v?.at > maxAgeMs).map(([k]) => k)
    for (let i = 0; i < expired.length; i += 128) await storage.delete(expired.slice(i, i + 128))
    removed += expired.length
    if (keys.length < pageSize) return removed
    startAfter = keys.at(-1)
  }
}
