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
