import crypto from 'node:crypto'

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
    return payload
  } catch { return null }
}
