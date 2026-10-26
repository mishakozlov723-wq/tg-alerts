import crypto from 'node:crypto'

// One-time server-side reset. Keep this fixed across deploys; new sessions still last 96h.
export const ALERTS_SESSION_NOT_BEFORE = Date.parse('2026-10-26T20:05:40Z')

const b64 = (value) => Buffer.from(value, 'base64url').toString('utf8')
const safeEqual = (a, b) => { try { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) } catch { return false } }

export function verifyAccessToken(token, project, secret) {
  if (!token || !project || !secret) return null
  const [body, signature, extra] = String(token).split('.')
  if (!body || !signature || extra) return null
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  if (!safeEqual(expected, signature)) return null
  try {
    const payload = JSON.parse(b64(body))
    if (payload.project !== project || !payload.sub || Number(payload.exp) <= Date.now()) return null
    if (project === 'alerts' && (!Number.isFinite(payload.iat) || payload.iat < ALERTS_SESSION_NOT_BEFORE)) return null
    return payload
  } catch { return null }
}
